# Learning Guide (Hinglish) -- Distributed Rate Limiter

Is guide ko order mein padho. Har concept ke saath file kholo, test chalao, aur khud observe karo.
Concept tab samajh aaya maano jab tum bina code dekhe interviewer ko explain kar pao.

---

## Step 1: Rate limiting kyun chahiye?

Socho tumhara API ek restaurant hai jahan ek hi kitchen hai. Agar ek customer 500 orders ek saath
de de, toh baaki sab customers ka khana late ho jayega. Rate limiting matlab "har customer ek minute
mein max itne orders de sakta hai".

Real reasons:
- **Abuse / DDoS protection** -- koi script tumhare server ko flood na kare.
- **Brute force rokna** -- login pe password guessing.
- **Fair usage** -- ek tenant baaki sab ka capacity na kha jaye.
- **Business model** -- free plan 60/min, pro plan 600/min (`policies.json` dekho).
- **Downstream protection** -- slow service (reports) ko smooth traffic chahiye.

File: `ratelimiter/policies.json` -- yahan 5 policies hain, har ek alag reason ke liye.

---

## Step 2: In-memory counter kyun fail hota hai (khud prove karo)

File: `ratelimiter/limiter/memory_limiter.py`

Ek server pe yeh bilkul sahi chalta hai. Problem tab hai jab 3 servers hon (load balancer ke peeche).
Har server ki apni memory hai, toh har server user ko poore 50 requests allow karega -> total 150.

```bash
../../.venv/Scripts/python -m pytest -q tests/test_distributed_correctness.py -k in_memory
```

Test `test_in_memory_limiter_overshoots_with_multiple_servers` exactly `LIMIT * 3` assert karta hai.
Yeh interview mein bolne layak line hai: "Maine test likh ke prove kiya ki local counters 3 servers pe
3x overshoot karte hain."

---

## Step 3: Shared Redis bhi kaafi nahi -- race condition

File: `ratelimiter/limiter/naive_redis_limiter.py`

Ab counter Redis mein hai (shared), lekin code pehle `GET` karta hai, phir `SET`. Do requests same
time pe aayi: dono ne count = 4 padha (limit 5), dono ne socha "jagah hai", dono ne 5 likha. Actual
count 6 hona chahiye tha. Isko **check-then-act race condition** kehte hain.

```bash
../../.venv/Scripts/python -m pytest -q tests/test_distributed_correctness.py -k naive
```

Lesson: shared storage + non-atomic logic = still wrong.

---

## Step 4: Lua script se atomicity

Files: `ratelimiter/limiter/lua/fixed_window.lua`, `ratelimiter/limiter/redis_limiter.py`

Redis single-threaded command execution karta hai, aur ek Lua script ko **poora** chalata hai beech
mein koi doosri command ghuse bina. Toh "read + decide + write" ek atomic step ban jata hai.

`redis_limiter.py` mein `register_script` use hota hai. Yeh pehli baar script bhejta hai, phir sirf
SHA1 hash (`EVALSHA`) bhejta hai -- network pe kam data. Agar Redis restart hua aur script cache
khali hai toh `NOSCRIPT` error aata hai aur redis-py automatically script dobara bhej deta hai
(`test_survives_script_cache_flush`).

Proof:
```bash
../../.venv/Scripts/python -m pytest -q tests/test_distributed_correctness.py -k three_servers
```
200 concurrent requests, 3 alag Redis clients (3 servers jaisa), har algorithm ke liye exactly 50 allowed.

---

## Step 5: Paanch algorithms -- kab kaunsa?

| Algorithm | Ek line mein | Is project mein |
|---|---|---|
| Fixed window | "Is minute mein 60" -- simple, boundary pe 2x burst ho sakta hai | `user_plan` |
| Sliding log | Har request ka timestamp yaad rakho -- exact, memory zyada | `login_bruteforce` |
| Sliding counter | Pichhli window ka weighted share + current -- O(1), approx | `ip_global` |
| Token bucket | Bucket mein tokens bharte rehte hain, burst allowed | `search_burst` |
| Leaky bucket | Paani constant speed se nikalta hai, smooth output | `reports_smooth` |

