/**
 * A small DNS server for STUB clients (nslookup, dig, an OS resolver): it takes their query, resolves it with the
 * Resolver, and answers. UDP and TCP on the same port.
 *
 * It binds loopback only, unless allowNonLoopback is set. An open recursive resolver on the internet gets used for
 * DNS amplification (a 60-byte spoofed query can trigger a reply many times bigger towards the victim) and for cache
 * poisoning experiments by strangers, and this one has no rate limiting and no access control.
 *
 * Answers over UDP are limited to 512 bytes (no EDNS here). A bigger answer is sent with TC=1 and no records, so the
 * client retries over TCP, which this server also speaks (2-byte length prefix per message).
 */
import dgram from "node:dgram";
import net from "node:net";
import { LengthPrefixedReader, frameTcp } from "./transport.js";
import type { Resolver } from "./resolver.js";
import {
  CLASS_IN,
  OPCODE_QUERY,
  RCODE,
  TYPE,
  WireError,
  decodeHeader,
  decodeMessage,
  encodeMessage,
  type Message,
} from "./wire.js";

export const UDP_MAX_ANSWER = 512;
/** AXFR / IXFR / MAILB / MAILA / ANY: zone transfers and meta queries are not served */
const META_TYPES = new Set([251, 252, 253, 254, TYPE.ANY]);

export interface ServerOptions {
  resolver: Resolver;
  host?: string;
  /** 0 = any free port (tests) */
  port?: number;
  allowNonLoopback?: boolean;
  /** a TCP client idle longer than this is closed, default 10000 ms */
  tcpIdleMs?: number;
}

export interface ServerStats {
  udpQueries: number;
  tcpQueries: number;
  dropped: number;
  formerr: number;
  notimp: number;
  servfail: number;
  truncated: number;
}

export const isLoopback = (h: string) => h === "127.0.0.1" || h === "::1" || h === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(h);

export class DnsServer {
  private udp?: dgram.Socket;
  private tcp?: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly counters: ServerStats = { udpQueries: 0, tcpQueries: 0, dropped: 0, formerr: 0, notimp: 0, servfail: 0, truncated: 0 };

  constructor(private readonly opts: ServerOptions) {}

  stats(): ServerStats {
    return { ...this.counters };
  }

  async listen(): Promise<{ host: string; port: number }> {
    const host = this.opts.host ?? "127.0.0.1";
    if (!isLoopback(host) && !this.opts.allowNonLoopback) {
      throw new Error(`refusing to bind ${host}: this is an open recursive resolver with no access control. Set ALLOW_NON_LOOPBACK=1 only on a private network.`);
    }
    const wanted = this.opts.port ?? 5300;
    for (let attempt = 0; attempt < (wanted === 0 ? 20 : 1); attempt++) {
      const udp = dgram.createSocket(host.includes(":") ? "udp6" : "udp4");
      await new Promise<void>((resolve, reject) => {
        udp.once("error", reject);
        udp.bind(wanted, host, () => {
          udp.off("error", reject);
          resolve();
        });
      });
      const port = udp.address().port;
      const tcp = net.createServer((s) => this.onTcp(s));
      const err = await new Promise<Error | null>((resolve) => {
        tcp.once("error", resolve);
        tcp.listen(port, host, () => resolve(null));
      });
      if (err) {
        udp.close();
        if (wanted !== 0) throw err;
        continue; // the UDP port's TCP twin was taken; try another free port
      }
      udp.on("message", (buf, rinfo) => {
        void this.handle(buf, "udp").then((out) => {
          if (out) udp.send(out, rinfo.port, rinfo.address);
        }, () => this.counters.dropped++); // a bug (e.g. an answer that cannot be encoded) drops one reply, not the process
      });
      this.udp = udp;
      this.tcp = tcp;
      return { host, port };
    }
    throw new Error("could not bind UDP and TCP on the same port");
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.udp ? this.udp.close(() => r()) : r()));
    await new Promise<void>((r) => (this.tcp ? this.tcp.close(() => r()) : r()));
  }

  private onTcp(s: net.Socket) {
    this.sockets.add(s);
    s.setTimeout(this.opts.tcpIdleMs ?? 10_000, () => s.destroy());
    s.on("close", () => this.sockets.delete(s));
    s.on("error", () => {});
    const reader = new LengthPrefixedReader();
    s.on("data", (chunk) => {
      for (const frame of reader.feed(chunk)) {
        void this.handle(frame, "tcp").then((out) => {
          if (out && !s.destroyed) s.write(frameTcp(out));
        }, () => this.counters.dropped++);
      }
    });
  }

  /** One query in, one reply out (or undefined = send nothing). Exported behaviour is tested through sockets. */
  async handle(buf: Buffer, transport: "udp" | "tcp"): Promise<Buffer | undefined> {
    if (transport === "udp") this.counters.udpQueries++;
    else this.counters.tcpQueries++;
    let header;
    try {
      header = decodeHeader(buf);
    } catch {
      this.counters.dropped++;
      return undefined; // not even a header: nothing to answer to
    }
    if (header.qr) {
      this.counters.dropped++;
      return undefined; // a response sent to us; answering it could start a loop between two servers
    }
    const base = (rcode: number, questions: Message["questions"] = []): Message => ({
      header: { id: header.id, qr: true, opcode: header.opcode, aa: false, tc: false, rd: header.rd, ra: true, rcode },
      questions,
      answers: [],
      authority: [],
      additional: [],
    });
    let query: Message;
    try {
      query = decodeMessage(buf);
    } catch (e) {
      if (!(e instanceof WireError)) throw e;
      this.counters.formerr++;
      return encodeMessage(base(RCODE.FORMERR));
    }
    if (header.opcode !== OPCODE_QUERY) {
      this.counters.notimp++;
      return encodeMessage(base(RCODE.NOTIMP, query.questions.slice(0, 1)));
    }
    const q = query.questions[0];
    if (!q || query.questions.length !== 1) {
      this.counters.formerr++;
      return encodeMessage(base(RCODE.FORMERR));
    }
    if (q.class !== CLASS_IN || META_TYPES.has(q.type)) {
      this.counters.notimp++;
      return encodeMessage(base(RCODE.NOTIMP, [q]));
    }
    let res;
    try {
      res = await this.opts.resolver.resolve(q.name, q.type);
    } catch {
      // Resolver.resolve already maps its own errors to SERVFAIL; anything else is a bug. The client still gets an
      // answer, and the process does not die from an unhandled rejection in the socket callback.
      res = { rcode: RCODE.SERVFAIL, answers: [], authority: [], queries: 0 };
    }
    if (res.rcode === RCODE.SERVFAIL) this.counters.servfail++;
    const reply = base(res.rcode, [q]);
    reply.answers = res.answers;
    reply.authority = res.authority;
    let wire = encodeMessage(reply);
    if (transport === "udp" && wire.length > UDP_MAX_ANSWER) {
      this.counters.truncated++;
      reply.header.tc = true;
      reply.answers = [];
      reply.authority = [];
      wire = encodeMessage(reply);
    }
    return wire;
  }
}
