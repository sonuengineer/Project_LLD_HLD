"""Double-entry ledger. Every money movement is a transaction of >= 2 entries summing to ZERO
(debit positive, credit negative). The database enforces the sum (deferred constraint trigger) and
immutability (no UPDATE/DELETE). Balances are always derived from entries, never stored separately.

Accounts (per merchant + currency):
    provider_receivable   asset: money the provider owes us for captured payments
    merchant_payable      liability: money we owe the merchant
    platform_fee_revenue  revenue: our fees
Capture of 1000 with fee 59:   provider_receivable +1000 | merchant_payable -941 | platform_fee_revenue -59
Refund of 300:                 merchant_payable +300     | provider_receivable -300
"""
from __future__ import annotations

from sqlalchemy import text


async def _account(s, code: str, merchant_id, currency: str):
    aid = await s.scalar(text("SELECT id FROM ledger_accounts WHERE code = :c AND merchant_id = :m AND currency = :cur"),
                         {"c": code, "m": merchant_id, "cur": currency})
    if aid is None:
        aid = await s.scalar(text("INSERT INTO ledger_accounts (code, merchant_id, currency) VALUES (:c, :m, :cur) "
                                  "ON CONFLICT (code, merchant_id, currency) DO UPDATE SET code = EXCLUDED.code RETURNING id"),
                             {"c": code, "m": merchant_id, "cur": currency})
    return aid


async def post(s, *, kind: str, payment_id, idempotency_ref: str, merchant_id, currency: str,
               lines: list[tuple[str, int]]) -> bool:
    """Book one balanced transaction. Returns False if this business event was already booked."""
    if sum(a for _, a in lines) != 0:
        raise ValueError(f"unbalanced posting {lines}")   # the DB would reject it too, at COMMIT
    tid = await s.scalar(text("INSERT INTO ledger_transactions (payment_id, kind, idempotency_ref) VALUES (:p, :k, :r) "
                              "ON CONFLICT (idempotency_ref) DO NOTHING RETURNING id"),
                         {"p": payment_id, "k": kind, "r": idempotency_ref})
    if tid is None:
        return False
    for code, amount in lines:
        if amount:
            await s.execute(text("INSERT INTO ledger_entries (transaction_id, account_id, amount) VALUES (:t, :a, :x)"),
                            {"t": tid, "a": await _account(s, code, merchant_id, currency), "x": amount})
    return True


async def book_capture(s, payment: dict, amount: int, fee: int) -> bool:
    return await post(s, kind="capture", payment_id=payment["id"], idempotency_ref=f"capture:{payment['id']}",
                      merchant_id=payment["merchant_id"], currency=payment["currency"],
                      lines=[("provider_receivable", amount), ("merchant_payable", -(amount - fee)),
                             ("platform_fee_revenue", -fee)])


async def book_refund(s, payment: dict, refund_id, amount: int) -> bool:
    return await post(s, kind="refund", payment_id=payment["id"], idempotency_ref=f"refund:{refund_id}",
                      merchant_id=payment["merchant_id"], currency=payment["currency"],
                      lines=[("merchant_payable", amount), ("provider_receivable", -amount)])


async def balances(s, merchant_id) -> list[dict]:
    rows = (await s.execute(text(
        "SELECT a.code, a.currency, coalesce(sum(e.amount), 0) AS balance FROM ledger_accounts a "
        "LEFT JOIN ledger_entries e ON e.account_id = a.id WHERE a.merchant_id = :m GROUP BY a.code, a.currency "
        "ORDER BY a.currency, a.code"), {"m": merchant_id})).mappings().all()
    return [{"account": r["code"], "currency": r["currency"], "balance": int(r["balance"])} for r in rows]


async def trial_balance(s) -> int:
    """Sum of ALL entries ever: must be exactly 0 if every transaction balanced."""
    return int(await s.scalar(text("SELECT coalesce(sum(amount), 0) FROM ledger_entries")))
