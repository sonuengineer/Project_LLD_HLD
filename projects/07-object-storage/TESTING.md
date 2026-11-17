# Testing -- Object Storage

```bash
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p07_object_store_test upgrade head
MSYS_NO_PATHCONV=1 docker run -d --name objstore-seaweed -p 127.0.0.1:58333:8333 chrislusf/seaweedfs:4.48 server -s3 -dir=/data   # optional
../../.venv/Scripts/python -m pytest -q          # 28 tests (2 need the S3 endpoint)
../../.venv/Scripts/python bench/throughput.py both
```

| File | Count | Covers |
|---|---|---|
| `test_objects.py` | 16 | round trip + metadata + ETag, digest rejection, signed body swap, auth failures, hostile keys, ranges + 304, versioning + markers + restore, unversioned overwrite, listing (delimiter, pagination, LIKE escaping), multipart (+ retry, ordering, composite ETag), min part size + abort, presigned GET/PUT/expiry/tamper, ACL/public/grants, quota with versions, 20 concurrent writers, bucket rules |
| `test_maintenance.py` | 5 | lifecycle (current, noncurrent, lone markers, idempotency), abort stale multipart, GC queued + orphans, GC grace period, admin stats |
| `test_s3_adapter.py` | 2 | full flow on the S3 adapter against SeaweedFS, 20MB streaming upload through boto3 multipart |

## Bugs found by tests (fixed)

1. `sum(bigint)` returns NUMERIC -> `Decimal` broke JSON error responses; cast to int.
2. Keys like `../../etc/passwd`: the HTTP client normalised dot segments before sending, so the request hit
   a different URL. Fixed in the client's key encoding (`.`/`..` segments -> `%2E`).

## Review fixes (found while writing the interview bank; `test_review_fixes.py`)

| Finding | Fix |
|---|---|
| Presign max expiry only checked in `/presign`; URLs minted offline could last years | enforced again when the URL is used |
| Concurrent part uploads could all pass the quota check | bucket lock for quota'd buckets on part upload |
| Completion quota check ran after the cascade delete and subtracted parts twice (never failed) | check before deleting the upload, net = final - parts |
| GC deleted queued blobs immediately: a slow GET of an overwritten object could break mid-stream | `deletion_grace_seconds` (default 300) |
| `GET .../multipart/{id}` didn't check the upload belongs to the bucket | scoped to the bucket |
| No way to revoke access keys | `DELETE /admin/access-keys/{id}` (+ local cache eviction) |
| One failing blob delete aborted the whole GC run | per-blob error handling, retried next run |
| Rename not fsync'd at the directory level (POSIX power loss) | directory fsync where supported |
| Compose Postgres had no volume (recreate = metadata lost, blobs orphaned) | named volume |
| Module-global secret cache leaked revocations between app instances (found by the suite after the revoke fix) | cache moved to `app.state` |

Remaining observations (documented, not fixed): signatures don't cover Host or Content-Type/metadata headers;
orphan scan loads all referenced keys into memory (fine at demo scale); lifecycle bulk deletes don't take per-key
locks; only single-ETag `If-None-Match`.

## Benchmarks (real runs, 2026-11-17, in-process ASGI, Postgres in Docker Desktop on Windows)

| Workload | local adapter | S3 adapter (SeaweedFS in Docker) |
|---|---|---|
| 1KB PUT, 16 concurrent -- before | 53 ops/s | 44 ops/s |
| 1KB PUT, 16 concurrent -- after | 72 ops/s | 57 ops/s |
| 1KB GET, 16 concurrent -- before / after | 85 / 112 ops/s | 55 / 91 ops/s |
| 64MB PUT sequential | 153 MB/s | 45 MB/s |
| 64MB GET sequential | 371 MB/s | 63 MB/s |

What changed: bucket row lock only for quota'd buckets (it serialised every write in the bucket),
access-key secret cache (one round trip less), fewer thread hops in the local adapter.

Further investigation (PUT 1KB, varying concurrency): c=1 31/s (CPU 44% of wall), c=4 **76/s (CPU 122%)**,
c=16 55/s (CPU 110%). Beyond c=4 the single Python process (client + server + SQLAlchemy + thread pool)
is CPU-bound, so more concurrency doesn't help; the API is stateless (all coordination in Postgres), so the
production answer is more API processes.
