"""Provider client. The app depends on the PaymentProvider protocol, never on a vendor SDK.

Error taxonomy (the part that matters for money):
    Declined            definite NO from the issuer -> payment declined
    ProviderRejected    definite NO for this request (4xx) -> operation failed, state unchanged
    ProviderUnavailable we KNOW it didn't happen? NO -- a 5xx or connection error may still have been applied
    ProviderTimeout     AMBIGUOUS: the provider may or may not have done it
For the last two we retry with the SAME idempotency key (safe by design); if still unresolved, the payment goes to
requires_reconciliation and recovery asks the provider later. Never assume failure on a timeout: that's how
customers get charged without an order.
"""
from __future__ import annotations

import asyncio
from typing import Protocol

import httpx


class ProviderError(Exception):
    pass


class ProviderRejected(ProviderError):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status}: {message}")
        self.status = status


class ProviderUnavailable(ProviderError):
    pass


class ProviderTimeout(ProviderError):
    pass


class PaymentProvider(Protocol):
    name: str

    async def authorize(self, amount: int, currency: str, token: str, reference: str, idem: str) -> dict: ...
    async def capture(self, pid: str, amount: int, idem: str) -> dict: ...
    async def void(self, pid: str, idem: str) -> dict: ...
    async def refund(self, pid: str, amount: int, reference: str, idem: str) -> dict: ...
    async def find_by_reference(self, reference: str) -> list[dict]: ...
    async def settlements(self, day: str) -> list[dict]: ...


class HttpProvider:
    name = "mockpay"

    def __init__(self, base_url: str, api_key: str, timeout: float, *, transport=None, retries: int = 2):
        self.http = httpx.AsyncClient(base_url=base_url, transport=transport, timeout=timeout,
                                      headers={"Authorization": f"Bearer {api_key}"})
        self.retries = retries
        self.timeout = timeout

    async def _call(self, method: str, path: str, *, idem: str | None = None, **kw) -> dict:
        headers = {"Idempotency-Key": idem} if idem else {}
        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                # Overall deadline per attempt (httpx timeouts are per-phase; a slow-dripping response could
                # exceed them in total). Also enforced for in-process ASGI transports used in tests.
                r = await asyncio.wait_for(self.http.request(method, path, headers=headers, **kw), self.timeout)
            except (httpx.TimeoutException, asyncio.TimeoutError):
                last = ProviderTimeout(f"{method} {path} timed out")
            except httpx.TransportError as exc:
                last = ProviderUnavailable(f"{method} {path}: {exc}")
            else:
                if r.status_code < 300:
                    return r.json()
                if r.status_code >= 500 or r.status_code == 429:
                    # 429 = rate limited: the provider did NOT process it -> retryable, not a definite "no"
                    last = ProviderUnavailable(f"{method} {path}: HTTP {r.status_code}")
                else:
                    raise ProviderRejected(r.status_code, r.json().get("detail", r.text))
            # Retrying is only safe because every mutating call carries an idempotency key.
            if attempt < self.retries and (idem or method == "GET"):
                await asyncio.sleep(0.05 * (2 ** attempt))
                continue
            raise last
        raise last  # pragma: no cover

    async def authorize(self, amount, currency, token, reference, idem):
        return await self._call("POST", "/v1/authorizations", idem=idem,
                                json={"amount": amount, "currency": currency, "token": token, "reference": reference})

    async def capture(self, pid, amount, idem):
        return await self._call("POST", f"/v1/authorizations/{pid}/capture", idem=idem, json={"amount": amount})

    async def void(self, pid, idem):
        return await self._call("POST", f"/v1/authorizations/{pid}/void", idem=idem)

    async def refund(self, pid, amount, reference, idem):
        return await self._call("POST", "/v1/refunds", idem=idem,
                                json={"authorization_id": pid, "amount": amount, "reference": reference})

    async def find_by_reference(self, reference):
        return (await self._call("GET", "/v1/authorizations", params={"reference": reference}))["data"]

    async def settlements(self, day):
        return (await self._call("GET", "/v1/settlements", params={"day": day}))["transactions"]

    async def aclose(self):
        await self.http.aclose()
