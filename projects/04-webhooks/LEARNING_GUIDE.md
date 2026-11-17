# Learning Guide (Hinglish) -- Webhook Delivery

## Step 1: Webhook kya hai, polling se better kyun?

Polling = customer har 10 second puchhta hai "payment hua kya?". 99% requests ka jawab "nahi" --
waste, aur 10 second tak late. Webhook = jab payment hota hai, hum customer ke server pe POST kar
dete hain. Lekin ab reliability ki zimmedari humari: customer ka server down ho, slow ho, galat
response de -- sab handle karna padega.

## Step 2: Outbox pattern (dual write problem)

`services/events.py::publish`. Event save kiya aur phir alag se queue mein message daala -- beech
mein crash hua toh event hai par delivery kabhi nahi hogi. Isliye event aur uski saari delivery
rows EK transaction mein insert hoti hain. Delivery table hi queue hai. Test:
`test_publish_is_atomic` -- crash simulate kiya, dono tables khaali.

## Step 3: SKIP LOCKED se Postgres ko queue banana

`dispatcher.py::CLAIM_SQL`. `FOR UPDATE` rows lock karta hai, `SKIP LOCKED` doosre dispatcher ko
wait karne ke bajaye agli free rows de deta hai. 3 dispatchers, 150 events, har ek exactly once
(`test_three_dispatchers_deliver_each_exactly_once`). Lease (`locked_until`) aur `attempts`
fencing token wahi idea hai jo Project 3 mein Redis ke saath tha -- yahan SQL mein.

Important rule: HTTP call transaction ke BAHAR hota hai. Customer ka server 10 second le toh hum
10 second DB lock nahi pakad ke baithte.

## Step 4: HMAC signing

`services/signing.py`. Signature = HMAC(secret, "id.timestamp.body"). Body ke saath id aur timestamp
bhi sign kyun? Taaki attacker purani request copy karke baad mein replay na kar sake -- timestamp
badlega toh signature match nahi hoga, aur receiver 5 minute se purani request reject karta hai.
Hamara implementation Standard Webhooks ke official test vector se match karta hai
(`test_standard_webhooks_reference_vector`).

Secret rotation: naya secret turant sign karta hai, purana bhi grace period tak. Header mein do
signatures -- customer jab chahe naya secret deploy kare, ek bhi delivery fail nahi.

## Step 5: Retries, Retry-After, 410, auto-disable

- 5xx/timeout -> schedule (5s, 30s, 2m, ...) + jitter.
- 429 + `Retry-After: 120` -> customer ne bola 2 minute ruko, toh rukte hain.
- 410 Gone -> customer ne bola "mat bhejo" -> endpoint disable.
- 20 lagatar failures -> auto-disable, warna dead endpoint humari capacity khata rahega.

## Step 6: SSRF -- sabse important security point

Webhook URL customer deta hai, request HUMARA server bhejta hai. Agar customer
`http://169.254.169.254/latest/meta-data/` de de toh hum apne hi cloud credentials fetch kar lenge.
`services/ssrf.py`: send ke time DNS resolve karke private/loopback/link-local IPs block. Sirf
registration pe check karna kaafi nahi -- DNS rebinding mein domain baad mein internal IP pe point
kar sakta hai. Redirects follow nahi karte.

## Step 7: Performance investigation (interview story)

`TESTING.md`. 48 deliveries/s se start. Phase timing ne dikhaya HTTP send sirf 1.7ms, baaki sab DB
round trips. Do hypotheses galat nikli (hot row lock sirf partial, WAL fsync bilkul nahi) -- yeh
bolna bhi important hai. Fix: claim query mein hi saara data join karke lao, record ek statement
mein. 111/s with 1 dispatcher, 189/s with 3. Phir CPU 82% -- ab Python process CPU-bound hai,
horizontal scale karo.

## Self-check

1. Outbox pattern kis problem ko solve karta hai?
2. SKIP LOCKED na ho toh 3 dispatchers kaise behave karenge?
3. HTTP call transaction ke andar kyun nahi?
4. Signature mein timestamp kyun? Tolerance kitni aur kyun?
5. Exactly-once webhook delivery possible kyun nahi?
6. SSRF kya hai, DNS rebinding kya hai?
7. Rate limited delivery ka attempt kyun refund kiya?
8. Ordering guarantee kyun nahi di?
