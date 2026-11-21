/**
 * Sending one query to one server, over UDP or TCP.
 *
 * Spoofing defences (see README "Why random IDs and ports"): an off-path attacker who wants to poison us must send a
 * fake reply that arrives before the real one AND guesses everything below. Each check multiplies his work.
 *  - a fresh UDP socket per query, bound to a RANDOM source port we pick ourselves (about 16 bits of entropy);
 *  - a random 16-bit query ID (another 16 bits);
 *  - the reply must come from the exact address and port we sent to;
 *  - it must decode, have QR set, carry our ID, and echo our exact question (name, type, class).
 * A reply that fails any check is IGNORED and we keep listening until the timeout: if a wrong guess ended the query,
 * an attacker could at least make every lookup fail.
 */
import dgram from "node:dgram";
import net from "node:net";
import { randomInt } from "node:crypto";
import { WireError, decodeMessage, encodeMessage, sameName, type Message } from "./wire.js";

export interface Endpoint {
  host: string;
  port: number;
}

export class TimeoutError extends Error {
  override name = "TimeoutError";
}

export class TransportError extends Error {
  override name = "TransportError";
}

export const randomId = () => randomInt(0, 0x10000);

/** Lowest source port we pick; below are well-known and registered ports that are more likely to be taken. */
export const SOURCE_PORT_MIN = 10_000;

/** Does `reply` answer `query`? ID, QR bit and the echoed question must all match. */
export function matchesQuery(reply: Message, query: Message): boolean {
  if (!reply.header.qr || reply.header.id !== query.header.id) return false;
  const q = query.questions[0];
  const r = reply.questions[0];
  if (!q || !r || reply.questions.length !== 1) return false;
  return r.type === q.type && r.class === q.class && sameName(r.name, q.name);
}

export type IgnoreReason = "wrong-source" | "undecodable" | "mismatch";

export interface UdpOptions {
  timeoutMs: number;
  /** called for every reply that is ignored; tests use it to prove spoofed replies were seen and dropped */
  onIgnored?: (reason: IgnoreReason) => void;
  /** override the random source-port choice (tests only) */
  pickPort?: () => number;
}

/** A new socket on a random port; a port that is taken just means another try with a new socket. */
async function bindRandom(pick: () => number): Promise<dgram.Socket> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const sock = dgram.createSocket("udp4");
    const ok = await new Promise<boolean>((resolve) => {
      const onErr = () => resolve(false);
      sock.once("error", onErr);
      sock.bind(pick(), () => {
        sock.off("error", onErr);
        resolve(true);
      });
    });
    if (ok) return sock;
    try {
      sock.close();
    } catch {
      // already closed by the failed bind
    }
  }
  throw new TransportError("could not bind a random UDP source port");
}

export async function queryUdp(to: Endpoint, query: Message, opts: UdpOptions): Promise<Message> {
  const wire = encodeMessage(query);
  const sock = await bindRandom(opts.pickPort ?? (() => randomInt(SOURCE_PORT_MIN, 65536)));
  return new Promise<Message>((resolve, reject) => {
    let done = false;
    const finish = (err: Error | null, m?: Message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve(m!);
    };
    const timer = setTimeout(() => finish(new TimeoutError(`no reply from ${to.host}:${to.port} in ${opts.timeoutMs} ms`)), opts.timeoutMs);
    sock.on("error", (e) => finish(new TransportError(e.message)));
    sock.on("message", (buf, rinfo) => {
      if (rinfo.address !== to.host || rinfo.port !== to.port) return opts.onIgnored?.("wrong-source");
      let m: Message;
      try {
        m = decodeMessage(buf);
      } catch (e) {
        if (e instanceof WireError) return opts.onIgnored?.("undecodable");
        throw e;
      }
      if (!matchesQuery(m, query)) return opts.onIgnored?.("mismatch");
      finish(null, m);
    });
    sock.send(wire, to.port, to.host, (err) => {
      if (err) finish(new TransportError(err.message));
    });
  });
}

/**
 * Splits a TCP byte stream into DNS messages: each one is preceded by its length as 2 bytes, big-endian (RFC 1035
 * 4.2.2). Used by the client side below and by the stub server.
 */
export class LengthPrefixedReader {
  private buf = Buffer.alloc(0);
  feed(chunk: Buffer): Buffer[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const out: Buffer[] = [];
    while (this.buf.length >= 2) {
      const len = this.buf.readUInt16BE(0);
      if (this.buf.length < 2 + len) break;
      out.push(Buffer.from(this.buf.subarray(2, 2 + len)));
      this.buf = this.buf.subarray(2 + len);
    }
    return out;
  }
  get pending(): number {
    return this.buf.length;
  }
}

export function frameTcp(msg: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(msg.length);
  return Buffer.concat([len, msg]);
}

export async function queryTcp(to: Endpoint, query: Message, timeoutMs: number): Promise<Message> {
  const wire = encodeMessage(query);
  return new Promise<Message>((resolve, reject) => {
    const sock = net.connect({ host: to.host, port: to.port });
    const reader = new LengthPrefixedReader();
    let done = false;
    const finish = (err: Error | null, m?: Message) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(m!);
    };
    const timer = setTimeout(() => finish(new TimeoutError(`no TCP reply from ${to.host}:${to.port} in ${timeoutMs} ms`)), timeoutMs);
    sock.on("connect", () => sock.write(frameTcp(wire)));
    sock.on("error", (e) => finish(new TransportError(e.message)));
    sock.on("close", () => finish(new TransportError(`TCP connection to ${to.host}:${to.port} closed before a reply`)));
    sock.on("data", (chunk) => {
      for (const frame of reader.feed(chunk)) {
        let m: Message;
        try {
          m = decodeMessage(frame);
        } catch (e) {
          return finish(e instanceof WireError ? e : new TransportError(String(e)));
        }
        // On TCP there is no off-path guessing (the handshake already proved the peer), but a mismatch is still
        // a broken server: fail this server instead of using its answer.
        if (!matchesQuery(m, query)) return finish(new TransportError("TCP reply does not match the query"));
        return finish(null, m);
      }
    });
  });
}
