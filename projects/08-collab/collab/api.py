from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import uuid

from fastapi import APIRouter, Depends, Header, Query, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from sqlalchemy import text

from bpcommon.errors import AppError, Conflict, NotFound, Unauthorized

from . import service
from .realtime import Conn

router = APIRouter()


async def current_user(request: Request, authorization: str | None = Header(default=None)) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise Unauthorized("bearer token required")
    return await service.user_by_token(request.app.state.sm, authorization[7:])


class UserIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.post("/users", status_code=201, tags=["users"])
async def create_user(body: UserIn, request: Request):
    uid, token = await service.create_user(request.app.state.sm, body.name)
    return {"user_id": uid, "token": token}


@router.post("/ws-tickets", tags=["realtime"])
async def ws_ticket(request: Request, user: dict = Depends(current_user)):
    """Browsers can't set Authorization headers on WebSockets, and tokens in URLs end up in logs. So the
    page trades its token for a ONE-TIME ticket that expires in 30s and is consumed on connect."""
    ticket = "wst_" + secrets.token_urlsafe(24)
    await request.app.state.redis.set(f"collab:ticket:{ticket}", json.dumps({"id": str(user["id"]), "name": user["name"]}),
                                      ex=request.app.state.settings.ws_ticket_ttl_seconds)
    return {"ticket": ticket, "expires_in": request.app.state.settings.ws_ticket_ttl_seconds}


class DocIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    content: str = Field(default="", max_length=100_000)


@router.post("/docs", status_code=201, tags=["documents"])
async def create_doc(body: DocIn, request: Request, user: dict = Depends(current_user)):
    return await service.create_document(request.app.state.sm, user["id"], body.title, body.content)


@router.get("/docs", tags=["documents"])
async def my_docs(request: Request, user: dict = Depends(current_user)):
    async with request.app.state.sm() as s:
        rows = (await s.execute(text("SELECT d.id, d.title, d.rev, d.updated_at, p.role FROM documents d JOIN "
                                     "document_permissions p ON p.document_id = d.id WHERE p.user_id = :u "
                                     "ORDER BY d.updated_at DESC"), {"u": user["id"]})).mappings().all()
    return {"documents": [dict(r) for r in rows]}


@router.get("/docs/{doc_id}", tags=["documents"])
async def get_doc(doc_id: uuid.UUID, request: Request, user: dict = Depends(current_user)):
    role = await service.require_role(request.app.state.sm, doc_id, user["id"], "viewer")
    return {**await service.snapshot(request.app.state.sm, doc_id), "role": role}


class ShareIn(BaseModel):
    user_id: uuid.UUID
    role: str = Field(pattern=r"^(editor|viewer)$")


@router.post("/docs/{doc_id}/share", tags=["documents"])
async def share(doc_id: uuid.UUID, body: ShareIn, request: Request, user: dict = Depends(current_user)):
    await service.require_role(request.app.state.sm, doc_id, user["id"], "owner")
    async with request.app.state.sm() as s, s.begin():
        # Never change the owner's row through share (an owner could otherwise demote itself and leave the
        # document with no owner).
        res = await s.execute(text("INSERT INTO document_permissions (document_id, user_id, role) VALUES (:d, :u, :r) "
                                   "ON CONFLICT (document_id, user_id) DO UPDATE SET role = EXCLUDED.role "
                                   "WHERE document_permissions.role <> 'owner' RETURNING role"),
                              {"d": doc_id, "u": body.user_id, "r": body.role})
        if res.first() is None:
            raise Conflict("the owner's access cannot be changed")
    # Tell every server, so open sockets of that user switch role now (submit() re-checks anyway).
    await request.app.state.hub.publish(str(doc_id), {"type": "perm", "user_id": str(body.user_id), "role": body.role})
    return {"document_id": doc_id, "user_id": body.user_id, "role": body.role}


@router.delete("/docs/{doc_id}/share/{user_id}", tags=["documents"])
async def unshare(doc_id: uuid.UUID, user_id: uuid.UUID, request: Request, user: dict = Depends(current_user)):
    """Revoke access. Open WebSockets of that user are closed on every server; their next op is rejected
    by the sequencer even if that notification is lost."""
    await service.require_role(request.app.state.sm, doc_id, user["id"], "owner")
    async with request.app.state.sm() as s, s.begin():
        role = await service.role_of(s, doc_id, user_id)
        if role is None:
            raise NotFound("user has no access to this document")
        if role == "owner":
            raise Conflict("the owner's access cannot be revoked")
        await s.execute(text("DELETE FROM document_permissions WHERE document_id = :d AND user_id = :u"),
                        {"d": doc_id, "u": user_id})
    await request.app.state.hub.publish(str(doc_id), {"type": "perm", "user_id": str(user_id), "role": None})
    return {"document_id": doc_id, "user_id": user_id, "revoked": True}


@router.get("/docs/{doc_id}/history", tags=["history"])
async def doc_history(doc_id: uuid.UUID, request: Request, user: dict = Depends(current_user),
                      limit: int = Query(100, ge=1, le=1000), before: int | None = None):
    await service.require_role(request.app.state.sm, doc_id, user["id"], "viewer")
    return {"history": await service.history(request.app.state.sm, doc_id, limit, before)}


@router.get("/docs/{doc_id}/revisions/{rev}", tags=["history"])
async def at_revision(doc_id: uuid.UUID, rev: int, request: Request, user: dict = Depends(current_user)):
    await service.require_role(request.app.state.sm, doc_id, user["id"], "viewer")
    return {"rev": rev, "content": await service.content_at(request.app.state.sm, doc_id, rev)}


