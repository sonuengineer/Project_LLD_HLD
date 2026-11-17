"""Demo data: two tenants, members with different roles, projects, an API key, an upgrade.
    python seed.py [base_url]"""
import sys

import httpx

B = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8006"
PW = "demo-password-123"
c = httpx.Client(base_url=B, timeout=30)


def login(email):
    c.post("/auth/register", json={"email": email, "password": PW})
    return {"Authorization": "Bearer " + c.post("/auth/login", json={"email": email, "password": PW}).json()["access_token"]}


admin = login("admin@platform.local")
alice, bob, carol = login("alice@acme.test"), login("bob@globex.test"), login("carol@acme.test")
c.post("/tenants", json={"slug": "acme", "name": "Acme Inc"}, headers=alice)
c.post("/tenants", json={"slug": "globex", "name": "Globex"}, headers=bob)
inv = c.post("/t/acme/invitations", json={"email": "carol@acme.test", "role": "member"}, headers=alice).json()
c.post("/invitations/accept", json={"token": inv["token"]}, headers=carol)
for n in ("website", "mobile-app"):
    c.post("/t/acme/projects", json={"name": n}, headers=alice)
c.post("/t/acme/projects", json={"name": "carol-experiment"}, headers=carol)
c.post("/t/globex/projects", json={"name": "globex-secret"}, headers=bob)
key = c.post("/t/acme/api-keys", json={"name": "ci", "scopes": ["project:read"]}, headers=alice).json()
sess = c.post("/t/acme/billing/checkout", json={"plan": "pro"}, headers=alice).json()
c.post(f"/billing/mock/checkout/{sess['checkout_session']}/complete")
print("acme plan:", c.get("/t/acme", headers=alice).json()["plan"])
print("acme projects:", [p["name"] for p in c.get("/t/acme/projects", headers=alice).json()["projects"]])
print("bob sees acme?", c.get("/t/acme/projects", headers=bob).status_code)
print("CI key reads acme:", c.get("/t/acme/projects", headers={"Authorization": f"Bearer {key['api_key']}"}).status_code)
r = c.get("/admin/tenants", headers=admin)
print("platform tenants:", [t["slug"] for t in r.json()["tenants"]] if r.status_code == 200 else
      "run `python -m saas.cli promote admin@platform.local` first (admin is an operator grant)")
