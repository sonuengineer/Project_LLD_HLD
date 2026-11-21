/**
 * The server-to-server ("route") protocol. It is OUR OWN, inspired by NATS routes but NOT compatible with them.
 *
 *   RINFO {"server_id":"..."}\r\n              first line in both directions: who am I
 *   RS+ <subject> [queue]\r\n                  I now have interest in this subject (and queue group)
 *   RS- <subject> [queue]\r\n                  I no longer have it
 *   RMSG {meta json} <#bytes>\r\n<payload>\r\n  a message for YOUR local subscribers
 *   PING\r\n  PONG\r\n                         liveness, same rule as for clients
 *
 * RMSG meta: { s: subject, r?: reply, p: deliver to your plain subscribers?, q?: queue groups YOU must serve (one member
 * each), h?: header length }. The JSON is written by JSON.stringify, which never emits spaces, and subjects and queue
 * names cannot contain whitespace, so "the last space separates meta from size" is unambiguous.
 */
import { Framer, ParseError } from "./framer.js";
import { parseCount, HEADER_PREFIX } from "./parser.js";
import { isValidPublishSubject, isValidSubscribeSubject } from "./subjects.js";

export interface RouteMsgMeta {
  s: string;
  r?: string;
  p: boolean;
  q?: string[];
  h?: number;
}

export type RouteOp =
  | { op: "RINFO"; serverId: string }
  | { op: "RS+" | "RS-"; subject: string; queue: string | undefined }
  | { op: "RMSG"; meta: RouteMsgMeta; payload: Buffer }
  | { op: "PING" }
  | { op: "PONG" };

const QUEUE_NAME = /^[^\s.*>]+$/;

export class RouteParser {
  private readonly framer: Framer;
  private pending: RouteMsgMeta | null = null;

  constructor(
    private readonly limits: { maxControlLine: number; maxPayload: number },
    private readonly onOp: (op: RouteOp) => void,
  ) {
    this.framer = new Framer(limits.maxControlLine, (l) => this.line(l), (p) => this.payload(p));
  }

  feed(chunk: Buffer): void {
    this.framer.feed(chunk);
  }

  private payload(payload: Buffer): void {
    const meta = this.pending!;
    this.pending = null;
    if (meta.h !== undefined && !payload.subarray(0, HEADER_PREFIX.length).equals(HEADER_PREFIX)) {
      throw new ParseError("Route Protocol Error: bad headers");
    }
    this.onOp({ op: "RMSG", meta, payload });
  }

  private line(line: string): void {
    const space = line.indexOf(" ");
    const name = space < 0 ? line : line.slice(0, space);
    const rest = space < 0 ? "" : line.slice(space + 1);
    switch (name) {
      case "PING":
      case "PONG":
        this.onOp({ op: name });
        return;
      case "RINFO": {
        let info: unknown;
        try {
          info = JSON.parse(rest);
        } catch {
          throw new ParseError("Route Protocol Error: bad RINFO");
        }
        const id = (info as { server_id?: unknown } | null)?.server_id;
        if (typeof id !== "string" || id.length === 0) throw new ParseError("Route Protocol Error: bad RINFO");
        this.onOp({ op: "RINFO", serverId: id });
        return;
      }
      case "RS+":
      case "RS-": {
        const args = rest.split(" ");
        if (args.length < 1 || args.length > 2 || !isValidSubscribeSubject(args[0]!)) {
          throw new ParseError(`Route Protocol Error: bad ${name}`);
        }
        if (args.length === 2 && !QUEUE_NAME.test(args[1]!)) throw new ParseError(`Route Protocol Error: bad ${name}`);
        this.onOp({ op: name, subject: args[0]!, queue: args[1] });
        return;
      }
      case "RMSG": {
        const cut = rest.lastIndexOf(" ");
        const size = cut < 0 ? undefined : parseCount(rest.slice(cut + 1));
        if (size === undefined) throw new ParseError("Route Protocol Error: bad RMSG");
        if (size > this.limits.maxPayload) throw new ParseError("Maximum Payload Violation");
        let meta: RouteMsgMeta;
        try {
          meta = JSON.parse(rest.slice(0, cut)) as RouteMsgMeta;
        } catch {
          throw new ParseError("Route Protocol Error: bad RMSG");
        }
        if (!validMeta(meta, size)) throw new ParseError("Route Protocol Error: bad RMSG");
        this.pending = meta;
        this.framer.expect(size);
        return;
      }
      default:
        throw new ParseError("Route Protocol Error: unknown operation");
    }
  }
}

function validMeta(m: RouteMsgMeta, size: number): boolean {
  if (m === null || typeof m !== "object") return false;
  if (typeof m.s !== "string" || !isValidPublishSubject(m.s)) return false;
  if (m.r !== undefined && (typeof m.r !== "string" || !isValidPublishSubject(m.r))) return false;
  if (typeof m.p !== "boolean") return false;
  if (m.q !== undefined && (!Array.isArray(m.q) || !m.q.every((q) => typeof q === "string" && QUEUE_NAME.test(q)))) return false;
  if (m.h !== undefined && (typeof m.h !== "number" || !Number.isInteger(m.h) || m.h < HEADER_PREFIX.length || m.h > size)) return false;
  return true;
}

export const encodeRinfo = (serverId: string): string => `RINFO ${JSON.stringify({ server_id: serverId })}\r\n`;

export const encodeInterest = (op: "RS+" | "RS-", subject: string, queue: string | undefined): string =>
  `${op} ${subject}${queue === undefined ? "" : " " + queue}\r\n`;

export function encodeRmsg(meta: RouteMsgMeta, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`RMSG ${JSON.stringify(meta)} ${payload.length}\r\n`), payload, Buffer.from("\r\n")]);
}
