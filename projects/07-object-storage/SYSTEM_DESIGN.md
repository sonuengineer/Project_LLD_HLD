# System Design -- Object Storage

## Object storage vs file storage vs block storage

| | Block | File | Object |
|---|---|---|---|
| Unit | fixed blocks | files in a directory tree | immutable objects in a flat namespace (bucket + key) |
| Access | OS/filesystem | POSIX (open, seek, rename) | HTTP API (PUT/GET/DELETE whole objects, ranges) |
| Update | in place | in place | replace the whole object (new version) |
| Metadata | none | limited (perms, times) | rich user metadata, versions, tags |
| Scale | one machine/volume | hard to scale out | effectively unlimited, cheap |
| Use | DB volumes | shared drives | backups, media, data lakes, static assets |

"Folders" in object storage are an illusion: `docs/a.txt` is one key; listing with `delimiter=/`
groups keys by prefix into "common prefixes".

## Consistency

Strong read-after-write for this system: metadata commits before the 200, so the next GET (any
instance) sees the new version. (AWS S3 has been strongly consistent since Dec 2020.)

## Large files

- Single PUT up to 5 GiB, streamed with constant memory.
- Multipart: parts uploaded independently (in parallel, retried individually), min 5 MiB except the last,
  up to 10,000 parts; completion assembles them; composite ETag `md5(concat(part md5s))-N`.
- Range GETs let clients resume downloads or fetch parallel chunks.

## Scaling path

| Scale | Change |
|---|---|
| 10x | more stateless API processes (locks live in Postgres); S3 backend; read replicas for listing |
| 100x | shard metadata by bucket (or hash of bucket/key); move listing to a dedicated index; CDN in front of public reads; presigned URLs pointing directly at the blob store so bytes bypass the API |
| Huge objects | server-side multipart composition (no re-streaming), erasure coding in the blob layer |

## Lifecycle / cost management

Expire current versions (e.g. logs after 30 days), expire noncurrent versions (keep 7 days of history),
clean up lone delete markers, abort forgotten multipart uploads (they cost storage but are invisible in listings).
