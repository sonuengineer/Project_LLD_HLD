from prometheus_client import Counter, Histogram

DECISIONS = Counter("rate_limit_decisions_total", "Rate limit decisions",
                    ["policy", "algorithm", "result"])  # result: allowed | denied | degraded_allow | degraded_deny
BACKEND_ERRORS = Counter("rate_limit_backend_errors_total", "Shared store errors", ["policy"])
CHECK_LATENCY = Histogram("rate_limit_check_seconds", "Latency of one limiter check", ["algorithm"],
                          buckets=(0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25))
