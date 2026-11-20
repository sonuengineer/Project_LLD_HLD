// Static portfolio facts. Every number here is copied from the project's own measurements (the "source" field says
// which file; for project 11 the raw result files are in projects/12-reverse-proxy/bench/reference-results); nothing is estimated. Test counts are from the last full run recorded in IMPLEMENTATION_STATUS.md.

export interface Bench {
  title: string;
  unit: string;
  note: string;              // test conditions, copied from TESTING.md
  log?: boolean;             // log-scale y axis when values span orders of magnitude
  source: string;            // repo-relative file the numbers come from
  series: string[];          // bar series names
  rows: Record<string, string | number>[]; // { label, <series>: value }
}

export interface ProjectInfo {
  num: number;
  slug: string;              // interview data slug
  dir: string;               // repo-relative project dir
  name: string;
  tagline: string;
  stack: string[];
  features: string[];
  tests: string;
  run: string;
  benches: Bench[];
  docs?: string[];           // design documents that really exist for this project (default: the usual twelve)
}

export const PROJECTS: ProjectInfo[] = [
  {
    num: 1, slug: "p01-rate-limiter", dir: "projects/01-rate-limiter", name: "Distributed Rate Limiter",
    tagline: "Five rate-limiting algorithms as atomic Redis Lua scripts, shared by many API replicas.",
    stack: ["FastAPI", "Redis", "Lua", "Nginx", "k6"],
    features: [
      "Fixed window, sliding log, sliding counter, token bucket, leaky bucket -- each one atomic Lua script",
      "Redis server time by default (no clock skew between replicas)",
      "Policies per route group with Redis overrides; hashed API keys with cache",
      "Fail-open / fail-closed per policy when Redis is down",
      "In-memory and naive GET/SET limiters kept as demos of the failure modes",
      "3 replicas behind nginx; exact limit verified across replicas",
    ],
    tests: "39 passing (incl. 200 concurrent requests across 3 clients -> exactly 50 allowed)",
    run: "cd projects/01-rate-limiter && docker compose up -d --build  # http://127.0.0.1:58001",
    benches: [{
      title: "Lua algorithm micro-benchmark", unit: "checks/s",
      note: "loadtest/bench_lua.py, 20k checks, concurrency 50, host -> Docker port. Relative comparison only.",
      source: "projects/01-rate-limiter/TESTING.md", series: ["checks/s"],
      rows: [
        { label: "fixed_window", "checks/s": 1167 }, { label: "sliding_log", "checks/s": 1593 },
        { label: "sliding_counter", "checks/s": 1883 }, { label: "token_bucket", "checks/s": 2020 },
        { label: "leaky_bucket", "checks/s": 2118 },
      ],
    }, {
      title: "k6 through nginx + 3 replicas", unit: "req/s",
      note: "k6 1.4.2, 64 VUs, 20s, inside the compose network.",
      source: "projects/01-rate-limiter/TESTING.md", series: ["req/s"],
      rows: [
        { label: "baseline /healthz", "req/s": 993 }, { label: "allowed path", "req/s": 500 },
        { label: "hot key (mostly 429)", "req/s": 722 },
      ],
    }],
  },
  {
    num: 2, slug: "p02-mini-redis", dir: "projects/02-mini-redis", name: "Redis-like Database (minidis)",
    tagline: "An asyncio Redis-compatible server: RESP2/3, expiry, eviction, AOF + snapshots, replication.",
    stack: ["asyncio", "RESP", "redis-benchmark"],
    features: [
      "RESP2 and RESP3 protocol; works with redis-cli, redis-py and redis-benchmark",
      "Strings, lists, hashes and sets; lazy + active (sampled) expiry",
      "maxmemory eviction: noeviction, allkeys-lru, volatile-lru, volatile-ttl (sampled approximations)",
      "Snapshots with CRC; AOF with always/everysec/no fsync, rewrite, truncated-tail recovery",
      "Master -> replica replication with offsets, lag tracking and batched stream flush",
    ],
    tests: "52 passing",
    run: "cd projects/02-mini-redis && docker compose up -d --build  # see README for ports",
    benches: [{
      title: "redis-benchmark, pipelined P=16 (after replication fix)", unit: "requests/s",
      note: "Official redis-benchmark, -n 50000 -c 50, AOF everysec, replica attached, Docker Desktop on Windows (shared VM). Run-to-run variance is large.",
      source: "projects/02-mini-redis/TESTING.md", series: ["Redis 7", "minidis"],
      rows: [
        { label: "SET", "Redis 7": 207469, minidis: 34698 }, { label: "GET", "Redis 7": 294118, minidis: 53135 },
        { label: "INCR", "Redis 7": 228311, minidis: 57143 }, { label: "LPUSH", "Redis 7": 130208, minidis: 40290 },
        { label: "HSET", "Redis 7": 235849, minidis: 43253 },
      ],
    }],
  },
  {
    num: 3, slug: "p03-job-queue", dir: "projects/03-job-queue", name: "Distributed Job Queue",
    tagline: "Redis-backed job queue with leases, fencing tokens, retries, scheduling and a dead-letter queue.",
    stack: ["FastAPI", "Redis", "Lua", "multiprocessing"],
    features: [
      "Every state transition is one Lua script (enqueue, claim, ack, fail, recover)",
      "Leases with fencing tokens: a worker that lost its lease cannot ack",
      "Batch claim, retries with backoff, delayed jobs and recurring interval schedules",
      "Dead-letter queue (incl. corrupt payloads), expiry of finished jobs",
      "Real kill -9 test: jobs of a killed worker are recovered",
    ],
    tests: "30 passing (incl. real kill -9 of a worker process)",
    run: "cd projects/03-job-queue && docker compose up -d --build  # http://127.0.0.1:58003",
    benches: [{
      title: "Throughput, 5000 no-op jobs", unit: "jobs/s",
      note: "bench/throughput.py, real worker subprocesses, 16 slots each, Redis in Docker Desktop. Includes process start-up.",
      source: "projects/03-job-queue/TESTING.md", series: ["before (1 claim/job)", "after (batch claim)"],
      rows: [
        { label: "1 worker process", "before (1 claim/job)": 158, "after (batch claim)": 577 },
        { label: "4 worker processes", "before (1 claim/job)": 440, "after (batch claim)": 1227 },
      ],
    }],
  },
  {
    num: 4, slug: "p04-webhooks", dir: "projects/04-webhooks", name: "Webhook Delivery Platform",
    tagline: "Transactional outbox, signed deliveries, retries with backoff, SSRF protection.",
    stack: ["FastAPI", "Postgres", "SKIP LOCKED", "httpx"],
    features: [
      "Postgres outbox: events and deliveries written in the producer's transaction",
      "Dispatchers claim with FOR UPDATE SKIP LOCKED; lease + backstop for crashed dispatchers",
      "Standard Webhooks signing (reference vector test passes), secret rotation",
      "Configurable retry schedule with +-20% jitter, Retry-After (capped), endpoint auto-disable after repeated failures",
      "SSRF protection: private IP blocking with DNS pinning (no rebinding)",
    ],
    tests: "41 passing",
    run: "cd projects/04-webhooks && docker compose up -d --build  # http://127.0.0.1:58004",
    benches: [{
      title: "Backlog drain, 3000 deliveries", unit: "deliveries/s",
      note: "bench/bench_drain.py, backlog built with dispatchers stopped, receiver verified every signature, 0 duplicates.",
      source: "projects/04-webhooks/TESTING.md", series: ["deliveries/s"],
      rows: [
        { label: "v1, 1 dispatcher", "deliveries/s": 48 }, { label: "v2, 1 dispatcher", "deliveries/s": 111 },
        { label: "v2, 3 dispatchers", "deliveries/s": 189 },
      ],
    }],
  },
  {
    num: 5, slug: "p05-mini-kafka", dir: "projects/05-mini-kafka", name: "Mini Kafka (minikafka)",
    tagline: "Segmented commit log with sparse indexes, replication (ISR / high watermark), consumer groups.",
    stack: ["Python", "FastAPI", "binary log format"],
    features: [
      "Segmented append-only log, CRC per record batch, sparse offset index, retention",
      "In-process 3-broker cluster: leader/follower fetch, ISR, high watermark, acks=0/1/all",
      "HW checkpoints, leader failover, min.insync.replicas",
      "Consumer groups with offset commits; idempotent producer (sequence numbers)",
    ],
    tests: "40 passing",
    run: "cd projects/05-mini-kafka && docker compose up -d --build  # http://127.0.0.1:58005",
    benches: [{
      title: "Cluster produce, 3 brokers rf=3, batch 100", unit: "msg/s (log scale)", log: true,
      note: "In-process cluster, Windows 11 laptop-class machine, local SSD. The fix: reusable read handle per segment.",
      source: "projects/05-mini-kafka/TESTING.md", series: ["before fix", "after fix"],
      rows: [
        { label: "acks=1 sequential", "before fix": 444757, "after fix": 408127 },
        { label: "acks=all sequential", "before fix": 8702, "after fix": 73795 },
        { label: "acks=all 8 partitions", "before fix": 8125, "after fix": 63202 },
      ],
    }, {
      title: "Storage append (100-byte values)", unit: "msg/s",
      note: "Log.append, local SSD.",
      source: "projects/05-mini-kafka/TESTING.md", series: ["msg/s"],
      rows: [
        { label: "batch 1", "msg/s": 117392 }, { label: "batch 100", "msg/s": 526267 },
        { label: "batch 1000", "msg/s": 562998 }, { label: "batch 100 + fsync", "msg/s": 85229 },
      ],
    }],
  },
  {
    num: 6, slug: "p06-saas", dir: "projects/06-saas", name: "Multi-Tenant SaaS Backend",
    tagline: "Tenant isolation enforced by Postgres Row-Level Security, not by remembering WHERE clauses.",
    stack: ["FastAPI", "Postgres RLS", "Alembic", "JWT"],
    features: [
      "RLS policies on every tenant table, app connects as a non-owner role",
      "SECURITY DEFINER functions for the few cross-tenant lookups (API keys, invitations)",
      "Users, memberships with roles, invitations, API keys, audit log",
      "Plans and quotas, billing webhooks (mock) applied in one transaction",
      "Isolation tests try cross-tenant reads/writes and expect them to fail",
    ],
    tests: "31 passing",
    run: "cd projects/06-saas && docker compose up -d --build  # http://127.0.0.1:58006",
    benches: [{
      title: "RLS query: 100 tenants x 1,000 projects, LIMIT 20", unit: "ms (server execution)",
      note: "bench/rls_bench.py, EXPLAIN ANALYZE as the app role.",
      source: "projects/06-saas/TESTING.md", series: ["ms"],
      rows: [
        { label: "RLS + (tenant_id, created_at) index", ms: 0.148 },
        { label: "RLS without that index", ms: 2.938 },
      ],
    }],
  },
  {
    num: 7, slug: "p07-object-storage", dir: "projects/07-object-storage", name: "S3-like Object Storage",
    tagline: "Buckets, objects, multipart uploads, presigned URLs, quotas -- on local disk or any S3 backend.",
    stack: ["FastAPI", "Postgres", "SeaweedFS (S3)", "streaming I/O"],
    features: [
      "Streaming PUT/GET with checksums; metadata in Postgres, bytes in a pluggable adapter",
      "Local-disk adapter (atomic rename + fsync) and S3 adapter tested against real SeaweedFS",
      "Multipart upload with part listing and completion",
      "Presigned URLs (HMAC, expiry enforced at use) and key revocation",
      "Per-tenant quotas with row locks; garbage collection with a grace period",
    ],
    tests: "28 passing (2 against a real SeaweedFS S3 container)",
    run: "cd projects/07-object-storage && docker compose up -d --build  # http://127.0.0.1:58007",
    benches: [{
      title: "1KB PUT / GET, 16 concurrent (after fix)", unit: "ops/s",
      note: "In-process ASGI, Postgres in Docker Desktop on Windows; single Python process is CPU-bound.",
      source: "projects/07-object-storage/TESTING.md", series: ["local adapter", "S3 adapter"],
      rows: [
        { label: "PUT 1KB", "local adapter": 72, "S3 adapter": 57 },
        { label: "GET 1KB", "local adapter": 112, "S3 adapter": 91 },
      ],
    }, {
      title: "64MB sequential", unit: "MB/s",
      note: "Same setup.", source: "projects/07-object-storage/TESTING.md", series: ["local adapter", "S3 adapter"],
      rows: [
        { label: "PUT 64MB", "local adapter": 153, "S3 adapter": 45 },
        { label: "GET 64MB", "local adapter": 371, "S3 adapter": 63 },
      ],
    }],
  },
  {
    num: 8, slug: "p08-collab", dir: "projects/08-collab", name: "Collaborative Editing (OT)",
    tagline: "Google-Docs-style real-time editing with Operational Transformation across several servers.",
    stack: ["FastAPI WebSockets", "Postgres", "Redis pub/sub", "OT"],
    features: [
      "Text OT core (apply / compose / transform / transform_index) with property tests",
      "Per-document sequencer using a Postgres row lock; dedupe of retried ops",
      "Redis pub/sub fan-out with an ordered forwarder and gap fill from Postgres",
      "Client state machine (in-flight + buffer), offline editing and resync",
      "Presence and cursors; browser demo editor; 2 servers behind nginx",
    ],
    tests: "34 passing (incl. fuzz test, 2 real servers, tail-loss and revocation regressions)",
    run: "cd projects/08-collab && docker compose up -d --build  # http://127.0.0.1:58008/editor",
    benches: [{
      title: "Edit propagation A -> B (100 edits)", unit: "ms",
      note: "2 uvicorn servers in-process, Postgres + Redis in Docker Desktop on Windows.",
      source: "projects/08-collab/TESTING.md", series: ["p50", "p95"],
      rows: [
        { label: "same server", p50: 21.0, p95: 29.1 },
        { label: "across servers (Redis)", p50: 19.4, p95: 27.4 },
      ],
    }],
  },
  {
    num: 9, slug: "p09-payments", dir: "projects/09-payments", name: "Payment System",
    tagline: "Authorize / capture / refund against a mock provider with idempotency and a double-entry ledger.",
    stack: ["FastAPI", "Postgres", "httpx", "mock provider"],
    features: [
      "Mock provider is a separate app reached over HTTP (timeouts and ambiguity are real); never real money",
      "Idempotency keys on every mutating API; intermediate states with compare-and-set transitions",
      "Double-entry ledger enforced by the database (balanced + immutable triggers)",
      "Recovery worker resolves ambiguous outcomes; signed provider webhooks",
      "Daily reconciliation against provider settlements; refund saga",
    ],
    tests: "25 passing (incl. crash-takeover, webhook-redelivery and saga regressions)",
    run: "cd projects/09-payments && docker compose up -d --build  # http://127.0.0.1:58009",
    benches: [{
      title: "Authorize + capture + ledger", unit: "payments/s",
      note: "Both apps in one process, Postgres in Docker Desktop on Windows; 26 SQL statements per payment.",
      source: "projects/09-payments/TESTING.md", series: ["payments/s"],
      rows: [{ label: "sequential", "payments/s": 7.5 }, { label: "16 concurrent", "payments/s": 14.1 }],
    }],
  },
  {
    num: 10, slug: "p10-workflow-engine", dir: "projects/10-workflow-engine", name: "Durable Workflow Engine",
    tagline: "Temporal-style workflows as plain async Python, made durable by event-history replay.",
    stack: ["asyncio", "Postgres", "FastAPI"],
    features: [
      "Deterministic replay of event history; NonDeterminismError on code drift",
      "Activities with retry policies, start-to-close and heartbeat timeouts",
      "Durable timers, signals (buffered), cancellation with compensation",
      "Workers with leases; crash of a worker mid-workflow is recovered",
      "5 example workflows: order, payment + refund, onboarding, document approval, email campaign",
    ],
    tests: "30 passing (stable over repeated runs; incl. cancel-while-running and lease regressions)",
    run: "cd projects/10-workflow-engine && docker compose up -d --build  # http://127.0.0.1:58010",
    benches: [{
      title: "Workflows/s (4 activities each, 60 workflows)", unit: "workflows/s",
      note: "Postgres in Docker Desktop on Windows; 97 SQL statements per workflow; includes process start-up.",
      source: "projects/10-workflow-engine/TESTING.md", series: ["workflows/s"],
      rows: [
        { label: "1 worker process", "workflows/s": 4.9 }, { label: "2 worker processes", "workflows/s": 7.6 },
        { label: "4 worker processes", "workflows/s": 8.3 },
      ],
    }],
  },
  {
    // num follows the H-list (H11); the folder is projects/12-reverse-proxy because projects/11 is the MCP server (A3).
    num: 11, slug: "p12-reverse-proxy", dir: "projects/12-reverse-proxy", name: "Reverse Proxy + Load Balancer",
    tagline: "A hand-written HTTP reverse proxy with load balancing, health checks and safe retries; measured on a real server.",
    stack: ["TypeScript", "Node.js (no runtime dependencies)", "systemd", "autocannon"],
    features: [
      "Streams request and response bodies; a 1 GiB download raised proxy memory by about 40 MiB (measured)",
      "Round-robin and least-connections with lease-based active counters (all back to 0 after a 30-minute soak)",
      "Passive ejection after 3 consecutive connection failures, optional active health checks, 503 with Retry-After when nothing is healthy",
      "Retries only for body-less GET/HEAD/OPTIONS before any response byte; never for POST or for slow (idle-timeout) upstreams",
      "Strips hop-by-hop headers, overwrites a spoofed X-Forwarded-For, detects proxy loops (508)",
      "Separate connect timeout, tried against a real black hole; graceful shutdown (a measured defect was found and fixed)",
      "Runs as a hardened systemd service on an Oracle ARM server (loopback only, not public)",
    ],
    tests: "109 passing on Linux/arm64 (107 on Windows: the 2 tests that send a real SIGTERM only run on Linux/macOS)",
    run: "cd projects/12-reverse-proxy && npm ci && npm run build && UPSTREAM=http://127.0.0.1:3000 node dist/index.js",
    docs: ["README", "STAGE4_PLAN"],
    benches: [
      {
        title: "What the proxy costs", unit: "req/s",
        note: "Load generator, proxy and upstream share one 2-core Oracle ARM server; 32 connections, median of 3 runs of 15 s each. Relative comparison only, not a capacity claim.",
        source: "projects/12-reverse-proxy/README.md", series: ["req/s"],
        rows: [{ label: "direct to upstream", "req/s": 14953 }, { label: "through the proxy", "req/s": 3586 }, { label: "proxy, request log off", "req/s": 4044 }],
      },
      {
        title: "One slow upstream (+40 ms): round-robin vs least-connections", unit: "req/s",
        note: "Same server and method. Median latency 15 ms vs 6 ms, but p99 was 46 ms vs 49 ms: the tail did not improve.",
        source: "projects/12-reverse-proxy/README.md", series: ["req/s"],
        rows: [{ label: "round-robin", "req/s": 1524 }, { label: "least-connections", "req/s": 3400 }],
      },
      {
        title: "Graceful shutdown: time to exit after SIGTERM", unit: "ms",
        note: "10 requests of 2 s in flight, SIGTERM after 0.5 s; the work itself needs about 1500 ms. Before: idle keep-alive connections were never swept.",
        source: "projects/12-reverse-proxy/README.md", series: ["ms"],
        rows: [{ label: "before the fix", ms: 4540 }, { label: "after the fix", ms: 1611 }],
      },
    ],
  },
];

export const bySlug = (slug: string) => PROJECTS.find((p) => p.slug === slug);
