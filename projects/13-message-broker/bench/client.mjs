// A small raw-protocol client used to generate and measure load. It speaks the core NATS client protocol directly, so
// the SAME client drives our broker and the real nats-server (B2) -- the measuring tool stays the same on both sides of
// a comparison. Incoming frames are split by the broker's own Framer (dist/framer.js).
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";

const { Framer } = await import(pathToFileURL(path.join(ROOT, "dist", "framer.js")).href);

const OUT_BATCH = 64 * 1024;

export class BenchClient {
  /** @param {net.Socket} socket */
  constructor(socket) {
    this.socket = socket;
    this.handlers = new Map(); // sid -> (subject, reply, payload) => void
    this.nextSid = 1;
    this.pongWaiters = [];
    this.errors = [];
    this.received = 0;
    this.closed = false;
    this.out = [];
    this.outLen = 0;
    this.pending = null;
    this.framer = new Framer(
      64 * 1024,
      (line) => this.line(line),
      (payload) => {
        const p = this.pending;
        this.pending = null;
        this.received++;
        const h = this.handlers.get(p.sid);
        if (h) h(p.subject, p.reply, payload);
      },
    );
    socket.on("data", (d) => this.framer.feed(d));
    socket.on("close", () => {
      this.closed = true;
      for (const w of this.pongWaiters.splice(0)) w.reject(new Error("connection closed"));
    });
    socket.on("error", () => {});
  }

  static connect(host, port, connectOpts = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      socket.setNoDelay(true);
      socket.once("error", reject);
      socket.once("connect", async () => {
        socket.off("error", reject);
        const c = new BenchClient(socket);
        socket.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, echo: true, ...connectOpts })}\r\n`);
        try {
          await c.flush();
          resolve(c);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  line(line) {
    if (line.startsWith("MSG ")) {
      const a = line.split(" ");
      // MSG <subject> <sid> [reply] <size>
      const size = Number(a[a.length - 1]);
      this.pending = { subject: a[1], sid: a[2], reply: a.length === 5 ? a[3] : undefined };
      this.framer.expect(size);
    } else if (line === "PING") {
      this.socket.write("PONG\r\n");
    } else if (line === "PONG") {
      this.pongWaiters.shift()?.resolve();
    } else if (line.startsWith("-ERR")) {
      this.errors.push(line);
    }
    // INFO and +OK are ignored
  }

  sub(subject, handler = () => {}, queue) {
    const sid = String(this.nextSid++);
    this.handlers.set(sid, handler);
    this.write(`SUB ${subject}${queue ? " " + queue : ""} ${sid}\r\n`);
    return sid;
  }

  unsub(sid) {
    this.handlers.delete(sid);
    this.write(`UNSUB ${sid}\r\n`);
  }

  /** Buffered publish: frames are collected and written in 64 KiB batches (as real clients do). */
  pub(subject, payload, reply) {
    const head = Buffer.from(`PUB ${subject}${reply ? " " + reply : ""} ${payload.length}\r\n`);
    this.out.push(head, payload, CRLF);
    this.outLen += head.length + payload.length + 2;
    if (this.outLen >= OUT_BATCH) this.flushOut();
  }

  write(s) {
    this.out.push(Buffer.from(s));
    this.outLen += s.length;
    this.flushOut();
  }

  flushOut() {
    if (this.outLen === 0 || this.closed) return true;
    const ok = this.socket.write(Buffer.concat(this.out, this.outLen));
    this.out = [];
    this.outLen = 0;
    return ok;
  }

  /** Waits until the socket accepted our buffered bytes (back-pressure for fast publishers). */
  async drained() {
    if (!this.flushOut()) await new Promise((r) => this.socket.once("drain", r));
  }

  /** Round trip: when PONG returns, the server has processed everything we sent before the PING. */
  flush() {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("connection closed"));
      this.pongWaiters.push({ resolve, reject });
      this.out.push(PING);
      this.outLen += PING.length;
      this.flushOut();
    });
  }

  close() {
    this.flushOut();
    this.socket.destroy();
  }
}

const CRLF = Buffer.from("\r\n");
const PING = Buffer.from("PING\r\n");

/** Resolves when cond() is true, polling every 5 ms; rejects after ms. */
export async function waitUntil(cond, ms = 30_000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
