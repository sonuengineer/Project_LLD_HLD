"""Reconciliation: compare OUR records (payments + ledger) with the provider's settlement report for a day.

Why: every integration drifts eventually -- lost webhooks, timeouts, manual adjustments at the provider,
chargebacks, bugs. Reconciliation is the safety net that turns "we think" into "we verified".
Item kinds: matched | missing_internally | missing_at_provider | amount_mismatch | status_mismatch | ledger_mismatch
"""
from __future__ import annotations

import json
from datetime import date

from sqlalchemy import text

PROVIDER_TO_OURS = {"authorized": {"authorized"}, "captured": {"captured", "partially_refunded", "refunded"},
                    "voided": {"voided"}, "declined": {"declined"}}


async def run(sm, provider, day: date) -> dict:
    theirs = await provider.settlements(day.isoformat())
    async with sm() as s:
        ours = {r["provider_payment_id"]: dict(r) for r in (await s.execute(text(
            "SELECT id, provider_payment_id, status, amount_captured, amount_refunded, created_at FROM payments "
            "WHERE provider_payment_id IS NOT NULL AND created_at::date = :d"), {"d": day})).mappings().all()}
        booked = {r["payment_id"]: int(r["amount"]) for r in (await s.execute(text(
            "SELECT t.payment_id, sum(e.amount) AS amount FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id "
            "JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = 'provider_receivable' GROUP BY t.payment_id"))).mappings().all()}
        run_id = await s.scalar(text("INSERT INTO reconciliation_runs (settlement_date) VALUES (:d) RETURNING id"), {"d": day})
        await s.commit()
    items = []
    seen = set()
    for t in theirs:
        o = ours.get(t["id"])
        seen.add(t["id"])
        if o is None:
            items.append(("missing_internally", None, t["id"], None, t))
            continue
        if o["status"] not in PROVIDER_TO_OURS.get(t["status"], {t["status"]}):
            items.append(("status_mismatch", o["id"], t["id"], o, t))
        elif o["amount_captured"] != t["captured"] or o["amount_refunded"] != t["refunded"]:
            items.append(("amount_mismatch", o["id"], t["id"], o, t))
        elif booked.get(o["id"], 0) != t["captured"] - t["refunded"]:
            items.append(("ledger_mismatch", o["id"], t["id"], {**o, "ledger_receivable": booked.get(o["id"], 0)}, t))
        else:
            items.append(("matched", o["id"], t["id"], o, t))
    for pid, o in ours.items():
        if pid not in seen:
            items.append(("missing_at_provider", o["id"], pid, o, None))
    summary: dict[str, int] = {}
    async with sm() as s, s.begin():
        for kind, payment_id, provider_id, o, t in items:
            summary[kind] = summary.get(kind, 0) + 1
            await s.execute(text("INSERT INTO reconciliation_items (run_id, kind, payment_id, provider_payment_id, ours, theirs) "
                                 "VALUES (:r, :k, :p, :pp, CAST(:o AS jsonb), CAST(:t AS jsonb))"),
                            {"r": run_id, "k": kind, "p": payment_id, "pp": provider_id,
                             "o": json.dumps(o, default=str) if o else None, "t": json.dumps(t) if t else None})
        await s.execute(text("UPDATE reconciliation_runs SET finished_at = now(), summary = CAST(:s AS jsonb) WHERE id = :r"),
                        {"s": json.dumps(summary), "r": run_id})
    return {"run_id": run_id, "date": day.isoformat(), "summary": summary}
