# Learning Guide (Hinglish) -- Distributed Job Queue

## Step 1: Queue kyun?

User signup karta hai -> welcome email bhejna hai. Agar HTTP request ke andar hi email provider ko
call karoge aur provider 5 second slow hai, toh user 5 second wait karega; provider down hai toh
signup fail. Isliye kaam ko "job" bana ke queue mein daalo, request turant return karo, aur worker
background mein kare -- retries ke saath.

## Step 2: Job ka safar (state machine)

`ARCHITECTURE.md` ka state diagram dekho: queued -> active -> succeeded, ya fail hone pe delayed
(backoff) -> phir queued, aur attempts khatam -> dead (DLQ). Har transition ek Lua script hai
(`jobqueue/core/lua/`), isliye beech mein crash hone pe job "na idhar na udhar" wali state mein
kabhi nahi atakti.

## Step 3: Priority aur FIFO ek saath

`enqueue.lua`: score = `(9 - priority) * 1e13 + seq`. Priority 9 ka score sabse chhota, toh
`ZPOPMIN` usse pehle nikalta hai; same priority mein `seq` chhota = pehle aaya. Test:
`test_priority_then_fifo`.

## Step 4: Visibility timeout / lease

Worker job claim karta hai toh job delete nahi hoti -- `active` zset mein "lease deadline" ke saath
jaati hai. Worker zinda hai toh har lease/3 time pe lease badhata hai (`extend_lease.lua`). Worker
mar gaya -> lease khatam -> reaper (har worker pe chalta hai) job ko wapas retry mein daal deta hai.
Lease 30s pe cap hai, isliye 1 ghante ka job bhi ho, crash ~35s mein pakda jata hai.

## Step 5: Fencing token -- zombie worker problem

Worker A slow ho gaya (GC pause, network), lease expire, job worker B ko mil gayi (attempt 2). Ab A
jaag ke "done!" bolta hai. Agar hum maan lein toh B ka kaam overwrite. Solution: `attempts` number
token hai. `ack.lua` check karta hai `attempts == token`; A ka token 1 hai, current 2 -> reject.
Test: `test_visibility_timeout_reaper_and_fencing`.

## Step 6: At-least-once + idempotency = effectively once

Queue guarantee deti hai "job kam se kam ek baar chalegi". Duplicate kab? Worker ne email DB mein
commit kiya aur ack se pehle crash. Job dobara aayegi. `handlers/builtin.py::send_email` mein ek hi
transaction mein `processed_jobs(job_id)` insert + email insert. Dobara aane pe insert conflict ->
skip. Sabse strong proof:
```bash
../../.venv/Scripts/python -m pytest -q tests/test_crash_process.py
```
Real worker process ko kill kiya jata hai commit ke baad; doosra process job khatam karta hai,
result `duplicate: true`, email table mein sirf 1 row.

## Step 7: Retry + backoff + jitter + DLQ

`core/backoff.py`: delay = random(0, min(max, base * 2^(attempt-1))). Jitter kyun? 1000 jobs ek
saath fail hui (DB down) toh bina jitter sab exactly same time pe retry karke DB ko phir gira
dengi (thundering herd). Poison message (hamesha fail) `max_attempts` ke baad DLQ mein jaata hai --
infinite loop nahi. `PermanentError` (galat payload) seedha DLQ, retries waste nahi.

## Step 8: Scheduler 3 workers pe -- double fire kaise roka?

`schedule_tick.lua`: compare-and-advance. Jo caller `next_run <= now` dekh ke `next_run` aage
badhata hai wahi enqueue karega; baaki ko `nil`. Upar se per-slot idempotency key. Test 5 parallel
schedulers ke saath exactly 1 job.

## Step 9: Performance story

Pehle 1 worker = 158 jobs/s. Kyun? Claim loop ek-ek job claim karta tha, har claim ke 2 round trips.
16 slots free the lekin claims serial the. Fix: ek Lua call mein jitne slots free utni jobs claim
karo, job ka data bhi saath return karo. Result 577 jobs/s (3.6x), 4 workers pe 1,227 jobs/s.

## Self-check

1. Job claim karte hi delete kyun nahi karte?
2. Zombie worker kya hai aur fencing token kaise bachata hai?
3. At-least-once mein duplicate kab-kab hota hai? Idempotency ledger same transaction mein kyun?
4. Jitter na ho toh kya hoga?
5. Poison message aur PermanentError mein fark?
6. Lease 30s cap kyun, job timeout jitna kyun nahi?
7. Handler ne `time.sleep` (blocking) use kiya toh kya galat ho sakta hai?
8. Strict priority ka nuksaan kya hai?
