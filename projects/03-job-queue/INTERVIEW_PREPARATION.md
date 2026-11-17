# Interview Preparation -- Distributed Job Queue

Question bank: `interview/data/p03-job-queue/` (validated), browsable in the portfolio website.

## Stories

1. **Kill -9 test**: real worker process killed after commit, before ack -> redelivered -> idempotent ledger -> exactly one email.
2. **Fencing tokens**: why a lease alone is not enough (zombie worker), attempts as token.
3. **Atomic transitions in Lua**: no half-moved jobs; 20 claimers x 1000 jobs, zero duplicates.
4. **Backoff with full jitter + DLQ + PermanentError**: retry strategy design.
5. **Throughput fix**: serial claiming -> batch claim with inline hash: 158 -> 577 jobs/s.
