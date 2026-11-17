# Testing -- Payment System

```bash
../../.venv/Scripts/alembic -x url=postgresql+asyncpg://bp:bp_dev_password@127.0.0.1:55432/p09_payments_test upgrade head
../../.venv/Scripts/python -m pytest -q        # 25 tests, ~17s, stable across repeated runs
../../.venv/Scripts/python bench/throughput.py
```

The payments app and the mock provider are both real FastAPI apps wired over ASGI (provider webhooks call back
into the payments app). The provider client enforces its own deadline, so slow-provider scenarios are real
timeouts.

| File | Count | Covers |
|---|---|---|
| `test_payments.py` | 12 | fee rounding, capture + balanced ledger + event timeline, partial capture + refunds, declines + retry, duplicate order, idempotency (replay, mismatch, concurrent), concurrent captures, concurrent refunds, DB-enforced ledger invariants, flaky provider, capture rejected, auth |
| `test_failures.py` | 7 | timeout resolved by same-key retry, timeout -> requires_reconciliation -> recovery, provider never saw it -> failed, crash mid-capture -> recovery (twice, booked once), webhooks (finalise, dedupe, forged), reconciliation (matched / amount mismatch / missing internally), saga (success, compensation, no stock) |

## Benchmark (real run, 2026-11-17; both apps in one process, Postgres in Docker Desktop on Windows)

| Measurement | Result |
|---|---|
| Sequential authorize + capture + ledger | 7.5 payments/s, p50 127.8 ms, p95 163.3 ms |
| 16 concurrent | 14.1 payments/s, p50 1073 ms |
| Idempotent replay (no provider call) | 26.5 ms per request |
| Trial balance after 500+ payments | 0 |

Analysis: one authorize+capture = 26 SQL statements in the payments app (plus ~10 in the provider), most of
them deliberate (separate short transactions around each provider call, CAS transitions, audit rows, ledger
postings). At ~3 ms per round trip through Docker Desktop that is the ~128 ms sequential latency. Under
concurrency the single process (payments app + mock provider + both HTTP stacks) is CPU-bound (96% of wall),
so 16-way concurrency only doubles throughput. In production these are separate processes with several
workers; the per-payment design is kept for crash safety, not optimised for this benchmark.

## Review fixes (2026-11-17)

`tests/test_review_fixes.py` (6 tests), one per bug found in code review while writing the interview bank;
each test fails on the previous code:

| Test | Bug it pins |
|---|---|
| `test_payment_takeover_after_crash_resumes_the_same_payment` | idempotency-lock takeover created a NEW payment id (new provider key `auth-<id>`) -> 409 instead of resuming; now the id is derived from the Idempotency-Key and the attempt resumes |
| `test_refund_takeover_after_crash_does_not_refund_twice` | takeover inserted a second refund with a new `refund-<id>` key -> could refund twice |
| `test_webhook_whose_first_apply_failed_is_applied_on_redelivery` | the dedupe row was committed before applying, so a redelivery after a failed apply was dropped as "duplicate" |
| `test_saga_with_unknown_payment_outcome_does_not_cancel_the_order` | an ambiguous payment was compensated as failed (stock released, order cancelled) while recovery could still capture the money |
| `test_saga_whose_compensation_fails_is_reported_failed` | a failed refund still marked the saga "compensated" |
| `test_ledger_rejects_transaction_that_balances_only_across_currencies` | balance trigger summed across currencies; also `payment_events` is now append-only (trigger) |

