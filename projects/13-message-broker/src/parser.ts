/**
 * Streaming parser for the client -> server half of the core NATS text protocol.
 *
 *   CONNECT {json}\r\n
 *   PUB <subject> [reply-to] <#bytes>\r\n<payload>\r\n
 *   HPUB <subject> [reply-to] <#header bytes> <#total bytes>\r\n<headers><payload>\r\n
 *   SUB <subject> [queue group] <sid>\r\n
 *   UNSUB <sid> [max-msgs]\r\n
 *   PING\r\n   PONG\r\n
 *
 * Framing (split reads, byte-counted payloads, the control-line limit) lives in framer.ts. This file decides what each
 * line means.
 *
 * Limits are enforced while reading, not after: a PUB that DECLARES more than maxPayload bytes is rejected before any
 * of the payload is buffered. That is what stops one client from making the server hold an unbounded amount of memory.
 *
 * HPUB and PUB become the same operation: for HPUB, `headerLen` says how many of the payload's first bytes are the
 * header block ("NATS/1.0\r\nKey: value\r\n\r\n"); for PUB it is undefined. The total (headers + body) counts against
 * maxPayload, as in nats-server.
 */
import { Framer, ParseError } from "./framer.js";

export { ParseError };

export type Op =
  | { op: "CONNECT"; options: Record<string, unknown> }
  | { op: "PUB"; subject: string; reply: string | undefined; headerLen: number | undefined; payload: Buffer }
  | { op: "SUB"; subject: string; queue: string | undefined; sid: string }
  | { op: "UNSUB"; sid: string; max: number | undefined }
  | { op: "PING" }
  | { op: "PONG" };

export interface ParserLimits {
  maxControlLine: number;
  maxPayload: number;
}

interface PendingPub {
  subject: string;
  reply: string | undefined;
  headerLen: number | undefined;
}

export const HEADER_PREFIX = Buffer.from("NATS/1.0");

export class Parser {
  private readonly framer: Framer;
  private pending: PendingPub | null = null;

  constructor(
    private readonly limits: ParserLimits,
    private readonly onOp: (op: Op) => void,
  ) {
    this.framer = new Framer(
      limits.maxControlLine,
      (line) => this.handleLine(line),
      (payload) => this.handlePayload(payload),
    );
  }

  /** Bytes received but not yet turned into an operation (tests use it to prove nothing is held back). */
  get buffered(): number {
    return this.framer.buffered;
  }

  /**
   * Feed bytes from the socket. Calls onOp for every complete operation, in order. Throws ParseError on the first
   * protocol violation; after that the parser ignores further input (the connection is going to be closed).
   */
  feed(chunk: Buffer): void {
    this.framer.feed(chunk);
  }

  private handlePayload(payload: Buffer): void {
    const { subject, reply, headerLen } = this.pending!;
    this.pending = null;
    if (headerLen !== undefined && !payload.subarray(0, HEADER_PREFIX.length).equals(HEADER_PREFIX)) {
      throw new ParseError("Protocol Error: headers must start with NATS/1.0");
    }
    this.onOp({ op: "PUB", subject, reply, headerLen, payload });
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
        this.pending = { subject: args[0]!, reply: args.length === 3 ? args[1] : undefined, headerLen: undefined };
        this.framer.expect(size);
        return;
      }
      case "HPUB": {
        if (args.length !== 3 && args.length !== 4) {
          throw new ParseError("Invalid HPUB: expected subject [reply] header-size total-size");
        }
        const headerLen = parseCount(args[args.length - 2]!);
        const size = parseCount(args[args.length - 1]!);
        if (headerLen === undefined || size === undefined) throw new ParseError("Invalid HPUB: bad size");
        if (headerLen > size || headerLen < HEADER_PREFIX.length) throw new ParseError("Invalid HPUB: bad header size");
        if (size > this.limits.maxPayload) throw new ParseError("Maximum Payload Violation");
        this.pending = { subject: args[0]!, reply: args.length === 4 ? args[1] : undefined, headerLen };
        this.framer.expect(size);
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
export function parseCount(s: string): number | undefined {
  if (!/^\d{1,15}$/.test(s)) return undefined;
  return Number(s);
}
