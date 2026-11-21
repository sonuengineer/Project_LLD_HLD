/**
 * Streaming parser for the client -> server half of the core NATS text protocol.
 *
 *   CONNECT {json}\r\n
 *   PUB <subject> [reply-to] <#bytes>\r\n<payload>\r\n
 *   SUB <subject> [queue group] <sid>\r\n
 *   UNSUB <sid> [max-msgs]\r\n
 *   PING\r\n   PONG\r\n
 *
 * TCP is a byte stream, not a message stream: one read can hold half a line, three whole commands, or a payload that
 * contains "\r\n" itself. So the parser keeps state between feed() calls and reads payloads by their declared BYTE COUNT,
 * never by looking for a line ending inside them.
 *
 * Limits are enforced while reading, not after: a control line longer than maxControlLine is rejected as soon as that
 * many bytes arrived without a newline, and a PUB that DECLARES more than maxPayload bytes is rejected before any of the
 * payload is buffered. That is what stops one client from making the server hold an unbounded amount of memory.
 *
 * HPUB (headers) is stage 2; the server announces headers:false, so a well-behaved client never sends it.
 */

export type Op =
  | { op: "CONNECT"; options: Record<string, unknown> }
  | { op: "PUB"; subject: string; reply: string | undefined; payload: Buffer }
  | { op: "SUB"; subject: string; queue: string | undefined; sid: string }
  | { op: "UNSUB"; sid: string; max: number | undefined }
  | { op: "PING" }
  | { op: "PONG" };

/** A protocol error. The message is the text the server sends back as  -ERR '<message>'. */
export class ParseError extends Error {}

export interface ParserLimits {
  maxControlLine: number;
  maxPayload: number;
}

const LF = 10;
const CR = 13;
const EMPTY = Buffer.alloc(0);

interface PendingPub {
  subject: string;
  reply: string | undefined;
  size: number;
}

export class Parser {
  private parts: Buffer[] = [];
  private partsLen = 0;
  private pending: PendingPub | null = null;
  private dead = false;

  constructor(
    private readonly limits: ParserLimits,
    private readonly onOp: (op: Op) => void,
  ) {}

  /** Bytes received but not yet turned into an operation (tests use it to prove nothing is held back). */
  get buffered(): number {
    return this.partsLen;
  }

  /**
   * Feed bytes from the socket. Calls onOp for every complete operation, in order. Throws ParseError on the first
   * protocol violation; after that the parser ignores further input (the connection is going to be closed).
   */
  feed(chunk: Buffer): void {
    if (this.dead) return;
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.partsLen += chunk.length;
    try {
      this.drain();
    } catch (err) {
      this.dead = true;
      this.parts = [];
      this.partsLen = 0;
      throw err;
    }
  }

  private flatten(): Buffer {
    if (this.parts.length === 0) return EMPTY;
    if (this.parts.length > 1) this.parts = [Buffer.concat(this.parts, this.partsLen)];
    return this.parts[0]!;
  }

  private keep(rest: Buffer): void {
    this.parts = rest.length > 0 ? [rest] : [];
    this.partsLen = rest.length;
  }

  private drain(): void {
    while (!this.dead) {
      if (this.pending) {
        const { size } = this.pending;
        // Wait for the whole payload plus its CRLF WITHOUT copying: chunks are only joined once it is all here.
        if (this.partsLen < size + 2) return;
        const buf = this.flatten();
        if (buf[size] !== CR || buf[size + 1] !== LF) throw new ParseError("Protocol Error: payload size does not match");
        // Copy the payload so it does not keep the (possibly much larger) receive buffer alive.
        const payload = Buffer.from(buf.subarray(0, size));
        const { subject, reply } = this.pending;
        this.pending = null;
        this.keep(buf.subarray(size + 2));
        this.onOp({ op: "PUB", subject, reply, payload });
        continue;
      }

      const buf = this.flatten();
      const nl = buf.indexOf(LF);
      if (nl < 0) {
        if (buf.length > this.limits.maxControlLine) throw new ParseError("Maximum Control Line Exceeded");
        return;
      }
      const end = nl > 0 && buf[nl - 1] === CR ? nl - 1 : nl;
      if (end > this.limits.maxControlLine) throw new ParseError("Maximum Control Line Exceeded");
      const line = buf.toString("utf8", 0, end);
      this.keep(buf.subarray(nl + 1));
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed.length === 0) return; // tolerate blank lines (handy with telnet)
    const space = trimmed.search(/[ \t]/);
    const name = (space < 0 ? trimmed : trimmed.slice(0, space)).toUpperCase();
    const rest = space < 0 ? "" : trimmed.slice(space + 1).trim();
    const args = rest.length > 0 ? rest.split(/[ \t]+/) : [];

    switch (name) {
      case "PING":
        this.onOp({ op: "PING" });
        return;
      case "PONG":
        this.onOp({ op: "PONG" });
        return;
      case "CONNECT": {
        let options: unknown;
        try {
          options = JSON.parse(rest);
        } catch {
          throw new ParseError("Invalid CONNECT: bad JSON");
        }
        if (options === null || typeof options !== "object" || Array.isArray(options)) {
          throw new ParseError("Invalid CONNECT: expected a JSON object");
        }
        this.onOp({ op: "CONNECT", options: options as Record<string, unknown> });
        return;
      }
      case "PUB": {
        if (args.length !== 2 && args.length !== 3) throw new ParseError("Invalid PUB: expected subject [reply] size");
        const size = parseCount(args[args.length - 1]!);
        if (size === undefined) throw new ParseError("Invalid PUB: bad size");
        if (size > this.limits.maxPayload) throw new ParseError("Maximum Payload Violation");
        this.pending = { subject: args[0]!, reply: args.length === 3 ? args[1] : undefined, size };
        return;
      }
      case "SUB": {
        if (args.length !== 2 && args.length !== 3) throw new ParseError("Invalid SUB: expected subject [queue] sid");
        this.onOp({ op: "SUB", subject: args[0]!, queue: args.length === 3 ? args[1] : undefined, sid: args[args.length - 1]! });
        return;
      }
      case "UNSUB": {
        if (args.length !== 1 && args.length !== 2) throw new ParseError("Invalid UNSUB: expected sid [max]");
        let max: number | undefined;
        if (args.length === 2) {
          max = parseCount(args[1]!);
          if (max === undefined) throw new ParseError("Invalid UNSUB: bad max");
        }
        this.onOp({ op: "UNSUB", sid: args[0]!, max });
        return;
      }
      default:
        throw new ParseError("Unknown Protocol Operation");
    }
  }
}

/** Non-negative decimal integer, digits only (no sign, no exponent, no hex), within the safe integer range. */
function parseCount(s: string): number | undefined {
  if (!/^\d{1,15}$/.test(s)) return undefined;
  return Number(s);
}
