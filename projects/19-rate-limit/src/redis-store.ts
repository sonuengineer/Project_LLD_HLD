import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Algorithm, Decision } from "./types.js";

// The two Redis commands the store needs, so ANY client fits: pass a small adapter (see ioredisClient below for
// ioredis; node-redis: { evalsha: (sha, keys, args) => c.evalSha(sha, { keys, arguments: args }),
// scriptLoad: (s) => c.scriptLoad(s) }). This package therefore has no runtime dependency on a Redis library.
export interface RedisScriptClient {
  evalsha(sha: string, keys: string[], args: string[]): Promise<unknown>;
  scriptLoad(script: string): Promise<string>;
}

// Adapter for an ioredis client (structural: no import of ioredis here).
export function ioredisClient(client: {
  evalsha(sha: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
  script(subcommand: "LOAD", script: string): Promise<unknown>;
}): RedisScriptClient {
  return {
    evalsha: (sha, keys, args) => client.evalsha(sha, keys.length, ...keys, ...args),
    scriptLoad: async (script) => String(await client.script("LOAD", script)),
  };
}

export interface RedisStoreOptions {
  // Default: undefined = the script reads Redis's own clock (TIME). Every app instance then agrees on "now", even if
  // their clocks drift. Tests pass a clock to drive time.
  now?: () => number;
}

const scripts = new Map<string, { source: string; sha: string }>();

function load(file: string): { source: string; sha: string } {
  let s = scripts.get(file);
  if (s === undefined) {
    const source = readFileSync(new URL(`./lua/${file}`, import.meta.url), "utf8");
    s = { source, sha: createHash("sha1").update(source).digest("hex") };
    scripts.set(file, s);
  }
  return s;
}

// Runs the algorithm's Lua script with EVALSHA: the whole read-decide-write is one atomic step inside Redis, so
// concurrent requests from any number of app instances can never both take the last token (tested with 3 clients).
// If Redis does not know the script (restart, SCRIPT FLUSH, failover), it gets NOSCRIPT; the store loads the script
// and retries once.
export class RedisStore {
  constructor(
    private readonly client: RedisScriptClient,
    private readonly options: RedisStoreOptions = {},
  ) {}

  async consume<S>(algorithm: Algorithm<S>, key: string, cost: number): Promise<Decision> {
    const { source, sha } = load(algorithm.luaFile);
    const now = this.options.now === undefined ? "" : String(this.options.now());
    const args = [...algorithm.args(), now, String(cost)];
    let raw: unknown;
    try {
      raw = await this.client.evalsha(sha, [key], args);
    } catch (error) {
      if (!String((error as Error)?.message ?? error).includes("NOSCRIPT")) throw error;
      const loaded = await this.client.scriptLoad(source);
      if (loaded !== sha) throw new Error(`script SHA mismatch for ${algorithm.luaFile}`);
      raw = await this.client.evalsha(sha, [key], args);
    }
    return toDecision(raw, algorithm.limit);
  }
}

function toDecision(raw: unknown, limit: number): Decision {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((x) => typeof x === "number")) {
    throw new Error(`unexpected reply from the rate-limit script: ${JSON.stringify(raw)}`);
  }
  const [allowed, remaining, retry, reset] = raw as number[];
  return { allowed: allowed === 1, limit, remaining: remaining!, retryAfterMs: retry!, resetMs: reset! };
}
