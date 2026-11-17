# Trade-offs -- Object Storage

1. **Postgres for metadata.** Transactions, constraints, window functions for lifecycle, easy listing;
   one database becomes the scaling limit for metadata ops (real systems shard metadata).
2. **Random blob keys.** No path traversal, cheap metadata-only "renames", dedupe-free; costs an indirection
   (key -> blob) and makes the blob store unreadable without the database (backups must include both).
3. **Bytes first, metadata second.** Never dangling metadata; costs orphan blobs and a GC process.
4. **Async blob deletion (queue).** Fast, reliable deletes; storage is reclaimed later, not immediately.
5. **Advisory lock per key.** Concurrent writers of one key serialize briefly at commit; other keys
   don't contend. A bucket lock is taken only when a quota must be checked atomically.
6. **Quota counts all versions.** Matches billing reality; surprises users who "deleted" objects in a
   versioned bucket (delete markers don't free space).
7. **Multipart composition by re-streaming.** Simple and backend-agnostic; doubles I/O at completion vs
   server-side composition.
8. **MD5 ETag.** Familiar and cheap integrity check for single PUTs; the multipart composite ETag is NOT the
   object's MD5 -- clients needing end-to-end integrity should use the SHA-256 checksum we also store.
9. **Simplified SigV4.** Same security properties for this demo (secret never sent, request bound, replay
   window); lacks key derivation/scoping that limits blast radius in AWS.
10. **Secret cache (60s).** One fewer DB round trip per request; revoked keys work up to 60s per instance.
11. **UNSIGNED-PAYLOAD allowed.** Streaming uploads without hashing twice; body integrity then relies on
    Content-MD5 / checksum headers and TLS.
