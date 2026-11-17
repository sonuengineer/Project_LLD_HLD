# Learning Guide (Hinglish) -- flowengine

## Step 1: Problem

"Order aaya -> stock reserve -> payment -> 2 din baad shipping confirm -> nahi hua toh refund." Yeh process
din-bhar chal sakta hai. Server restart ho, deploy ho, worker crash ho -- process ko wahin se continue hona
chahiye jahan ruka tha. Job queue ek-ek job ke liye theek hai; poore multi-step process ka state, timers, signals,
compensation -- yeh sab workflow engine ka kaam hai.

## Step 2: Durable execution = event sourcing + replay

Engine workflow ka state kabhi store nahi karta. Sirf facts likhta hai: "activity 2 complete hui, result X",
"signal approve aaya". Worker naya aaye toh workflow ka code SHURU se chalata hai aur history se results feed
karta hai -- code wahin pahunch jata hai jahan pichhli baar tha (`runtime.py::replay`). Isliye worker crash pe
kuch nahi khota (`test_worker_crash_another_worker_resumes_from_history`).

## Step 3: Determinism -- sabse important rule

Replay tabhi kaam karta hai jab code har baar same commands produce kare. Isliye workflow code mein
`datetime.now()`, `random`, network call mana hai -- `ctx.now()`, `ctx.random()`, activities use karo.
Deploy mein steps ka order badla toh purane workflows ki history match nahi karegi -> NonDeterminismError
(`test_nondeterministic_deploy_is_detected_and_workflow_survives`). Workflow fail nahi hota, ruka rehta hai --
code rollback karo, aage chal padta hai. Nuance: Temporal ki tarah humara check activity TYPE dekhta hai,
arguments nahi.

## Step 4: Events ka order (races)

Signal aur timeout dono history mein hain -- kaun jeeta? Jo history mein pehle record hua. Replay events ko
recorded order mein feed karta hai, isliye har replay mein same jawab (`test_race_*`).

## Step 5: Activities -- retries, timeouts, heartbeats, idempotency

Activity = asli kaam (payment, email). Retry policy: backoff, max attempts, non-retryable errors. Heartbeat:
lambi activity har chunk ke baad "zinda hoon" bolti hai; worker mara toh 0.5s mein pata chal gaya, 30s nahi
(`test_activity_heartbeat_timeout_detects_dead_worker`). Activity at-least-once chalti hai, isliye har activity ko
stable idempotency key milti hai (`workflow_id:seq`) -- effect ek hi baar.

## Step 6: Saga as code

`examples/workflows.py::order_processing`: try/except ke andar compensation (refund, release). Engine durable
hai, toh compensation crash ke baad bhi zaroor chalegi -- hand-written saga ki sabse badi kamzori yahi hoti hai.

## Step 7: Bugs jo tests ne pakde

Cancel ke baad naye futures bhi fail ho rahe the (compensation chal hi nahi sakti thi); stop() ke baad activities
background mein chalti reh rahi thi; graceful stop lease pakad ke chhod deta tha; heartbeat lease galat timeout
se badh raha tha. Har ek ka regression test hai.

## Self-check

1. Workflow vs job queue?
2. Replay kya hai, state store kyun nahi karte?
3. Determinism kyun zaroori, kaun si cheezein mana hain?
4. Signal vs timer race deterministic kaise hai?
5. Heartbeat timeout aur start-to-close timeout mein fark?
6. Activity at-least-once hai -- exactly-once effect kaise?
7. Non-determinism deploy pe kya karoge?
8. Lambi history ka performance problem aur fix (continue-as-new, sticky cache)?
