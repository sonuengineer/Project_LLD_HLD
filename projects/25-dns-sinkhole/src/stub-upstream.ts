/**
 * A tiny controllable "upstream resolver" for tests and the demo -- it never talks to the real internet. Tests
 * point SinkholeProxy at one of these instead of a real resolver, and control exactly how it answers a given
 * (name, type): a normal answer, NXDOMAIN, dropping the query to simulate a timeout, or truncating the UDP reply
 * so the proxy has to retry over TCP (see transport.ts).
 */
import dgram from "node:dgram";
import net from "node:net";
import { frameTcp } from "./transport.js";
import { RCODE, canonicalName, decodeQuery, encodeARecord, encodeMessage, type Header, type Question } from "./wire.js";

export type StubBehavior =
  | { kind: "answer"; ttl: number; address: string }
  | { kind: "nxdomain" }
  | { kind: "drop" }
  | { kind: "truncate"; ttl: number; address: string }
  /** A buggy/confused upstream: answers with a transaction id that does NOT match the query (see proxy.ts's
   * id/qr verification -- this must become SERVFAIL, never be relayed to the client as-is). */
  | { kind: "wrong-id"; ttl: number; address: string };

export interface StubUpstreamOptions {
  /** Decides how to answer a given (canonical name, type); default: NXDOMAIN for everything. */
  behavior?: (name: string, type: number) => StubBehavior;
}

export interface StubCall {
  name: string;
  type: number;
  transport: "udp" | "tcp";
}

export class StubUpstream {
  readonly calls: StubCall[] = [];
  private udp?: dgram.Socket;
  private tcp?: net.Server;
  private readonly sockets = new Set<net.Socket>();

  constructor(private readonly opts: StubUpstreamOptions = {}) {}

  get callCount(): number {
    return this.calls.length;
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<{ host: string; port: number }> {
    const udp = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(port, host, () => {
        udp.off("error", reject);
        resolve();
      });
    });
    const boundPort = udp.address().port;
    const tcp = net.createServer((s) => this.onTcp(s));
    await new Promise<void>((resolve, reject) => {
      tcp.once("error", reject);
      tcp.listen(boundPort, host, () => resolve());
    });
    udp.on("message", (buf, rinfo) => {
      const out = this.respond(buf, "udp");
      if (out) udp.send(out, rinfo.port, rinfo.address);
    });
    this.udp = udp;
    this.tcp = tcp;
    return { host, port: boundPort };
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.udp ? this.udp.close(() => r()) : r()));
    await new Promise<void>((r) => (this.tcp ? this.tcp.close(() => r()) : r()));
  }

  private onTcp(s: net.Socket): void {
    this.sockets.add(s);
    s.on("close", () => this.sockets.delete(s));
    s.on("error", () => {});
    let pending = Buffer.alloc(0);
    s.on("data", (chunk) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 2) {
        const len = pending.readUInt16BE(0);
        if (pending.length < 2 + len) break;
        const frame = Buffer.from(pending.subarray(2, 2 + len));
        pending = pending.subarray(2 + len);
        const out = this.respond(frame, "tcp");
        if (out && !s.destroyed) s.write(frameTcp(out));
      }
    });
  }

  private respond(buf: Buffer, transport: "udp" | "tcp"): Buffer | undefined {
    let query;
    try {
      query = decodeQuery(buf);
    } catch {
      return undefined;
    }
    const q = query.questions[0];
    if (!q) return undefined;
    const name = canonicalName(q.name);
    this.calls.push({ name, type: q.type, transport });
    const behavior = (this.opts.behavior ?? ((): StubBehavior => ({ kind: "nxdomain" })))(name, q.type);
    const header: Header = { id: query.header.id, qr: true, opcode: query.header.opcode, aa: true, tc: false, rd: query.header.rd, ra: true, rcode: RCODE.NOERROR };
    return this.buildReply(header, q, behavior, transport);
  }

  private buildReply(header: Header, q: Question, behavior: StubBehavior, transport: "udp" | "tcp"): Buffer | undefined {
    switch (behavior.kind) {
      case "drop":
        return undefined;
      case "nxdomain":
        return encodeMessage({ ...header, rcode: RCODE.NXDOMAIN }, [q], []);
      case "answer":
        return encodeMessage(header, [q], [encodeARecord(q.name, behavior.ttl, behavior.address)]);
      case "truncate":
        if (transport === "udp") return encodeMessage({ ...header, tc: true }, [q], []);
        return encodeMessage(header, [q], [encodeARecord(q.name, behavior.ttl, behavior.address)]);
      case "wrong-id":
        return encodeMessage({ ...header, id: (header.id + 1) & 0xffff }, [q], [encodeARecord(q.name, behavior.ttl, behavior.address)]);
    }
  }
}
