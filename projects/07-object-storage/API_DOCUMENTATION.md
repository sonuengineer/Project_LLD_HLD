# API -- Object Storage

JSON API with S3-like semantics. OpenAPI at `/docs`.

## Authentication

Signed request headers:
```
Authorization: OBJ-HMAC-SHA256 Credential=<access_key_id>, Signature=<hex>
x-obj-date: <unix seconds>                (must be within 15 min)
x-obj-content-sha256: <hex> | UNSIGNED-PAYLOAD
string_to_sign = METHOD \n RAW_PATH \n CANONICAL_QUERY \n DATE \n CONTENT_SHA256
```
Presigned URLs: `?X-Obj-Credential=..&X-Obj-Expires=<unix>&X-Obj-Signature=..` (create via `POST /presign`).
Anonymous: only `GET/HEAD` objects in `public_read` buckets.
Bootstrap: `POST /admin/access-keys` with header `x-admin-token`.

## Buckets

| Method | Path | Body / notes |
|---|---|---|
| GET | `/buckets` | your buckets |
| PUT | `/buckets/{b}` | create (409 if exists, 422 bad name) |
| DELETE | `/buckets/{b}` | 409 `BucketNotEmpty` if any version or upload remains |
| PUT | `/buckets/{b}/versioning` | `{status: enabled|suspended}` |
| PUT | `/buckets/{b}/acl` | `{public_read, grants:[{access_key_id, permission: read|write}]}` (write implies read) |
| PUT | `/buckets/{b}/quota` | `{quota_bytes}` (null = unlimited) |
| PUT | `/buckets/{b}/lifecycle` | `{rules:[{id, prefix, expiration_days, noncurrent_expiration_days, abort_multipart_days}]}` |
| GET | `/buckets/{b}/stats` | counts, bytes, versions, markers, incomplete uploads, by content type, largest |

## Objects

| Method | Path | Notes |
|---|---|---|
| PUT | `/buckets/{b}/objects/{key}` | headers: Content-Type, Content-MD5, x-obj-checksum-sha256, x-obj-meta-*; -> ETag, x-obj-version-id |
| GET | `/buckets/{b}/objects/{key}?versionId=` | Range, If-None-Match; 404 + `x-obj-delete-marker: true` when deleted |
| HEAD | same | headers only |
| DELETE | `/buckets/{b}/objects/{key}?versionId=` | without versionId on versioned bucket -> delete marker |
| GET | `/buckets/{b}/objects?prefix=&delimiter=&start_after=&max_keys=` | `{contents, common_prefixes, is_truncated, next_start_after}` |
| GET | `/buckets/{b}/objects?versions=true&prefix=` | all versions incl. delete markers |

## Multipart

| Method | Path |
|---|---|
| POST | `/buckets/{b}/uploads/{key}` -> `{upload_id}` |
| PUT | `/buckets/{b}/multipart/{upload_id}/parts/{n}` -> ETag |
| GET | `/buckets/{b}/multipart/{upload_id}` (list parts) |
| POST | `/buckets/{b}/multipart/{upload_id}/complete` `{parts:[{part_number, etag}]}` |
| DELETE | `/buckets/{b}/multipart/{upload_id}` (abort) |

## Admin

`POST /admin/access-keys`, `POST /admin/lifecycle/run`, `POST /admin/gc/run`, `GET /admin/stats` (admin key).

## Errors

`NoSuchBucket`/`NoSuchKey`/`NoSuchVersion`/`NoSuchUpload` 404, `BucketAlreadyExists`/`BucketNotEmpty` 409,
`BadDigest` 400, `InvalidPart` 400, `EntityTooLarge` 413, `InvalidRange` 416, `QuotaExceeded` 403,
signature problems 401, permission 403.
