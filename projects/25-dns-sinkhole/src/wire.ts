/**
 * DNS wire format (RFC 1035 section 4) -- JUST enough to proxy correctly. This is a relay, not a resolver: we only
 * need to read a client's question and an upstream server's answer TTLs, and build small responses ourselves
 * (block pages, SERVFAIL, FORMERR). Record data we do not need to understand (NS/CNAME/MX/TXT/SOA/... rdata) is
 * never decoded -- it is relayed to the client as the exact bytes the upstream sent (see transport.ts / proxy.ts),
 * which also sidesteps a real hazard: an rdata that contains a compressed name (CNAME, NS, SOA, MX, PTR) can only be
 * copied byte-for-byte into a NEW packet if that packet has the exact same bytes before it. We never rebuild an
 * upstream answer into a new packet, so that hazard never applies to us.
 *
 * Scope cuts from here, both deliberate (see PLAN.md "Not in scope"):
 *  - No RFC 1035 presentation escapes (`\DDD`, `\.`). Every byte of a label is kept via a latin1 string (so it
 *    round-trips exactly, byte for byte, same trick 15-dns-resolver uses for TXT), but a label containing a literal
 *    "." byte would be mis-split on re-encode. Real DNS hostnames never do this, so we accept the limitation.
 *  - Only A and AAAA rdata are ever built BY US (for sinkhole answers); everything else we only skip over with
 *    rdlength, we never interpret it.
 */

export class WireError extends Error {
  override name = "WireError";
}

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28 } as const;
export const CLASS_IN = 1;
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
export const OPCODE_QUERY = 0;

export const MAX_POINTER_JUMPS = 32;
export const MAX_NAME_WIRE_LENGTH = 255;
export const MAX_LABEL_LENGTH = 63;

export interface Header {
  id: number;
  qr: boolean;
  opcode: number;
  aa: boolean;
  tc: boolean;
  rd: boolean;
  ra: boolean;
  rcode: number;
}

export interface Question {
  name: string;
  type: number;
  class: number;
}

/** Just enough of an answer record to compute a cache TTL: its rdata is skipped, never decoded. */
export interface AnswerMeta {
  name: string;
  type: number;
  class: number;
  ttl: number;
  /** Byte offset of this record's 4-byte TTL field within the decoded buffer, for patching it on a cache hit
   * (see cache.ts) without touching anything name- or rdata-related. */
  ttlOffset: number;
}

export interface DecodedQuery {
  header: Header;
  questions: Question[];
}

export interface DecodedResponse {
  header: Header;
  questions: Question[];
  answers: AnswerMeta[];
}

const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

/** Lowercased, no trailing dot. Used for blocklist lookups and cache keys -- never for re-encoding a name. */
export function canonicalName(name: string): string {
  return asciiLower(name).replace(/\.$/, "");
}

