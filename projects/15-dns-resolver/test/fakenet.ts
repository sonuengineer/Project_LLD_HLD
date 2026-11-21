/**
 * A fake DNS "internet" for tests: in-process authoritative servers, each on its own ephemeral loopback port (UDP and
 * TCP on the SAME port number), serving fixture zones. Zones use documentation addresses (192.0.2.0/24,
 * 198.51.100.0/24, 203.0.113.0/24); `FakeNet.route` maps such an address to the loopback port of the server that
 * "owns" it, which is what the resolver's `route` option expects. Nothing here touches the real network.
 */
import dgram from "node:dgram";
import net from "node:net";
import { LengthPrefixedReader, frameTcp, type Endpoint } from "../src/transport.js";
import {
  CLASS_IN,
  RCODE,
  TYPE,
  decodeMessage,
  encodeMessage,
  isSubdomain,
  sameName,
  type Message,
  type RData,
  type ResourceRecord,
} from "../src/wire.js";

export interface Zone {
  origin: string;
  records: ResourceRecord[];
}

export type Transport = "udp" | "tcp";

export interface QueryLogEntry {
  name: string;
  type: number;
  transport: Transport;
  id: number;
  rd: boolean;
  port: number;
}

export interface HookCtx {
  query: Message;
  reply: Message;
  transport: Transport;
  /** send extra raw bytes to the client from this server's own UDP socket */
  send: (buf: Buffer) => void;
  /** send raw bytes to the client from a DIFFERENT port (an off-path spoofer) */
  spoof: (buf: Buffer) => Promise<void>;
}

/** Return a Message or raw bytes to send instead, "drop" to send nothing, or undefined to send `reply`. */
export type Hook = (ctx: HookCtx) => Message | Buffer | "drop" | undefined | Promise<Message | Buffer | "drop" | undefined>;

export const rr = (name: string, data: RData, ttl = 3600): ResourceRecord => ({
  name,
  type: { A: TYPE.A, AAAA: TYPE.AAAA, NS: TYPE.NS, CNAME: TYPE.CNAME, PTR: TYPE.PTR, MX: TYPE.MX, TXT: TYPE.TXT, SOA: TYPE.SOA, RAW: 99 }[data.kind],
  class: CLASS_IN,
  ttl,
  data,
});
export const A = (name: string, address: string, ttl = 3600) => rr(name, { kind: "A", address }, ttl);
export const NS = (name: string, host: string, ttl = 3600) => rr(name, { kind: "NS", host }, ttl);
export const CNAME = (name: string, target: string, ttl = 3600) => rr(name, { kind: "CNAME", target }, ttl);
export const SOA = (origin: string, minimum = 300, ttl = 3600) =>
  rr(origin, { kind: "SOA", mname: `ns.${origin || "root"}`, rname: `hostmaster.${origin || "root"}`, serial: 1, refresh: 3600, retry: 600, expire: 86400, minimum }, ttl);

/** Classic UDP limit without EDNS (RFC 1035 4.2.1). */
export const UDP_LIMIT = 512;

export class FakeServer {
  port = 0;
  readonly log: QueryLogEntry[] = [];
  hook: Hook | undefined;
  private udp?: dgram.Socket;
  private tcp?: net.Server;
  private readonly tcpSockets = new Set<net.Socket>();

  constructor(
    readonly ip: string,
    readonly zones: Zone[],
  ) {}

