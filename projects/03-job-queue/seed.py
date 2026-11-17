"""Enqueue a demo mix: emails, reports, a flaky job, a poison job, a delayed job, and a schedule.
    python seed.py [base_url] [token]"""
import sys

import httpx

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8003"
h = {"Authorization": f"Bearer {sys.argv[2] if len(sys.argv) > 2 else 'change-me-jq-token'}"}
jobs = [{"type": "email.send", "payload": {"to": f"user{i}@example.com", "subject": "Welcome"}} for i in range(5)]
jobs += [{"type": "report.generate", "queue": "low", "payload": {"seconds": 0.5}},
         {"type": "demo.flaky", "payload": {"succeed_on_attempt": 3}, "backoff_base_seconds": 1},
         {"type": "demo.poison", "max_attempts": 3, "backoff_base_seconds": 1},
         {"type": "email.send", "queue": "critical", "priority": 9, "payload": {"to": "ceo@example.com"}},
         {"type": "report.generate", "delay_seconds": 30}]
for j in jobs:
    r = httpx.post(f"{base}/jobs", json=j, headers=h)
    r.raise_for_status()
    print(r.status_code, j["type"], r.json()["job"]["id"])
httpx.post(f"{base}/schedules", headers=h, json={"name": "heartbeat-report", "interval_seconds": 60,
                                                 "job": {"type": "report.generate", "queue": "low"}}).raise_for_status()
print("schedule heartbeat-report created")
