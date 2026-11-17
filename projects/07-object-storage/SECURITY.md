# Security -- Object Storage

| Threat | Mitigation | Code |
|---|---|---|
| Credential theft in transit | secret never sent; HMAC signature per request | `services/signing.py` |
| Replay of a captured request | signed date, 15-min window | `authenticate` |
| Request tampering (method, path, query, body) | all in the string-to-sign; body via content hash | `string_to_sign` |
| Timing attacks on signatures | `hmac.compare_digest` | `services/auth.py` |
| Over-shared presigned URLs | expiry (<= 7 days), bound to method + key (+ version); only presign what you can do | `/presign` |
| Path traversal via keys | blob keys are random hex, validated `isalnum()`; object keys are data | `storage/local.py::_path` |
| Unauthorized access | owner / grants / public-read only for object GET (no anonymous listing) | `authorize` |
| Storage exhaustion | max object size (stream-enforced), quotas, lifecycle | `HashingStream`, `_check_quota` |
| Data corruption | MD5 + SHA-256 on every object; CRC/fsync semantics of the local adapter | `objects.py` |
| Bucket name confusion / DNS issues | DNS-compatible name check | migration CHECK |
| Enumeration via anonymous listing | listing always requires credentials | `list_objects` route |

Gaps (documented): access key secrets stored in plaintext (encrypt with a KMS key in production), no
server-side encryption of blobs, no object lock / WORM, no bucket policies language (only ACL grants),
no TLS in the compose demo.
