# Interview Preparation -- Object Storage

Question bank: `interview/data/p07-object-storage/` (validated), browsable in the portfolio website.

## Stories

1. **Metadata/data split with crash-safe ordering** -- bytes first, metadata second, GC with grace period.
2. **Integrity end to end** -- streaming MD5/SHA-256, Content-MD5, signed payload hash, BadDigest.
3. **Versioning semantics** -- delete markers, undelete, one-latest-per-key enforced by a partial unique index.
4. **Multipart + presigned URLs** -- composite ETag gotcha, presign bounded by signer's authority.
5. **Storage abstraction proven against a real S3 API** (SeaweedFS, 20MB boto3 multipart) and the bucket-lock bottleneck fix.
