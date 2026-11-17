# Learning Guide (Hinglish) -- Payment System

## Step 1: Payments mein sabse bada dar

Do hi galtiyan unforgivable hain: (1) customer ka paisa kata aur order nahi bana, (2) do baar paisa kata.
Poora project in dono ko rokne ke baare mein hai.

## Step 2: Idempotency key

Mobile app ne "Pay" dabaya, network gaya, app ne retry kiya. Bina idempotency ke = double charge.
`services/idempotency.py`: same key + same body -> purana response replay; same key + alag body -> 422;
pehli request abhi chal rahi hai -> 409. Test: `test_idempotency_key_semantics` -- provider pe sirf 1
authorization. Provider ko bhi hum deterministic key bhejte hain (`auth-{payment_id}`), toh humara retry
bhi safe.

## Step 3: State machine aur intermediate states

`services/state.py`. `authorized -> capturing -> captured`. "capturing" pehle DB mein likhte hain, phir
provider ko call karte hain (transaction ke BAHAR), phir result likhte hain. Beech mein crash? Payment
"capturing" mein atka dikhega -> recovery worker same idempotency key se capture retry karega -> kaam ek
hi baar hoga (`test_crash_mid_capture_is_completed_by_recovery_exactly_once`). Har transition
compare-and-set hai: `UPDATE ... WHERE status IN (expected)` -- do parallel captures mein se ek hi jeetega.

## Step 4: Timeout ka matlab "pata nahi"

Provider ne 1 second mein jawab nahi diya. Fail maan liya toh customer ka paisa kat chuka ho sakta hai
(`tok_slow` exactly yahi karta hai). Isliye: same key se retry (aksar wahi solve kar deta hai), warna
`requires_reconciliation` aur recovery provider se poochhega "reference X ka kya hua?".

## Step 5: Double-entry ledger

Har paise ki movement ke kam se kam do entries, jinka sum 0. Capture 10,000 (fee 320): receivable +10000,
merchant payable -9680, fee revenue -320. Database trigger commit ke time check karta hai sum 0 hai -- code
mein bug ho toh bhi unbalanced entry save nahi hogi. Entries kabhi update/delete nahi hoti; galti sudharni
ho toh reverse entry. Balance hamesha entries ka sum -- alag "balance" column nahi jo drift kare.

## Step 6: Money = integer

49.99 rupaye = 4999 paise. Float mein 0.1+0.2 != 0.3. Fee calculation `Decimal` se, half-up rounding.

## Step 7: Webhooks, recovery, reconciliation -- teen safety nets

- Webhook: provider khud batata hai "captured hua" (kabhi humare response se pehle bhi). Dedupe by event id.
- Recovery: atke hue payments resolve.
- Reconciliation: roz provider ki settlement report se match -- chargeback, manual adjustment, missed
  webhook sab pakde jaate hain (`test_reconciliation_finds_drift_and_unrecorded_charges`).

## Step 8: Saga (distributed transaction bina 2PC)

Checkout = stock reserve -> payment -> shipment. Shipment fail -> refund + stock release (compensation),
reverse order mein. 2PC third-party provider ke saath possible hi nahi.

## Self-check

1. Idempotency key ke 3 cases aur response codes?
2. Provider call DB transaction ke andar kyun nahi?
3. Timeout ko failure maanne se kya hota hai?
4. Double-entry ledger ka invariant kya hai, kahan enforce hota hai?
5. Do parallel refunds over-refund kaise kar sakte the, kaise roka?
6. Webhook response se pehle aa jaye toh?
7. Reconciliation kya pakadta hai jo baaki mechanisms nahi pakadte?
8. Saga vs 2PC?
