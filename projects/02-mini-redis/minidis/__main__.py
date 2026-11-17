"""python -m minidis --port 6380 --appendonly yes"""
import asyncio
import contextlib
import signal

from bpcommon.logging import configure_logging

from .config import parse_args
from .server import Server


async def main() -> None:
    configure_logging("INFO", json_output=True)
    server = Server(parse_args())
    await server.start()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError):  # not available on Windows
            loop.add_signal_handler(sig, stop.set)
    try:
        await stop.wait()
    finally:
        await server.stop()


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
