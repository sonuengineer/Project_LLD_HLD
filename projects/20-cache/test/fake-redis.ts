import type { L2Client, L2Subscriber } from "../src/index.js";

// An in-memory stand-in for Redis, for unit tests that must control time and failures exactly: TTLs follow a clock
// the test moves, `mode` makes every command fail or never answer, pub/sub messages are delivered asynchronously (a
// microtask later, like a network hop) to every subscriber that is "connected". The real-Redis behaviour is covered
// by redis-l2.test.ts.
export class FakeRedis {
  readonly data = new Map<string, { value: string; expiresAt: number }>();
  readonly commands: string[] = [];
  mode: "ok" | "down" | "hang" = "ok";
  private readonly subs: Array<{ channel: string; onMessage: (m: string) => void; onResubscribed: () => void; connected: boolean }> = [];

  constructor(readonly now: () => number = () => 0) {}

  client(): L2Client {
    return {
      getWithTtl: (key) =>
        this.run(`get ${key}`, (): [string | null, number] => {
          const e = this.live(key);
          if (e === undefined) return [null, -2];
          return [e.value, e.expiresAt === Infinity ? -1 : e.expiresAt - this.now()];
        }),
      set: (key, value, ttlMs, onlyIfAbsent) =>
        this.run(`set ${key} ${ttlMs ?? "-"}${onlyIfAbsent ? " NX" : ""}`, () => {
          if (ttlMs !== undefined && !(Number.isInteger(ttlMs) && ttlMs > 0)) throw new Error("ERR invalid expire time in 'set' command");
          if (onlyIfAbsent && this.live(key) !== undefined) return null; // what Redis replies to a refused SET NX
          this.data.set(key, { value, expiresAt: ttlMs === undefined ? Infinity : this.now() + ttlMs });
          return "OK";
        }),
      publish: (channel, message) =>
        this.run(`publish ${channel}`, () => {
          let n = 0;
          for (const s of this.subs) {
            if (s.channel !== channel || !s.connected) continue; // a disconnected subscriber simply misses it
            n++;
            this.deliver(() => s.onMessage(message));
          }
          return n;
        }),
    };
  }

  // While held, published messages wait (as if slow on the network) until release(): lets a test put a write
  // between a publish and its arrival.
  private held: Array<() => void> | undefined;
  holdMessages(): void {
    this.held = [];
  }
  releaseMessages(): void {
    const held = this.held ?? [];
    this.held = undefined;
    for (const f of held) queueMicrotask(f);
  }
  private deliver(f: () => void): void {
    if (this.held !== undefined) this.held.push(f);
    else queueMicrotask(f);
  }

  subscriber(): L2Subscriber & { disconnect(): void; reconnect(): void } {
    const mine: typeof this.subs = [];
    return {
      subscribe: async (channel, onMessage, onResubscribed) => {
        if (this.mode !== "ok") throw new Error("connection refused");
        const s = { channel, onMessage, onResubscribed, connected: true };
        this.subs.push(s);
        mine.push(s);
        return async () => {
          this.subs.splice(this.subs.indexOf(s), 1);
        };
      },
      disconnect: () => mine.forEach((s) => (s.connected = false)),
      reconnect: () =>
        mine.forEach((s) => {
          s.connected = true;
          s.onResubscribed();
        }),
    };
  }

  get subscriberCount(): number {
    return this.subs.length;
  }

  private live(key: string) {
    const e = this.data.get(key);
    if (e !== undefined && this.now() >= e.expiresAt) {
      this.data.delete(key);
      return undefined;
    }
    return e;
  }

  private run<T>(command: string, fn: () => T): Promise<T> {
    this.commands.push(command);
    if (this.mode === "hang") return new Promise<T>(() => {});
    if (this.mode === "down") return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:6379"));
    try {
      return Promise.resolve(fn());
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
