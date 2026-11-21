import net from "node:net";
import { Broker, type BrokerOptions } from "../src/server.js";

export async function startBroker(opts: BrokerOptions = {}): Promise<{ broker: Broker; port: number }> {
  const broker = new Broker({ host: "127.0.0.1", port: 0, ...opts });
  const { port } = await broker.listen();
  return { broker, port };
}

/**
 * A hand-driven protocol client: sends raw text, records everything the server sends. Used where the official client
 * would hide the protocol (it answers PINGs itself, never sends bad input, and so on).
 */
export class Raw {
  received = "";
  closed = false;
  private waiters: Array<() => void> = [];

  private constructor(readonly socket: net.Socket) {
    socket.setEncoding("latin1");
    socket.on("data", (d: string) => {
      this.received += d;
      this.notify();
    });
    socket.on("close", () => {
      this.closed = true;
      this.notify();
    });
    socket.on("error", () => {});
  }

  static connect(port: number): Promise<Raw> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1", () => resolve(new Raw(s)));
      s.once("error", reject);
    });
  }

  /** Connects and waits for INFO, so later assertions only see what follows it. */
  static async ready(port: number, connect: Record<string, unknown> = {}): Promise<Raw> {
    const r = await Raw.connect(port);
    await r.waitFor(/^INFO .*\r\n/);
    r.send(`CONNECT ${JSON.stringify(connect)}\r\nPING\r\n`);
    await r.waitFor("PONG\r\n");
    r.received = "";
    return r;
  }

  send(s: string | Buffer): void {
    this.socket.write(s);
  }

  private notify(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves once the received text contains the pattern; fails after ms. */
  waitFor(pattern: string | RegExp, ms = 2000): Promise<string> {
    const test = () => (typeof pattern === "string" ? this.received.includes(pattern) : pattern.test(this.received));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${pattern}; got ${JSON.stringify(this.received)}`)), ms);
      const check = () => {
        if (test()) {
          clearTimeout(timer);
          resolve(this.received);
        } else if (this.closed) {
          clearTimeout(timer);
          reject(new Error(`closed while waiting for ${pattern}; got ${JSON.stringify(this.received)}`));
        } else this.waiters.push(check);
      };
      check();
    });
  }

  waitClosed(ms = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("socket did not close")), ms);
      const check = () => {
        if (this.closed) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      check();
    });
  }

  /** Round trip: everything sent before this has been processed by the server once PONG comes back. */
  async sync(): Promise<void> {
    const before = this.received.length;
    this.send("PING\r\n");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sync timeout")), 2000);
      const check = () => {
        if (this.received.indexOf("PONG\r\n", before) >= 0) {
          clearTimeout(timer);
          this.received = this.received.slice(0, this.received.lastIndexOf("PONG\r\n"));
          resolve();
        } else this.waiters.push(check);
      };
      check();
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

export const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
};
