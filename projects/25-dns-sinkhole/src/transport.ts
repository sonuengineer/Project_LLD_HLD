/**
 * Forwarding one query to the configured upstream resolver, over UDP with a TCP fallback on a truncated reply.
 *
 * Threat model note (see PLAN.md): 15-dns-resolver talks to arbitrary authoritative servers across the open
 * internet and so defends every UDP query with a random source port and ID (Kaminsky-style spoofing). This proxy
 * only ever talks to ONE configured, trusted upstream (the same role 1.1.1.1 or 8.8.8.8 plays for Pi-hole) -- a
 * deliberately different, narrower threat model, so that defense is not reproduced here. We DO still check that a
 * reply comes from the address and port we sent to and ignore anything else without failing the query, because
 * that is cheap and costs nothing to keep.
 *
 * We forward the client's raw query bytes UNCHANGED (including its transaction ID) -- see wire.ts's file header
 * for why we never rebuild a forwarded message. Each query gets its own ephemeral socket, so there is no need to
 * rewrite the ID to multiplex concurrent queries the way a long-lived resolver socket would.
 */
import dgram from "node:dgram";
import net from "node:net";
import { decodeHeader } from "./wire.js";

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

export interface ForwardOptions {
  udpTimeoutMs: number;
  tcpTimeoutMs: number;
  /** Test-only: called with the ephemeral source port once the UDP socket is bound, before the query is sent --
   * lets a test send a spoofed reply from a WRONG address/port to prove it gets ignored (see transport.test.ts). */
  onUdpBound?: (port: number) => void;
}

function queryUdp(to: Endpoint, query: Buffer, timeoutMs: number, onBound?: (port: number) => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (err: Error | null, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      if (err) reject(err);
      else resolve(buf!);
    };
    const timer = setTimeout(() => finish(new TimeoutError(`no UDP reply from ${to.host}:${to.port} in ${timeoutMs} ms`)), timeoutMs);
    sock.on("error", (e) => finish(new TransportError(e.message)));
    sock.on("message", (buf, rinfo) => {
      if (rinfo.address !== to.host || rinfo.port !== to.port) return; // not our upstream: ignore, keep waiting
      finish(null, buf);
    });
    sock.bind(0, () => {
      onBound?.(sock.address().port);
      sock.send(query, to.port, to.host, (err) => {
        if (err) finish(new TransportError(err.message));
      });
    });
  });
}

/** Splits a TCP byte stream into DNS messages by their 2-byte length prefix (RFC 1035 4.2.2). */
class LengthPrefixedReader {
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
}

export function frameTcp(msg: Buffer): Buffer {
  const len = Buffer.alloc(2);
  len.writeUInt16BE(msg.length);
  return Buffer.concat([len, msg]);
}

function queryTcp(to: Endpoint, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const sock = net.connect({ host: to.host, port: to.port });
    const reader = new LengthPrefixedReader();
    let done = false;
    const finish = (err: Error | null, buf?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve(buf!);
    };
    const timer = setTimeout(() => finish(new TimeoutError(`no TCP reply from ${to.host}:${to.port} in ${timeoutMs} ms`)), timeoutMs);
    sock.on("connect", () => sock.write(frameTcp(query)));
    sock.on("error", (e) => finish(new TransportError(e.message)));
    sock.on("close", () => finish(new TransportError(`TCP connection to ${to.host}:${to.port} closed before a reply`)));
    sock.on("data", (chunk) => {
      const frames = reader.feed(chunk);
      if (frames.length > 0) finish(null, frames[0]);
    });
  });
}

/**
 * Forwards `query` (the client's raw bytes) to `to`. Tries UDP first; if the reply has TC=1 (truncated), retries
 * the SAME query over TCP and returns that instead. Throws TimeoutError/TransportError on failure -- never hangs,
 * never throws anything else (the caller maps any throw to SERVFAIL).
 */
export async function forwardQuery(query: Buffer, to: Endpoint, opts: ForwardOptions): Promise<Buffer> {
  const udpReply = await queryUdp(to, query, opts.udpTimeoutMs, opts.onUdpBound);
  const header = decodeHeader(udpReply); // 12-byte peek, cheap; a bad reply here just throws WireError -> SERVFAIL
  if (!header.tc) return udpReply;
  return queryTcp(to, query, opts.tcpTimeoutMs);
}