@router.post("/docs/{doc_id}/restore/{rev}", tags=["history"])
async def restore(doc_id: uuid.UUID, rev: int, request: Request, user: dict = Depends(current_user)):
    """Restore = a NEW edit that turns the current text into the old text (history is never rewritten);
    it flows through the normal sequencer so connected editors see it live."""
    sm, st = request.app.state.sm, request.app.state.settings
    await service.require_role(sm, doc_id, user["id"], "editor")
    old = await service.content_at(sm, doc_id, rev)
    snap = await service.snapshot(sm, doc_id)
    op = service.restore_op(snap["content"], old)
    client_id = f"restore-{uuid.uuid4().hex[:8]}"
    applied = await service.submit(sm, st, doc_id, user["id"], client_id, 1, snap["rev"], op.to_json())
    await request.app.state.hub.publish(str(doc_id), {"type": "op", "rev": applied.rev, "op": applied.op.to_json(),
                                                      "user_id": str(user["id"]), "client_id": client_id, "client_seq": 1})
    return {"restored_from": rev, "new_rev": applied.rev}


@router.get("/docs/{doc_id}/presence", tags=["realtime"])
async def presence(doc_id: uuid.UUID, request: Request, user: dict = Depends(current_user)):
    await service.require_role(request.app.state.sm, doc_id, user["id"], "viewer")
    return {"presence": await request.app.state.hub.presence(str(doc_id))}


@router.get("/stats", tags=["ops"])
async def stats(request: Request):
    hub = request.app.state.hub
    return {"server_id": request.app.state.settings.server_id, **hub.stats,
            "rooms": {d: len(r.conns) for d, r in hub.rooms.items()}}


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket, ticket: str = Query(...)):
    app = ws.app
    raw = await app.state.redis.getdel(f"collab:ticket:{ticket}")      # one-time use
    if raw is None:
        await ws.close(code=4401, reason="invalid or expired ticket")
        return
    user = json.loads(raw)
    await ws.accept()
    hub = app.state.hub
    conn: Conn | None = None
    writer: asyncio.Task | None = None

    async def write_loop(c: Conn):
        while True:
            msg = await c.queue.get()
            await ws.send_text(json.dumps(msg, default=str))

    try:
        first = json.loads(await ws.receive_text())
        if first.get("type") != "join" or not first.get("doc_id") or not first.get("client_id"):
            await ws.close(code=4400, reason="first message must be join{doc_id, client_id}")
            return
        doc_id = str(uuid.UUID(first["doc_id"]))
        try:
            role = await service.require_role(app.state.sm, doc_id, user["id"], "viewer")
        except AppError as exc:
            await ws.send_text(json.dumps({"type": "error", "code": exc.code, "message": exc.message}))
            await ws.close(code=4403)
            return
        # client_id is chosen by the client and broadcast to everyone in op messages. Namespacing it with the
        # authenticated user id means nobody can reuse another user's client_id to steal their acks or make
        # their ops look like duplicates (dedupe key is (document_id, client_id, client_seq)).
        client_id = f"{user['id']}:{str(first['client_id'])[:64]}"
        conn = Conn(ws, user["id"], user["name"], client_id, role)
        closing: set[asyncio.Task] = set()

        def kick(code: int, reason: str) -> None:
            t = asyncio.create_task(ws.close(code=code, reason=reason))
            closing.add(t)
            t.add_done_callback(lambda _t: closing.discard(_t))
            t.add_done_callback(lambda _t: _t.cancelled() or _t.exception())   # already-closed is fine
        conn.on_kick = kick
        writer = asyncio.create_task(write_loop(conn))
        await hub.join(conn, doc_id, first.get("last_rev"))
        while not conn.closed:
            msg = json.loads(await ws.receive_text())
            t = msg.get("type")
            if t == "op":
                if service.ROLES[conn.role] < service.ROLES["editor"]:
                    conn.send({"type": "error", "code": "forbidden", "message": "viewers cannot edit",
                               "client_seq": msg.get("client_seq")})
                    continue
                try:
                    applied = await service.submit(app.state.sm, app.state.settings, doc_id, conn.user_id,
                                                   conn.client_id, int(msg["client_seq"]), int(msg["base_rev"]), msg["op"])
                except AppError as exc:
                    conn.send({"type": "error", "code": exc.code, "message": exc.message, "client_seq": msg.get("client_seq")})
                    continue
                if not applied.duplicate:
                    await hub.publish(doc_id, {"type": "op", "rev": applied.rev, "op": applied.op.to_json(),
                                               "user_id": conn.user_id, "client_id": conn.client_id,
                                               "client_seq": int(msg["client_seq"])})
                # Duplicate (resent after a lost ack): already in history; the ordered stream / catch-up
                # delivers it to this client as an ack.
            elif t == "cursor":
                cursor = {"position": int(msg.get("position", 0)), "selection_end": msg.get("selection_end"),
                          "rev": int(msg.get("rev", 0))}
                await hub.touch(conn, cursor)
                await hub.publish(doc_id, {"type": "cursor", "conn_id": conn.conn_id, "user_id": conn.user_id,
                                           "name": conn.user_name, **cursor})
            elif t == "ping":
                await hub.touch(conn)
                conn.send({"type": "pong"})
    except (WebSocketDisconnect, RuntimeError):
        pass
    except (ValueError, KeyError, TypeError):
        with contextlib.suppress(Exception):
            await ws.close(code=4400, reason="malformed message")
    finally:
        if writer:
            writer.cancel()
        if conn is not None:
            await hub.leave(conn)
