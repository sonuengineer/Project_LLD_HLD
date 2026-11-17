"""Create demo API keys, one per plan. Usage: python seed.py [base_url] [admin_token]"""
import sys

import httpx

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8001"
token = sys.argv[2] if len(sys.argv) > 2 else "change-me-admin-token"
for user, plan in [("demo-free", "free"), ("demo-pro", "pro"), ("demo-enterprise", "enterprise")]:
    r = httpx.post(f"{base}/admin/api-keys", json={"user_id": user, "plan": plan}, headers={"X-Admin-Token": token})
    r.raise_for_status()
    print(f"{plan:<11} {r.json()['api_key']}")
