import asyncio
import contextlib

from .worker import main

with contextlib.suppress(KeyboardInterrupt):
    asyncio.run(main())
