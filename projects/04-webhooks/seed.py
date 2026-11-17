"""Register the demo receiver, publish events, show what arrived.
    python seed.py [api_base] [receiver_base] [token] [n_events]"""
import sys
import time

import httpx

api = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8004"
rcv = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:9000"
h = {"Authorization": f"Bearer {sys.argv[3] if len(sys.argv) > 3 else 'change-me-wh-token'}"}
n = int(sys.argv[4]) if len(sys.argv) > 4 else 20
ep = httpx.post(f"{api}/endpoints", headers=h, json={"url": "http://receiver:9000/webhook", "event_types": ["*"],
                                                    "rate_limit_per_second": 500}).json()
httpx.post(f"{rcv}/admin/config", json={"secrets": [ep["secret"]], "fail_next": 3})  # first 3 deliveries fail
print("endpoint", ep["id"])
t0 = time.time()
with httpx.Client(headers=h, timeout=30) as c:
    for i in range(n):
        c.post(f"{api}/events", json={"type": "order.paid", "payload": {"order": i}}).raise_for_status()
print(f"published {n} events in {time.time() - t0:.2f}s")
t1 = time.time()
while True:
    st = httpx.get(f"{api}/stats", headers=h).json()["deliveries"]
    if st.get("succeeded", 0) >= n:
        break
    if time.time() - t1 > 300:
        print("timeout", st)
        break
    time.sleep(0.2)
el = time.time() - t1
print(f"all {n} delivered+verified in {el:.2f}s ({n / el:.0f}/s); stats={st}")
print("receiver:", {k: v for k, v in httpx.get(f"{rcv}/admin/received").json().items() if k != "ids"})
