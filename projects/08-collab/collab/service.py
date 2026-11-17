"""Documents, permissions, the OT sequencer, history.

submit(): the heart of the system.
  1. lock the document row (SELECT ... FOR UPDATE)  -> one total order per document across ALL servers
  2. dedupe (client_id, client_seq)                  -> safe resend after a lost ack
  3. load ops with rev > base_rev and transform the incoming op against them ONE BY ONE
     (same sequence the client sees; transform does not distribute over compose -- see tests/test_ot.py)
  4. apply, store op at rev = head + 1, update content, snapshot every N revisions, commit
The transformed op is what everyone else receives.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass

from sqlalchemy import text

from bpcommon.errors import AppError, Forbidden, NotFound, Unauthorized

from .ot import OTError, TextOp, apply, diff_op, transform

ROLES = {"viewer": 0, "editor": 1, "owner": 2}


class InvalidOperation(AppError):
    status_code, code = 400, "invalid_operation"


@dataclass
class Applied:
    rev: int
    op: TextOp
    duplicate: bool = False


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def create_user(sm, name: str) -> tuple[uuid.UUID, str]:
    token = "ct_" + secrets.token_urlsafe(24)
    async with sm() as s, s.begin():
        uid = await s.scalar(text("INSERT INTO users (name, token_hash) VALUES (:n, :h) RETURNING id"),
                             {"n": name, "h": token_hash(token)})
    return uid, token


async def user_by_token(sm, token: str) -> dict:
    async with sm() as s:
        row = (await s.execute(text("SELECT id, name FROM users WHERE token_hash = :h"), {"h": token_hash(token)})).mappings().first()
    if row is None:
        raise Unauthorized("invalid token")
    return dict(row)


async def create_document(sm, owner_id, title: str, content: str = "") -> dict:
    async with sm() as s, s.begin():
        row = (await s.execute(text("INSERT INTO documents (title, owner_id, content) VALUES (:t, :o, :c) "
                                    "RETURNING id, title, rev, created_at"), {"t": title, "o": owner_id, "c": content})).mappings().one()
        await s.execute(text("INSERT INTO document_permissions (document_id, user_id, role) VALUES (:d, :u, 'owner')"),
                        {"d": row["id"], "u": owner_id})
        await s.execute(text("INSERT INTO snapshots (document_id, rev, content) VALUES (:d, 0, :c)"),
                        {"d": row["id"], "c": content})
    return dict(row)


async def role_of(s, doc_id, user_id) -> str | None:
    return await s.scalar(text("SELECT role FROM document_permissions WHERE document_id = :d AND user_id = :u"),
                          {"d": doc_id, "u": user_id})


async def require_role(sm, doc_id, user_id, minimum: str) -> str:
    async with sm() as s:
        exists = await s.scalar(text("SELECT 1 FROM documents WHERE id = :d"), {"d": doc_id})
        role = await role_of(s, doc_id, user_id) if exists else None
    if role is None:
        raise NotFound("document not found")     # don't reveal documents you can't see
    if ROLES[role] < ROLES[minimum]:
        raise Forbidden(f"requires {minimum} access", details={"role": role})
    return role


async def snapshot(sm, doc_id) -> dict:
    async with sm() as s:
        row = (await s.execute(text("SELECT id, title, content, rev FROM documents WHERE id = :d"), {"d": doc_id})).mappings().first()
    if row is None:
        raise NotFound("document not found")
    return dict(row)


async def ops_between(sm, doc_id, after_rev: int, upto_rev: int | None = None) -> list[dict]:
    q = "SELECT rev, op, user_id, client_id, client_seq FROM operations WHERE document_id = :d AND rev > :a"
    params = {"d": doc_id, "a": after_rev}
    if upto_rev is not None:
        q += " AND rev <= :u"
        params["u"] = upto_rev
    async with sm() as s:
        rows = (await s.execute(text(q + " ORDER BY rev"), params)).mappings().all()
    return [{"rev": r["rev"], "op": r["op"], "user_id": str(r["user_id"]), "client_id": r["client_id"],
             "client_seq": r["client_seq"]} for r in rows]


async def submit(sm, settings, doc_id, user_id, client_id: str, client_seq: int, base_rev: int, raw_op) -> Applied:
    try:
        op = TextOp.from_json(raw_op)
    except OTError as exc:
        raise InvalidOperation(str(exc)) from None
    if len(op.ops) > settings.max_op_components:
        raise InvalidOperation("operation too large")
    async with sm() as s, s.begin():
        doc = (await s.execute(text("SELECT content, rev FROM documents WHERE id = :d FOR UPDATE"), {"d": doc_id})).first()
        if doc is None:
            raise NotFound("document not found")
        # Authoritative permission check, under the document lock. The WebSocket layer caches the role from
        # join time (fast path) and is told about changes over pub/sub, but pub/sub is at-most-once -- so a
        # revoked editor must be rejected HERE, not only when the "perm" event happens to arrive.
        role = await role_of(s, doc_id, user_id)
        if role is None or ROLES[role] < ROLES["editor"]:
            raise Forbidden("requires editor access", details={"role": role})
        dup = await s.scalar(text("SELECT rev FROM operations WHERE document_id = :d AND client_id = :c AND client_seq = :q"),
                             {"d": doc_id, "c": client_id, "q": client_seq})
        if dup is not None:
            return Applied(dup, op, duplicate=True)
        if base_rev < 0 or base_rev > doc.rev:
            raise InvalidOperation(f"base revision {base_rev} is not in [0, {doc.rev}]")
        history = (await s.execute(text("SELECT op FROM operations WHERE document_id = :d AND rev > :b ORDER BY rev"),
                                   {"d": doc_id, "b": base_rev})).scalars().all()
        try:
            for h in history:
                op = transform(op, TextOp.from_json(h))[0]
            content = apply(doc.content, op)
        except OTError as exc:
            raise InvalidOperation(f"operation does not apply at revision {base_rev}: {exc}") from None
        if len(content) > settings.max_document_chars:
            raise InvalidOperation("document too large")
        rev = doc.rev + 1
        await s.execute(text("INSERT INTO operations (document_id, rev, op, user_id, client_id, client_seq) "
                             "VALUES (:d, :r, CAST(:o AS jsonb), :u, :c, :q)"),
                        {"d": doc_id, "r": rev, "o": json.dumps(op.to_json()), "u": user_id, "c": client_id, "q": client_seq})
        await s.execute(text("UPDATE documents SET content = :c, rev = :r, updated_at = now() WHERE id = :d"),
                        {"c": content, "r": rev, "d": doc_id})
        if rev % settings.snapshot_every == 0:
            await s.execute(text("INSERT INTO snapshots (document_id, rev, content) VALUES (:d, :r, :c)"),
                            {"d": doc_id, "r": rev, "c": content})
    return Applied(rev, op)


async def heads(sm, doc_ids: list[str]) -> dict[str, int]:
    """Current revision of several documents in one query (used by the hub's tail check)."""
    if not doc_ids:
        return {}
    async with sm() as s:
        rows = (await s.execute(text("SELECT id::text, rev FROM documents WHERE id::text = ANY(:ids)"), {"ids": doc_ids})).all()
    return {r[0]: r[1] for r in rows}


async def content_at(sm, doc_id, rev: int) -> str:
    """Version history: nearest snapshot <= rev, then replay the op log."""
    async with sm() as s:
        snap = (await s.execute(text("SELECT rev, content FROM snapshots WHERE document_id = :d AND rev <= :r "
                                     "ORDER BY rev DESC LIMIT 1"), {"d": doc_id, "r": rev})).first()
        head = await s.scalar(text("SELECT rev FROM documents WHERE id = :d"), {"d": doc_id})
    if snap is None or head is None or rev > head:
        raise NotFound("revision not found")
    content = snap.content
    for o in await ops_between(sm, doc_id, snap.rev, rev):
        content = apply(content, TextOp.from_json(o["op"]))
    return content


async def history(sm, doc_id, limit: int = 100, before: int | None = None) -> list[dict]:
    q = ("SELECT o.rev, o.created_at, o.client_id, u.name AS user_name, o.op FROM operations o JOIN users u ON u.id = o.user_id "
         "WHERE o.document_id = :d")
    params = {"d": doc_id, "l": limit}
    if before is not None:
        q += " AND o.rev < :b"
        params["b"] = before
    async with sm() as s:
        rows = (await s.execute(text(q + " ORDER BY o.rev DESC LIMIT :l"), params)).mappings().all()
    out = []
    for r in rows:
        op = TextOp.from_json(r["op"])
        out.append({"rev": r["rev"], "at": r["created_at"], "user": r["user_name"], "client_id": r["client_id"],
                    "chars_inserted": sum(len(c) for c in op.ops if isinstance(c, str)),
                    "chars_deleted": -sum(c for c in op.ops if isinstance(c, int) and c < 0)})
    return out


def restore_op(current: str, old: str) -> TextOp:
    return diff_op(current, old)