Khud dekho fixed window ki kamzori:
```bash
../../.venv/Scripts/python -m pytest -q tests/test_algorithms.py -k boundary
```
`test_boundary_burst_weakness`: limit 3/sec, lekin 999ms pe 3 aur 1000ms pe 3 -> 2ms mein 6 requests.
`test_no_boundary_burst` (sliding log) mein yahi pattern block ho jata hai.

Token bucket ka "lazy refill" samjho (`token_bucket.lua`): koi background timer nahi chalta. Jab
request aati hai tab hum calculate karte hain ki pichhli baar se ab tak kitne tokens "bhar gaye honge".

---

## Step 6: Time kahan se aata hai?

Har Lua script `ARGV[3] == ''` hone pe `redis.call('TIME')` use karti hai. Kyun? Agar Server A ki
ghadi 2 second aage hai aur Server B ki peeche, toh dono alag window calculate karenge. Redis ki
ek hi ghadi sabke liye -> clock skew problem khatam. Tests mein hum `now_ms` khud dete hain taaki
results deterministic hon.

---

## Step 7: Identity aur plans

File: `ratelimiter/api/deps.py`

- API key header -> SHA-256 hash -> Redis lookup -> `Identity(user_id, api_key_id, plan)`.
- Key nahi hai -> anonymous, IP se identify.
- `X-Real-IP` sirf tab trust hota hai jab `RL_TRUST_FORWARDED_FOR=true` (sirf Nginx ke peeche).
  Warna attacker har request mein naya IP header bhej ke per-IP limit bypass kar dega
  (`test_untrusted_forwarded_header_is_ignored`).

Per-user vs per-API-key fark: ek user ki 2 keys hain. `user_plan` dono keys ka total count karta hai,
`search_burst` har key ka alag bucket rakhta hai (`test_user_quota_shared_across_keys_but_api_key_scope_is_per_key`).

---

## Step 8: Redis down ho gaya toh?

File: `ratelimiter/services/rate_limit_service.py::check_one`

Do options:
- **Fail open** -- request allow karo (availability > protection). Normal APIs ke liye.
- **Fail closed** -- 503 do (protection > availability). Login ke liye, warna Redis down hote hi
  unlimited password guessing.

Khud try karo (Docker stack mein):
```bash
docker compose up -d --build
docker compose stop redis
curl -i http://127.0.0.1:58001/api/resource     # 200 + X-RateLimit-Status: degraded
curl -i -X POST http://127.0.0.1:58001/api/login # 503 + Retry-After: 1
docker compose start redis
```

---

## Step 9: Load test se mile do real bugs (sabse important interview story)

`TESTING.md` -> "Bugs found by load testing" padho.

1. redis-py ka default async pool connections khatam hone pe **error throw** karta hai. Hamara code
   use "Redis down" samajh ke fail-open kar deta -- matlab traffic spike ke time pe hi rate limiter
   band. Fix: `BlockingConnectionPool` (wait karo, error mat do).
2. Har request pe synchronous log likhna event loop ko block kar raha tha. Redis healthy tha, phir bhi
   50ms timeout fire ho rahe the -> 500 errors aur 357 allowed (limit 300). Fix: QueueHandler logging
   (`shared/bpcommon/logging.py`), timeout 250ms, auth errors ko 503 banaya.

Interview mein yeh story bolo: "Unit tests sab pass the, load test ne do production bugs pakde."

---

## Step 10: Horizontal scaling

`docker-compose.yml`: 3 API replicas + Nginx + 1 Redis. Load test output mein
`served_by={'api1': 101, 'api2': 102, 'api3': 97}` aur `200: 300` -- requests teeno servers pe
gayi, phir bhi limit exactly 300. Yahi distributed rate limiting ka poora point hai.

---

## Self-check (bina code dekhe jawab do)

1. 3 servers + in-memory counter -> kya hoga aur kyun?
2. GET then SET mein race kaise hoti hai? Lua isko kaise solve karta hai?
3. Fixed window ka boundary problem example ke saath samjhao.
4. Token bucket vs leaky bucket -- burst ke maamle mein fark?
5. Redis TIME kyun, app server ka time kyun nahi?
6. Login policy fail-closed kyun hai?
7. X-Forwarded-For blindly trust karne se kya attack possible hai?
8. Connection pool exhaustion ne fail-open kaise trigger kiya?
9. Do policies ek route pe -- kya yeh atomic hai? Nahi toh kya side effect hai?
10. 100x traffic pe kya badloge?
