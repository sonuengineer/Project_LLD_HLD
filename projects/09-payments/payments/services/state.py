"""Payment state machine. Every status change goes through transition(): it is an UPDATE ... WHERE status IN
(expected) -- a compare-and-set -- plus an append-only payment_events row, in the caller's transaction."""
from __future__ import annotations

import json

from sqlalchemy import text

from bpcommon.errors import AppError

TRANSITIONS: dict[str, set[str]] = {
    "created": {"authorizing"},
    "authorizing": {"authorized", "declined", "failed", "requires_reconciliation"},
    "authorized": {"capturing", "voiding"},
    "capturing": {"captured", "authorized", "requires_reconciliation"},
    "voiding": {"voided", "authorized", "requires_reconciliation"},
    "captured": {"partially_refunded", "refunded"},
    "partially_refunded": {"partially_refunded", "refunded"},
    "requires_reconciliation": {"authorized", "captured", "declined", "failed", "voided"},
    "declined": set(), "failed": set(), "voided": set(), "refunded": set(),
}
TERMINAL = {"declined", "failed", "voided", "refunded"}


class InvalidTransition(AppError):
    status_code, code = 409, "invalid_state_transition"


async def transition(s, payment_id, expected: set[str], to: str, reason: str, data: dict | None = None,
                     **updates) -> dict:
    for f in expected:
        if to not in TRANSITIONS[f]:
            raise AssertionError(f"illegal transition {f} -> {to}")   # programming error, not user error
    sets = ", ".join(f"{k} = :{k}" for k in updates)
    row = (await s.execute(text(
        f"UPDATE payments SET status = :to, version = version + 1, updated_at = now(){', ' + sets if sets else ''} "
        "WHERE id = :id AND status = ANY(:exp) RETURNING *, (SELECT status FROM payments WHERE id = :id) AS _old"),
        {"to": to, "id": payment_id, "exp": list(expected), **updates})).mappings().first()
    if row is None:
        current = await s.scalar(text("SELECT status FROM payments WHERE id = :id"), {"id": payment_id})
        raise InvalidTransition(f"payment is {current}; expected one of {sorted(expected)} to move to {to}",
                                details={"status": current})
    await s.execute(text("INSERT INTO payment_events (payment_id, from_status, to_status, reason, data) "
                         "VALUES (:p, :f, :t, :r, CAST(:d AS jsonb))"),
                    {"p": payment_id, "f": row["_old"], "t": to, "r": reason, "d": json.dumps(data or {}, default=str)})
    return {k: v for k, v in row.items() if k != "_old"}
