"""Walk through the payment lifecycle against a running stack (mock provider, test money).
    python demo.py http://127.0.0.1:58009 [admin_token]"""
import sys
import time
import uuid

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8009"
ADMIN = {"x-admin-token": sys.argv[2] if len(sys.argv) > 2 else "change-me-pay-admin"}
c = httpx.Client(base_url=BASE, timeout=30)
m = c.post("/admin/merchants", json={"name": "Demo Shop"}, headers=ADMIN).json()
c.headers["Authorization"] = f"Bearer {m['api_key']}"


def pay(token, capture=True, amount=49_900):
    ref = f"order-{uuid.uuid4().hex[:6]}"
    return c.post("/payments", json={"amount": amount, "currency": "INR", "payment_method": token, "merchant_reference": ref,
                                     "capture": capture}, headers={"Idempotency-Key": ref}).json()


ok = pay("tok_visa")
print("visa:", ok["status"], "fee", ok["fee"])
print("declined:", pay("tok_declined")["status"])
r = c.post(f"/payments/{ok['id']}/refunds", json={"amount": 10_000}, headers={"Idempotency-Key": "demo-refund"}).json()
print("partial refund:", r["status"])
slow = pay("tok_slow", capture=False)
print("slow provider:", slow["status"], "(retried with the same idempotency key)")
time.sleep(1)
print("ledger:", c.get("/ledger/balances").json()["balances"])
print("trial balance:", c.get("/admin/ledger/trial-balance", headers=ADMIN).json())
print("dashboard:", BASE + "/dashboard  (paste the merchant key)", m["api_key"])
