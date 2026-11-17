# Project 7 -- S3-like Object Storage System

Buckets and objects over HTTP with streaming uploads/downloads, integrity checks (MD5 ETag, SHA-256,
signed payloads), versioning with delete markers, multipart uploads, presigned URLs, request signing
(simplified SigV4), bucket ACLs / public read, quotas, lifecycle rules, garbage collection of orphan
blobs, and usage analytics. Metadata lives in Postgres; bytes go through a pluggable storage adapter:
**local filesystem** or **any S3-compatible service** (tested against a real SeaweedFS S3 endpoint).

## What is implemented (verified by tests)

| Feature | Where | Test |
|---|---|---|
| Buckets: create (name rules), list, delete-if-empty | `api/routes.py` | `test_bucket_rules` |
| Streaming upload/download, metadata (`x-obj-meta-*`), content type | `services/objects.py::put_object`, `storage/*` | `test_put_get_roundtrip_metadata_and_etag` |
| Checksums: Content-MD5, x-obj-checksum-sha256, signed payload hash | `_verify_digests` | `test_integrity_checks_reject_corrupted_uploads`, `test_signed_body_cannot_be_swapped` |
| Range requests (206/416), ETag + If-None-Match (304) | `get_object`, `parse_range` | `test_range_requests_and_conditional_get` |
| Versioning, delete markers, version restore, permanent version delete | `commit_version`, `delete_object` | `test_versioning_and_delete_markers` |
| Multipart upload (parts, retry, ordering, min size, composite ETag, abort) | `upload_part`, `complete_multipart` | `test_multipart_upload`, `test_multipart_min_part_size_and_abort` |
| Presigned URLs (GET/PUT, expiry, method/key bound) | `services/signing.py`, `/presign` | `test_presigned_urls` |
| Request signing, clock-skew replay window | `services/signing.py`, `services/auth.py` | `test_auth_failures` |
| Access control: owner, read/write grants, public read, admin | `services/auth.py::authorize` | `test_access_control` |
| Storage quotas (all versions count) | `_check_quota` | `test_quota_counts_all_versions` |
| Concurrency: one latest version per key (DB-enforced), advisory key lock | partial unique index, `key_lock_sql` | `test_concurrent_writes_to_same_key` |
| Lifecycle: expiration, noncurrent expiration, lone delete markers, abort multipart | `services/maintenance.py::run_lifecycle` | `test_lifecycle_*` |
| Garbage collection: queued deletions + orphan blobs with grace period | `run_gc` | `test_gc_*` |
| Local FS adapter (temp + fsync + rename, sharded dirs) | `storage/local.py` | all tests |
| S3-compatible adapter (boto3, bounded streaming queue) against SeaweedFS | `storage/s3.py` | `test_s3_adapter.py` (2, incl. 20MB upload) |
| Storage analytics per bucket + platform | `bucket_stats`, `/admin/stats` | `test_admin_stats` |
| Hostile keys can't reach filesystem paths | random blob keys, dot-segment encoding | `test_hostile_keys_never_touch_filesystem_paths` |

28 tests passing. Benchmarks in [TESTING.md](TESTING.md).

## Run

```bash
docker compose -f ../../infra/docker-compose.yml up -d
../../.venv/Scripts/alembic upgrade head
../../.venv/Scripts/uvicorn objstore.main:app --port 8007          # OBJ_STORAGE_BACKEND=local by default
../../.venv/Scripts/python seed.py http://127.0.0.1:8007
../../.venv/Scripts/python -m pytest -q
```

S3 adapter tests need an S3 endpoint (skipped otherwise):
`MSYS_NO_PATHCONV=1 docker run -d --name objstore-seaweed -p 127.0.0.1:58333:8333 chrislusf/seaweedfs:4.48 server -s3 -dir=/data`

Docker (Postgres + SeaweedFS backend + API + maintenance worker): `docker compose up -d --build`
then `python seed.py http://127.0.0.1:58007`.

## Docs

[ARCHITECTURE](ARCHITECTURE.md) . [SYSTEM_DESIGN](SYSTEM_DESIGN.md) . [DATABASE_DESIGN](DATABASE_DESIGN.md) .
[API_DOCUMENTATION](API_DOCUMENTATION.md) . [TRADEOFFS](TRADEOFFS.md) . [FAILURE_SCENARIOS](FAILURE_SCENARIOS.md) .
[SECURITY](SECURITY.md) . [TESTING](TESTING.md) . [DEPLOYMENT](DEPLOYMENT.md) . [LEARNING_GUIDE](LEARNING_GUIDE.md) .
[INTERVIEW_PREPARATION](INTERVIEW_PREPARATION.md)

## Known limitations

- JSON API with S3-like semantics, not the S3 XML wire protocol (boto3 can't talk to it directly).
- Signing is a simplified SigV4 (no derived signing keys, region/service scoping).
- Multipart completion re-streams the parts into a new blob (real S3 composes server-side).
- Single storage backend per deployment; no replication/erasure coding (delegated to the S3 backend).
- Access key secrets stored in plaintext (needed for HMAC verification); production: encrypt at rest.
- The whole-process benchmark is CPU-bound in Python (~76 PUT/s small objects at best); scale API processes horizontally.
