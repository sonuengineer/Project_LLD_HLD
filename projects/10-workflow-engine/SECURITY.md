# Security -- flowengine

| Concern | State |
|---|---|
| API authentication | none for the workflow API: designed as an internal service (put it behind service auth / mTLS). The operator endpoint `retry-task` requires `X-Admin-Token` (`FLOW_ADMIN_TOKEN`) |
| Workflow input/results | stored in plaintext JSON in history; don't put secrets in inputs (pass references); payload encryption via a codec is the production answer (Temporal "data converter") |
| Code execution | only registered workflow/activity names run; inputs are data (JSON), never code |
| Activity side effects | idempotency keys prevent duplicate effects under retries |
| Dashboard XSS | all values escaped |
| SQL injection | parameterised queries throughout |
| Multi-tenancy | not supported (single namespace); Temporal uses namespaces for isolation |
| Container | non-root user |
