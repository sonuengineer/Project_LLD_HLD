import contextlib

import httpx

from saas.config import Settings
from saas.main import create_app

from .conftest import APP_URL, REDIS_URL


@contextlib.asynccontextmanager
async def client(**overrides):
    cfg = dict(database_url=APP_URL, redis_url=REDIS_URL, bcrypt_rounds=4, log_json=False, log_level="WARNING",
               platform_admin_emails=["root@platform.io"], cache_ttl_seconds=60)
    cfg.update(overrides)
    app = create_app(Settings(**cfg))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://saas") as c:
            c.app = app
            yield c


async def user(c, email, password="correct horse battery", name=""):
    await c.post("/auth/register", json={"email": email, "password": password, "full_name": name})
    r = await c.post("/auth/login", json={"email": email, "password": password})
    tok = r.json()
    return {"Authorization": f"Bearer {tok['access_token']}"}, tok


async def tenant(c, headers, slug):
    r = await c.post("/tenants", json={"slug": slug, "name": slug.title()}, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


async def join(c, owner_h, slug, email, role):
    h, _ = await user(c, email)
    inv = (await c.post(f"/t/{slug}/invitations", json={"email": email, "role": role}, headers=owner_h)).json()
    r = await c.post("/invitations/accept", json={"token": inv["token"]}, headers=h)
    assert r.status_code == 200, r.text
    return h
