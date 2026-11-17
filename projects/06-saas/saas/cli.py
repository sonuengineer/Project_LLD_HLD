"""Operator commands. python -m saas.cli promote <email>   (grant platform admin)"""
import asyncio
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from .config import get_settings


async def promote(email: str, url: str | None = None) -> bool:
    engine = create_async_engine(url or get_settings().database_url)
    async with engine.begin() as c:
        res = await c.execute(text("UPDATE users SET is_platform_admin = true WHERE lower(email) = lower(:e)"), {"e": email})
    await engine.dispose()
    return res.rowcount == 1


if __name__ == "__main__":
    if len(sys.argv) != 3 or sys.argv[1] != "promote":
        sys.exit("usage: python -m saas.cli promote <email>")
    print("promoted" if asyncio.run(promote(sys.argv[2])) else "no such user")