  async start(): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 20; attempt++) {
      const udp = dgram.createSocket("udp4");
      await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", () => resolve()));
      const port = udp.address().port;
      const tcp = net.createServer((s) => this.onTcp(s));
      const ok = await new Promise<boolean>((resolve) => {
        tcp.once("error", (e) => {
          lastError = String(e);
          resolve(false);
        });
        tcp.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (!ok) {
        udp.close();
        continue;
      }
      udp.on("message", (buf, rinfo) => void this.onUdp(buf, rinfo));
      this.udp = udp;
      this.tcp = tcp;
      this.port = port;
      return;
    }
    throw new Error(`could not get the same UDP and TCP port: ${lastError}`);
  }

  async stop(): Promise<void> {
    for (const s of this.tcpSockets) s.destroy();
    await new Promise<void>((r) => (this.udp ? this.udp.close(() => r()) : r()));
    await new Promise<void>((r) => (this.tcp ? this.tcp.close(() => r()) : r()));
  }

  reset() {
    this.log.length = 0;
    this.hook = undefined;
  }

  private async onUdp(buf: Buffer, rinfo: dgram.RemoteInfo) {
    const sendTo = (b: Buffer) => this.udp!.send(b, rinfo.port, rinfo.address);
    const out = await this.handle(buf, "udp", rinfo.port, sendTo);
    if (out) sendTo(out);
  }

  private onTcp(s: net.Socket) {
    this.tcpSockets.add(s);
    s.on("close", () => this.tcpSockets.delete(s));
    s.on("error", () => {});
    const reader = new LengthPrefixedReader();
    s.on("data", async (chunk) => {
      for (const frame of reader.feed(chunk)) {
        const out = await this.handle(frame, "tcp", s.remotePort ?? 0, (b) => s.write(frameTcp(b)));
        if (out) s.write(frameTcp(out));
      }
    });
  }

  private async handle(buf: Buffer, transport: Transport, port: number, send: (b: Buffer) => void): Promise<Buffer | undefined> {
    let query: Message;
    try {
      query = decodeMessage(buf);
    } catch {
      return undefined;
    }
    const q = query.questions[0];
    if (!q) return undefined;
    this.log.push({ name: q.name, type: q.type, transport, id: query.header.id, rd: query.header.rd, port });
    let reply = this.answer(query);
    let wire = encodeMessage(reply);
    if (transport === "udp" && wire.length > UDP_LIMIT) {
      reply = { ...reply, header: { ...reply.header, tc: true }, answers: [], authority: [], additional: [] };
      wire = encodeMessage(reply);
    }
    if (this.hook) {
      const spoof = async (b: Buffer) => {
        const s = dgram.createSocket("udp4");
        await new Promise<void>((r) => s.bind(0, "127.0.0.1", r));
        await new Promise<void>((r) => s.send(b, port, "127.0.0.1", () => r()));
        s.close();
      };
      const out = await this.hook({ query, reply, transport, send, spoof });
      if (out === "drop") return undefined;
      if (Buffer.isBuffer(out)) return out;
      if (out) return encodeMessage(out);
    }
    return wire;
  }

  /** Authoritative logic: referral at a zone cut, else answer / CNAME / NODATA / NXDOMAIN, else REFUSED. */
  answer(query: Message): Message {
    const q = query.questions[0]!;
    const reply: Message = {
      header: { ...query.header, qr: true, aa: false, tc: false, ra: false, rcode: RCODE.NOERROR },
      questions: [q],
      answers: [],
      authority: [],
      additional: [],
    };
    const zone = [...this.zones].filter((z) => isSubdomain(q.name, z.origin)).sort((a, b) => b.origin.length - a.origin.length)[0];
    if (!zone) return { ...reply, header: { ...reply.header, rcode: RCODE.REFUSED } };
    const recs = zone.records;
    const soa = recs.find((r) => r.type === TYPE.SOA && sameName(r.name, zone.origin));

    // a delegation below the apex that covers the name -> referral
    const cut = recs.find((r) => r.type === TYPE.NS && !sameName(r.name, zone.origin) && isSubdomain(q.name, r.name));
    if (cut) {
      const ns = recs.filter((r) => r.type === TYPE.NS && sameName(r.name, cut.name));
      const hosts = ns.map((r) => (r.data as { host: string }).host);
      reply.authority = ns;
      reply.additional = recs.filter((r) => (r.type === TYPE.A || r.type === TYPE.AAAA) && hosts.some((h) => sameName(h, r.name)));
      return reply;
    }

    reply.header.aa = true;
    const at = recs.filter((r) => sameName(r.name, q.name));
    const match = at.filter((r) => r.type === q.type);
    if (match.length) {
      reply.answers = match;
      return reply;
    }
    const cname = at.find((r) => r.type === TYPE.CNAME);
    if (cname) {
      reply.answers = [cname];
      // chase inside the same zone, like a real authoritative server
      let target = (cname.data as { target: string }).target;
      for (let i = 0; i < 8 && isSubdomain(target, zone.origin); i++) {
        const next = recs.filter((r) => sameName(r.name, target));
        const hit = next.filter((r) => r.type === q.type);
        if (hit.length) {
          reply.answers.push(...hit);
          break;
        }
        const c = next.find((r) => r.type === TYPE.CNAME);
        if (!c) break;
        reply.answers.push(c);
        target = (c.data as { target: string }).target;
      }
      return reply;
    }
    const exists = recs.some((r) => isSubdomain(r.name, q.name));
    if (!exists) reply.header.rcode = RCODE.NXDOMAIN;
    if (soa) reply.authority = [soa];
    return reply;
  }
}

export class FakeNet {
  readonly servers = new Map<string, FakeServer>();

  add(ip: string, ...zones: Zone[]): FakeServer {
    const s = new FakeServer(ip, zones);
    this.servers.set(ip, s);
    return s;
  }

  get(ip: string): FakeServer {
    const s = this.servers.get(ip);
    if (!s) throw new Error(`no fake server ${ip}`);
    return s;
  }

  async start() {
    for (const s of this.servers.values()) await s.start();
  }

  async stop() {
    for (const s of this.servers.values()) await s.stop();
  }

  reset() {
    for (const s of this.servers.values()) s.reset();
  }

  /** IP -> loopback socket of its fake server. An unknown IP goes to a port nothing listens on (a "dead" host). */
  route = (ip: string): Endpoint => {
    const s = this.servers.get(ip);
    return { host: "127.0.0.1", port: s ? s.port : DEAD_PORT };
  };

  /** Every query any server saw, in order per server. */
  totalQueries(): number {
    let n = 0;
    for (const s of this.servers.values()) n += s.log.length;
    return n;
  }
}

/** Port 9 ("discard") is very unlikely to have a UDP DNS server; a query there just times out or gets refused. */
export const DEAD_PORT = 9;
