"""Demo CONSUMER of webhooks: what a customer's server should do.

1. Verify the signature over the RAW body (before JSON parsing) with constant-time compare.
2. Reject stale timestamps (replay protection).
3. Dedupe on webhook-id (we deliver at-least-once; retries reuse the same id).
4. Return 2xx fast; do slow work asynchronously (here: just record it).
"""
from __future__ import annotations

import os

from fastapi import FastAPI, Request, Response

from ..services.signing import VerificationError, verify

app = FastAPI(title="Demo webhook receiver")
app.state.secrets = [s for s in os.getenv("RECEIVER_SECRETS", "").split(",") if s]
app.state.seen: dict[str, dict] = {}
app.state.duplicates = 0
app.state.fail_next = 0          # test knob: return 500 for the next N requests


@app.post("/webhook")
async def webhook(request: Request) -> Response:
    raw = await request.body()
    try:
        verify(app.state.secrets, dict(request.headers), raw)
    except VerificationError as exc:
        return Response(f"invalid signature: {exc}", status_code=401)
    if app.state.fail_next > 0:
        app.state.fail_next -= 1
        return Response("temporary failure", status_code=500)
    msg_id = request.headers["webhook-id"]
    if msg_id in app.state.seen:
        app.state.duplicates += 1
        return Response("duplicate ignored", status_code=200)   # 2xx so the sender stops retrying
    import json
    app.state.seen[msg_id] = json.loads(raw)
    return Response("ok", status_code=200)


@app.post("/admin/config")
async def config(body: dict):
    if "secrets" in body:
        app.state.secrets = body["secrets"]
    if "fail_next" in body:
        app.state.fail_next = int(body["fail_next"])
    return {"secrets": len(app.state.secrets), "fail_next": app.state.fail_next}


@app.get("/admin/received")
async def received():
    return {"count": len(app.state.seen), "duplicates": app.state.duplicates, "ids": list(app.state.seen)}