// ---------------------------------------------------------------------------------------------------------------
// decoding

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  need(n: number, what: string): void {
    if (this.pos + n > this.buf.length) throw new WireError(`truncated: ${what} needs ${n} byte(s) at offset ${this.pos}`);
  }
  u8(what: string): number {
    this.need(1, what);
    return this.buf[this.pos++]!;
  }
  u16(what: string): number {
    this.need(2, what);
    const v = this.buf.readUInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  u32(what: string): number {
    this.need(4, what);
    const v = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  skip(n: number, what: string): void {
    this.need(n, what);
    this.pos += n;
  }
  name(): string {
    const { name, end } = readName(this.buf, this.pos);
    this.pos = end;
    return name;
  }
}

/**
 * Reads a possibly-compressed name starting at `start`. Returns the name and the offset just after it IN PLACE (a
 * pointer is 2 bytes no matter how long the name it points to is). Two independent loop-protection rules, same as
 * 15-dns-resolver's wire.ts: a pointer must point strictly BEFORE the labels currently being read (so targets
 * strictly decrease and following pointers always ends), and at most MAX_POINTER_JUMPS pointers per name.
 */
export function readName(buf: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let pos = start;
  let runStart = start;
  let end = -1;
  let jumps = 0;
  let wireLength = 1; // the final zero byte
  for (;;) {
    if (pos >= buf.length) throw new WireError(`truncated: name at offset ${start} runs past the end`);
    const len = buf[pos]!;
    const kind = len & 0xc0;
    if (kind === 0xc0) {
      if (pos + 1 >= buf.length) throw new WireError(`truncated: compression pointer at offset ${pos}`);
      const target = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (target >= runStart) throw new WireError(`compression pointer at offset ${pos} does not point backwards (to ${target})`);
      if (++jumps > MAX_POINTER_JUMPS) throw new WireError(`name at offset ${start} follows more than ${MAX_POINTER_JUMPS} pointers`);
      if (end < 0) end = pos + 2;
      pos = target;
      runStart = target;
      continue;
    }
    if (kind !== 0) throw new WireError(`reserved label type 0x${len.toString(16)} at offset ${pos}`);
    if (len === 0) {
      if (end < 0) end = pos + 1;
      return { name: labels.join("."), end };
    }
    if (pos + 1 + len > buf.length) throw new WireError(`truncated: label at offset ${pos}`);
    wireLength += len + 1;
    if (wireLength > MAX_NAME_WIRE_LENGTH) throw new WireError(`name at offset ${start} is longer than 255 bytes`);
    labels.push(buf.toString("latin1", pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
}

function readHeader(r: Reader): Header {
  const id = r.u16("header id");
  const b2 = r.u8("header flags");
  const b3 = r.u8("header flags");
  return {
    id,
    qr: (b2 & 0x80) !== 0,
    opcode: (b2 >> 3) & 0x0f,
    aa: (b2 & 0x04) !== 0,
    tc: (b2 & 0x02) !== 0,
    rd: (b2 & 0x01) !== 0,
    ra: (b3 & 0x80) !== 0,
    rcode: b3 & 0x0f,
  };
}

/** Only the 12-byte header; used to answer FORMERR to a packet whose body is broken, and to check QR/TC cheaply. */
export function decodeHeader(buf: Buffer): Header {
  if (buf.length < 12) throw new WireError(`truncated: header needs 12 bytes, got ${buf.length}`);
  return readHeader(new Reader(buf));
}

function readQuestions(r: Reader, qdcount: number): Question[] {
  const out: Question[] = [];
  for (let i = 0; i < qdcount; i++) out.push({ name: r.name(), type: r.u16("question type"), class: r.u16("question class") });
  return out;
}

/** Header + however many questions qdcount says. Does not look past them -- a query's answer/authority/additional
 * sections (e.g. an EDNS OPT) are forwarded to upstream untouched as raw bytes, never parsed here. */
export function decodeQuery(buf: Buffer): DecodedQuery {
  if (buf.length < 12) throw new WireError(`truncated: header needs 12 bytes, got ${buf.length}`);
  const r = new Reader(buf);
  const header = readHeader(r);
  const qdcount = r.u16("qdcount");
  r.u16("ancount");
  r.u16("nscount");
  r.u16("arcount");
  return { header, questions: readQuestions(r, qdcount) };
}

/**
 * Header + questions + just enough of each answer record to get its TTL (name, type, class, ttl); rdata is skipped
 * with rdlength, never decoded. Authority/additional are not read at all -- we never need them.
 */
export function decodeResponse(buf: Buffer): DecodedResponse {
  if (buf.length < 12) throw new WireError(`truncated: header needs 12 bytes, got ${buf.length}`);
  const r = new Reader(buf);
  const header = readHeader(r);
  const qdcount = r.u16("qdcount");
  const ancount = r.u16("ancount");
  r.u16("nscount");
  r.u16("arcount");
  const questions = readQuestions(r, qdcount);
  const answers: AnswerMeta[] = [];
  for (let i = 0; i < ancount; i++) {
    const name = r.name();
    const type = r.u16("RR type");
    const klass = r.u16("RR class");
    const ttlOffset = r.pos;
    const ttl = r.u32("RR ttl");
    const rdlength = r.u16("RR rdlength");
    r.skip(rdlength, "rdata");
    answers.push({ name, type, class: klass, ttl, ttlOffset });
  }
  return { header, questions, answers };
}

// ---------------------------------------------------------------------------------------------------------------
// encoding -- only ever used for packets WE build (block answers, SERVFAIL, FORMERR), always small, so there is no
// name compression here: every name is written out in full. A forwarded upstream answer is relayed as raw bytes
// (see transport.ts) and never passes through this encoder.

/** Splits a presentation name ("a.b.com", root = "") into raw label byte buffers. No escapes (see file header). */
export function nameToLabels(name: string): Buffer[] {
  if (name === "") return [];
  return name.split(".").map((label) => {
    if (label.length === 0) throw new WireError(`empty label in name ${JSON.stringify(name)}`);
    if (label.length > MAX_LABEL_LENGTH) throw new WireError(`label longer than 63 bytes in ${JSON.stringify(name)}`);
    return Buffer.from(label, "latin1");
  });
}

function encodeName(name: string): Buffer {
  const labels = nameToLabels(name);
  let wireLength = 1;
  for (const l of labels) wireLength += l.length + 1;
  if (wireLength > MAX_NAME_WIRE_LENGTH) throw new WireError(`name longer than 255 bytes: ${JSON.stringify(name)}`);
  const parts: Buffer[] = [];
  for (const l of labels) parts.push(Buffer.from([l.length]), l);
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeHeaderBuf(h: Header, qd: number, an: number): Buffer {
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(h.id, 0);
  buf[2] = (h.qr ? 0x80 : 0) | ((h.opcode & 0x0f) << 3) | (h.aa ? 0x04 : 0) | (h.tc ? 0x02 : 0) | (h.rd ? 0x01 : 0);
  buf[3] = (h.ra ? 0x80 : 0) | (h.rcode & 0x0f);
  buf.writeUInt16BE(qd, 4);
  buf.writeUInt16BE(an, 6);
  buf.writeUInt16BE(0, 8); // nscount
  buf.writeUInt16BE(0, 10); // arcount
  return buf;
}

function encodeQuestion(q: Question): Buffer {
  const name = encodeName(q.name);
  const rest = Buffer.alloc(4);
  rest.writeUInt16BE(q.type, 0);
  rest.writeUInt16BE(q.class, 2);
  return Buffer.concat([name, rest]);
}

function ipv4ToBytes(address: string): number[] {
  const parts = address.split(".");
  if (parts.length !== 4) throw new WireError(`not an IPv4 address: ${address}`);
  return parts.map((p) => {
    if (!/^\d{1,3}$/.test(p)) throw new WireError(`not an IPv4 address: ${address}`);
    const n = Number(p);
    if (n > 255) throw new WireError(`not an IPv4 address: ${address}`);
    return n;
  });
}

/** One A resource record: name + type A + class IN + ttl + 4-byte address. */
export function encodeARecord(name: string, ttl: number, address: string): Buffer {
  const head = Buffer.concat([encodeName(name)]);
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(TYPE.A, 0);
  fixed.writeUInt16BE(CLASS_IN, 2);
  fixed.writeUInt32BE(ttl >>> 0, 4);
  fixed.writeUInt16BE(4, 8);
  return Buffer.concat([head, fixed, Buffer.from(ipv4ToBytes(address))]);
}

/** Assembles a whole message from a header, its questions, and pre-encoded answer records (see encodeARecord). */
export function encodeMessage(header: Header, questions: Question[], answers: Buffer[]): Buffer {
  const parts = [encodeHeaderBuf(header, questions.length, answers.length)];
  for (const q of questions) parts.push(encodeQuestion(q));
  parts.push(...answers);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------------------------
// test/demo helper

export function emptyHeader(id: number): Header {
  return { id, qr: false, opcode: OPCODE_QUERY, aa: false, tc: false, rd: false, ra: false, rcode: RCODE.NOERROR };
}

/** Builds a client query packet -- used by tests and the demo, mirrors 15-dns-resolver's buildQuery. */
export function buildQuery(id: number, name: string, type: number, rd = true): Buffer {
  const header = { ...emptyHeader(id), rd };
  return encodeMessage(header, [{ name, type, class: CLASS_IN }], []);
}
