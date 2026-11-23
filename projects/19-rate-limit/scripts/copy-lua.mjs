// The Lua scripts are read at runtime next to redis-store.js; copy them into dist/ after tsc.
import { cpSync } from "node:fs";

cpSync(new URL("../src/lua/", import.meta.url), new URL("../dist/lua/", import.meta.url), { recursive: true });
