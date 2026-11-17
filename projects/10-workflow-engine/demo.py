"""Run all five example workflows through the HTTP API.  python demo.py http://127.0.0.1:58010"""
import sys
import time
import uuid

import httpx

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8010"
c = httpx.Client(base_url=B, timeout=30)
tag = uuid.uuid4().hex[:5]


def start(t, wid, inp):
    c.post("/workflows", json={"workflow_type": t, "workflow_id": f"{wid}-{tag}", "input": inp}).raise_for_status()
    return f"{wid}-{tag}"


def wait(wid, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        d = c.get(f"/workflows/{wid}").json()
        if d["status"] != "running":
            return d
        time.sleep(0.2)
    return c.get(f"/workflows/{wid}").json()


def wait_event(wid, event_type, count=1):
    for _ in range(100):
        if [e["event_type"] for e in c.get(f"/workflows/{wid}/history").json()["events"]].count(event_type) >= count:
            return
        time.sleep(0.1)


o1 = start("order_processing", "order-ok", {"order_id": "A1", "items": ["book"], "amount": 499, "customer": "a@x.io"})
o2 = start("order_processing", "order-shipfail", {"order_id": "A2", "items": ["pen"], "amount": 99, "fail_shipping": True, "customer": "b@x.io"})
p1 = start("payment_and_refund", "pay", {"amount": 250, "delivery_timeout": 2})
n1 = start("customer_onboarding", "onboard", {"email": "new@x.io", "verify_within": 1, "tips_after": 1})
d1 = start("document_approval", "approval", {"doc_id": "Q3-plan", "approvers": "finance", "escalation_to": "cfo", "escalate_after": 1})
e1 = start("email_campaign", "campaign", {"recipients": [f"u{i}@x.io" for i in range(8)] + ["bounce@x.io"], "batch_size": 4,
                                          "pause": 0.5, "template": "newsletter"})
wait_event(d1, "ActivityCompleted", 2)
c.post(f"/workflows/{d1}/signals/decision", json={"payload": {"approved": True, "by": "cfo"}})
for wid in (o1, o2, p1, n1, d1, e1):
    d = wait(wid)
    print(f"{d['workflow_type']:<20} {d['status']:<10} {d['result']}")
print("dashboard:", B + "/dashboard")
