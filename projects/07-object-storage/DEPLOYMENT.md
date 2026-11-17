# Deployment -- Object Storage

```bash
docker compose up -d --build      # postgres, seaweedfs (S3 backend), migrate, api (127.0.0.1:58007), worker
python seed.py http://127.0.0.1:58007
```

Backend selection: `OBJ_STORAGE_BACKEND=local|s3` (+ `OBJ_S3_*` settings). The API is stateless: run as
many replicas as needed behind a load balancer.

## Production checklist

1. Back up Postgres AND the blob store together (blob keys are meaningless without metadata).
2. Run the maintenance worker (lifecycle + GC); alert if `blob_deletions` grows or GC fails.
3. Set `OBJ_PUBLIC_BASE_URL` to the externally visible URL (presigned URLs embed it).
4. TLS termination in front; consider presigning directly against the blob store/CDN for large downloads.
5. Quotas on shared deployments; max object size and request body limits at the proxy.
6. Encrypt access key secrets and, if required, blobs at rest (SSE).
