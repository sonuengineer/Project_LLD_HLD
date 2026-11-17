"""Money rules. Amounts are integers in MINOR units (paise/cents). Floats are never used for money:
0.1 + 0.2 != 0.3 in binary floating point, and rounding drift compounds across millions of transactions."""
from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

SUPPORTED_CURRENCIES = {"INR", "USD", "EUR", "GBP"}


def fee_for(amount: int, fee_bps: int, fee_fixed: int) -> int:
    """percentage (basis points) + fixed fee, rounded HALF UP to the minor unit, never more than the amount."""
    pct = (Decimal(amount) * Decimal(fee_bps) / Decimal(10_000)).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    return min(int(pct) + fee_fixed, amount)
