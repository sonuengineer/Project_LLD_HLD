/**
 * DNS wire format (RFC 1035 section 4, RFC 3596 for AAAA, RFC 3597 for unknown types).
 *
 * Everything that reads from a packet is BOUNDS CHECKED: a truncated, garbage or hostile packet makes decodeMessage()
 * throw a WireError -- it never reads past the buffer, never loops forever and never allocates more than the packet
 * itself could describe. The resolver treats a WireError from a server like a timeout: try the next server.
 *
 * Names are plain strings without the trailing dot ("www.example.com", root = ""). Label bytes that are not
 * printable ASCII, and "." or "\" inside a label, are written in presentation escapes ("\046" or "\."), so a
 * label that contains a dot can never be confused with two labels.
 */
import { isIPv4, isIPv6 } from "node:net";

export class WireError extends Error {
  override name = "WireError";
}

export const TYPE = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, OPT: 41, ANY: 255 } as const;
export const CLASS_IN = 1;
export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 } as const;
export const OPCODE_QUERY = 0;

/** Most compression pointers one name may follow. Real names need a handful; this bounds the work per name. */
export const MAX_POINTER_JUMPS = 32;
export const MAX_NAME_WIRE_LENGTH = 255;
export const MAX_LABEL_LENGTH = 63;

const TYPE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TYPE).map(([k, v]) => [v, k]));
export const typeName = (t: number): string => TYPE_NAMES[t] ?? `TYPE${t}`;
const RCODE_NAMES: Record<number, string> = Object.fromEntries(Object.entries(RCODE).map(([k, v]) => [v, k]));
export const rcodeName = (r: number): string => RCODE_NAMES[r] ?? `RCODE${r}`;

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

export type RData =
  | { kind: "A"; address: string }
  | { kind: "AAAA"; address: string }
  | { kind: "NS"; host: string }
  | { kind: "CNAME"; target: string }
  | { kind: "PTR"; host: string }
  | { kind: "MX"; preference: number; exchange: string }
  /** Character-strings decoded as latin1, so every byte survives a decode/encode round trip. */
  | { kind: "TXT"; texts: string[] }
  | { kind: "SOA"; mname: string; rname: string; serial: number; refresh: number; retry: number; expire: number; minimum: number }
  /** Any type we do not understand (and OPT): the rdata bytes are kept as they are (RFC 3597). */
  | { kind: "RAW"; bytes: Buffer };

export interface ResourceRecord {
  name: string;
  type: number;
  class: number;
  ttl: number;
  data: RData;
}

export interface Message {
  header: Header;
  questions: Question[];
  answers: ResourceRecord[];
  authority: ResourceRecord[];
  additional: ResourceRecord[];
}

// ---------------------------------------------------------------------------------------------------------------
// names

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function escapeLabel(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) {
    if (b === 0x2e || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b > 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += "\\" + String(b).padStart(3, "0");
  }
  return out;
}

/** Splits a presentation name into raw label bytes, honouring "\." and "\DDD" escapes. */
export function nameToLabels(name: string): Buffer[] {
  if (name === "" || name === ".") return [];
  const labels: Buffer[] = [];
  let cur: number[] = [];
  for (let i = 0; i < name.length; i++) {
    const ch = name.charCodeAt(i);
    if (ch > 0x7e) throw new WireError(`non-ASCII character in name ${JSON.stringify(name)}`);
    if (ch === 0x5c) {
      const d = name.slice(i + 1, i + 4);
      if (/^\d{3}$/.test(d)) {
        const v = Number(d);
        if (v > 255) throw new WireError(`bad escape \\${d} in name`);
        cur.push(v);
        i += 3;
      } else if (i + 1 < name.length) {
        cur.push(name.charCodeAt(++i));
      } else throw new WireError("name ends with a backslash");
    } else if (ch === 0x2e) {
      if (cur.length === 0) throw new WireError(`empty label in name ${JSON.stringify(name)}`);
      labels.push(Buffer.from(cur));
      cur = [];
      if (i === name.length - 1) return checkLabels(labels, name); // trailing dot
    } else cur.push(ch);
  }
  if (cur.length === 0) throw new WireError(`empty label in name ${JSON.stringify(name)}`);
  labels.push(Buffer.from(cur));
  return checkLabels(labels, name);
}

function checkLabels(labels: Buffer[], name: string): Buffer[] {
  let wire = 1;
  for (const l of labels) {
    if (l.length > MAX_LABEL_LENGTH) throw new WireError(`label longer than 63 bytes in ${JSON.stringify(name)}`);
    wire += l.length + 1;
  }
  if (wire > MAX_NAME_WIRE_LENGTH) throw new WireError(`name longer than 255 bytes: ${JSON.stringify(name)}`);
  return labels;
}

/** Canonical form for comparing and caching: ASCII-lowercase, no trailing dot. Case of other bytes is kept. */
export function canonicalName(name: string): string {
  return nameToLabels(name).map((l) => asciiLower(escapeLabel(l))).join(".");
}

export const sameName = (a: string, b: string) => canonicalName(a) === canonicalName(b);

/** True if `child` is `parent` or below it, compared label by label ("a\.example.com" is NOT under example.com). */
export function isSubdomain(child: string, parent: string): boolean {
  const c = splitCanonical(child);
  const p = splitCanonical(parent);
  if (p.length > c.length) return false;
  for (let i = 1; i <= p.length; i++) if (c[c.length - i] !== p[p.length - i]) return false;
  return true;
}

function splitCanonical(name: string): string[] {
  return nameToLabels(name).map((l) => asciiLower(escapeLabel(l)));
}

/** The name with its first label removed ("www.example.com" -> "example.com", "com" -> ""). */
export function parentName(name: string): string {
  const labels = splitCanonical(name);
  return labels.slice(1).join(".");
}

export const labelCount = (name: string) => nameToLabels(name).length;

// ---------------------------------------------------------------------------------------------------------------
// addresses

function ipv4ToBytes(a: string): number[] {
  if (!isIPv4(a)) throw new WireError(`not an IPv4 address: ${a}`);
  return a.split(".").map(Number);
}

function ipv6ToBytes(a: string): number[] {
  if (!isIPv6(a) || a.includes(".") || a.includes("%")) throw new WireError(`not a plain IPv6 address: ${a}`);
  const [head, tail] = a.includes("::") ? a.split("::") as [string, string] : [a, undefined];
  const h = head === "" ? [] : head.split(":");
  const t = tail === undefined || tail === "" ? [] : tail.split(":");
  const groups = tail === undefined ? h : [...h, ...Array<string>(8 - h.length - t.length).fill("0"), ...t];
  const out: number[] = [];
  for (const g of groups) {
    const v = parseInt(g, 16);
    out.push(v >> 8, v & 0xff);
  }
  return out;
}

/** RFC 5952 text form: lowercase, no leading zeros, the longest run (>= 2) of zero groups as "::". */
export function formatIpv6(bytes: Buffer): string {
  const g: number[] = [];
  for (let i = 0; i < 16; i += 2) g.push((bytes[i]! << 8) | bytes[i + 1]!);
  let bestAt = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestAt = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (xs: number[]) => xs.map((x) => x.toString(16)).join(":");
  if (bestAt < 0) return hex(g);
  return `${hex(g.slice(0, bestAt))}::${hex(g.slice(bestAt + bestLen))}`;
}

// ---------------------------------------------------------------------------------------------------------------
// decoding

class Reader {
  pos = 0;
  constructor(readonly buf: Buffer) {}

  need(n: number, what: string) {
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
  bytes(n: number, what: string): Buffer {
    this.need(n, what);
    const b = Buffer.from(this.buf.subarray(this.pos, this.pos + n)); // copy: never keep the whole packet alive
    this.pos += n;
    return b;
  }
  name(): string {
    const { name, end } = readName(this.buf, this.pos);
    this.pos = end;
    return name;
  }
}

/**
 * Reads a possibly compressed name starting at `start`. Returns the name and the offset just after it IN PLACE
 * (a pointer is 2 bytes no matter how long the name it points to is).
 *
 * Loop protection, two independent rules:
 *  1. a pointer must point strictly BEFORE the start of the labels currently being read. Targets therefore
 *     strictly decrease, so following pointers always ends (a pointer to itself, or A -> B -> A, is rejected);
 *  2. at most MAX_POINTER_JUMPS pointers per name, which bounds the work even for a long backwards chain.
 */
export function readName(buf: Buffer, start: number): { name: string; end: number } {
  const labels: string[] = [];
  let pos = start;
  let runStart = start; // start of the label run we are in; a pointer must go below it
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
    labels.push(escapeLabel(buf.subarray(pos + 1, pos + 1 + len)));
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

/** Only the 12-byte header; used to answer FORMERR to a packet whose body is broken. */
export function decodeHeader(buf: Buffer): Header {
  if (buf.length < 12) throw new WireError(`truncated: header needs 12 bytes, got ${buf.length}`);
  return readHeader(new Reader(buf));
}

function readRData(r: Reader, type: number, rdlength: number): RData {
  const rdStart = r.pos;
  r.need(rdlength, "rdata");
  const rdEnd = rdStart + rdlength;
  // A name inside rdata may point anywhere earlier in the message, but its in-place bytes must stay inside rdata.
  const name = () => {
    const n = r.name();
    if (r.pos > rdEnd) throw new WireError(`name in rdata at offset ${rdStart} runs past rdlength`);
    return n;
  };
  let data: RData;
  switch (type) {
    case TYPE.A:
      if (rdlength !== 4) throw new WireError(`A record with rdlength ${rdlength}`);
      data = { kind: "A", address: [...r.bytes(4, "A rdata")].join(".") };
      break;
    case TYPE.AAAA:
      if (rdlength !== 16) throw new WireError(`AAAA record with rdlength ${rdlength}`);
      data = { kind: "AAAA", address: formatIpv6(r.bytes(16, "AAAA rdata")) };
      break;
    case TYPE.NS:
      data = { kind: "NS", host: name() };
      break;
    case TYPE.CNAME:
      data = { kind: "CNAME", target: name() };
      break;
    case TYPE.PTR:
      data = { kind: "PTR", host: name() };
      break;
    case TYPE.MX: {
      if (rdlength < 3) throw new WireError(`MX record with rdlength ${rdlength}`);
      const preference = r.u16("MX preference");
      data = { kind: "MX", preference, exchange: name() };
      break;
    }
    case TYPE.TXT: {
      const texts: string[] = [];
      while (r.pos < rdEnd) {
        const len = r.u8("TXT length");
        if (r.pos + len > rdEnd) throw new WireError(`TXT string at offset ${r.pos - 1} runs past rdlength`);
        texts.push(r.bytes(len, "TXT string").toString("latin1"));
      }
      data = { kind: "TXT", texts };
      break;
    }
    case TYPE.SOA: {
      const mname = name();
      const rname = name();
      if (r.pos + 20 > rdEnd) throw new WireError(`SOA record too short for its five numbers`);
      data = {
        kind: "SOA",
        mname,
        rname,
        serial: r.u32("SOA serial"),
        refresh: r.u32("SOA refresh"),
        retry: r.u32("SOA retry"),
        expire: r.u32("SOA expire"),
        minimum: r.u32("SOA minimum"),
      };
      break;
    }
    default:
      data = { kind: "RAW", bytes: r.bytes(rdlength, "rdata") };
  }
  if (r.pos !== rdEnd) throw new WireError(`${typeName(type)} rdata used ${r.pos - rdStart} of ${rdlength} bytes`);
  return data;
}

function readRecord(r: Reader): ResourceRecord {
  const name = r.name();
  const type = r.u16("RR type");
  const klass = r.u16("RR class");
  const ttl = r.u32("RR ttl");
  const rdlength = r.u16("RR rdlength");
  return { name, type, class: klass, ttl, data: readRData(r, type, rdlength) };
}

/** Decodes a whole message. Throws WireError on anything malformed. Bytes after the last record are ignored. */
export function decodeMessage(buf: Buffer): Message {
  if (buf.length < 12) throw new WireError(`truncated: header needs 12 bytes, got ${buf.length}`);
  const r = new Reader(buf);
  const header = readHeader(r);
  const qd = r.u16("qdcount");
  const an = r.u16("ancount");
  const ns = r.u16("nscount");
  const ar = r.u16("arcount");
  // Counts are attacker-controlled, but every question is >= 5 bytes and every record >= 11, so the bounds checks
  // stop a huge count after at most buf.length / 5 iterations. No array is pre-sized from a count.
  const questions: Question[] = [];
  for (let i = 0; i < qd; i++) questions.push({ name: r.name(), type: r.u16("question type"), class: r.u16("question class") });
  const section = (n: number) => {
    const out: ResourceRecord[] = [];
    for (let i = 0; i < n; i++) out.push(readRecord(r));
    return out;
  };
  return { header, questions, answers: section(an), authority: section(ns), additional: section(ar) };
}

// ---------------------------------------------------------------------------------------------------------------
// encoding

class Writer {
  private buf = Buffer.alloc(512);
  len = 0;
  /** canonical suffix -> offset where it was first written, for compression */
  private names = new Map<string, number>();

  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    const next = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.len++] = v;
  }
  u16(v: number) {
    this.grow(2);
    this.buf.writeUInt16BE(v, this.len);
    this.len += 2;
  }
  u32(v: number) {
    this.grow(4);
    this.buf.writeUInt32BE(v >>> 0, this.len);
    this.len += 4;
  }
  bytes(b: Buffer) {
    this.grow(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  patchU16(at: number, v: number) {
    this.buf.writeUInt16BE(v, at);
  }
  /** Writes a name, replacing the longest suffix already in the message with a pointer to it. */
  name(name: string, compress = true) {
    const labels = nameToLabels(name);
    for (let i = 0; i < labels.length; i++) {
      const key = labels.slice(i).map((l) => asciiLower(escapeLabel(l))).join(".");
      const at = this.names.get(key);
      if (compress && at !== undefined) {
        this.u16(0xc000 | at);
        return;
      }
      if (this.len < 0x4000) this.names.set(key, this.len); // a pointer has 14 bits
      this.u8(labels[i]!.length);
      this.bytes(labels[i]!);
    }
    this.u8(0);
  }
  done(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }
}

function writeRData(w: Writer, rr: ResourceRecord) {
  const d = rr.data;
  switch (d.kind) {
    case "A":
      for (const b of ipv4ToBytes(d.address)) w.u8(b);
      return;
    case "AAAA":
      for (const b of ipv6ToBytes(d.address)) w.u8(b);
      return;
    case "NS":
      return w.name(d.host);
    case "CNAME":
      return w.name(d.target);
    case "PTR":
      return w.name(d.host);
    case "MX":
      w.u16(d.preference);
      return w.name(d.exchange);
    case "TXT":
      for (const t of d.texts) {
        const b = Buffer.from(t, "latin1");
        if (b.length > 255) throw new WireError("TXT string longer than 255 bytes");
        w.u8(b.length);
        w.bytes(b);
      }
      return;
    case "SOA":
      w.name(d.mname);
      w.name(d.rname);
      for (const v of [d.serial, d.refresh, d.retry, d.expire, d.minimum]) w.u32(v);
      return;
    case "RAW":
      return w.bytes(d.bytes);
  }
}

export interface EncodeOptions {
  /** default true; false writes every name in full (used by tests to compare sizes) */
  compress?: boolean;
}

export function encodeMessage(m: Message, opts: EncodeOptions = {}): Buffer {
  const compress = opts.compress ?? true;
  const w = new Writer();
  const h = m.header;
  w.u16(h.id);
  w.u8((h.qr ? 0x80 : 0) | ((h.opcode & 0x0f) << 3) | (h.aa ? 0x04 : 0) | (h.tc ? 0x02 : 0) | (h.rd ? 0x01 : 0));
  w.u8((h.ra ? 0x80 : 0) | (h.rcode & 0x0f));
  for (const n of [m.questions.length, m.answers.length, m.authority.length, m.additional.length]) {
    if (n > 0xffff) throw new WireError("section has more than 65535 entries");
    w.u16(n);
  }
  for (const q of m.questions) {
    w.name(q.name, compress);
    w.u16(q.type);
    w.u16(q.class);
  }
  for (const rr of [...m.answers, ...m.authority, ...m.additional]) {
    w.name(rr.name, compress);
    w.u16(rr.type);
    w.u16(rr.class);
    w.u32(rr.ttl);
    const lenAt = w.len;
    w.u16(0);
    if (compress) writeRData(w, rr);
    else writeRDataNoCompress(w, rr);
    const rdlength = w.len - lenAt - 2;
    if (rdlength > 0xffff) throw new WireError("rdata longer than 65535 bytes");
    w.patchU16(lenAt, rdlength);
  }
  if (w.len > 0xffff) throw new WireError("message longer than 65535 bytes");
  return w.done();
}

function writeRDataNoCompress(w: Writer, rr: ResourceRecord) {
  const d = rr.data;
  if (d.kind === "NS" || d.kind === "PTR") return w.name(d.host, false);
  if (d.kind === "CNAME") return w.name(d.target, false);
  if (d.kind === "MX") {
    w.u16(d.preference);
    return w.name(d.exchange, false);
  }
  if (d.kind === "SOA") {
    w.name(d.mname, false);
    w.name(d.rname, false);
    for (const v of [d.serial, d.refresh, d.retry, d.expire, d.minimum]) w.u32(v);
    return;
  }
  return writeRData(w, rr);
}

// ---------------------------------------------------------------------------------------------------------------
// helpers for building messages

export function emptyHeader(id: number): Header {
  return { id, qr: false, opcode: OPCODE_QUERY, aa: false, tc: false, rd: false, ra: false, rcode: RCODE.NOERROR };
}

export function buildQuery(id: number, name: string, type: number, rd = false): Message {
  return {
    header: { ...emptyHeader(id), rd },
    questions: [{ name, type, class: CLASS_IN }],
    answers: [],
    authority: [],
    additional: [],
  };
}

/** One line per record, dig-like; used by the CLI and in test failure messages. */
export function formatRecord(rr: ResourceRecord): string {
  const d = rr.data;
  let v: string;
  switch (d.kind) {
    case "A":
    case "AAAA":
      v = d.address;
      break;
    case "NS":
    case "PTR":
      v = d.host + ".";
      break;
    case "CNAME":
      v = d.target + ".";
      break;
    case "MX":
      v = `${d.preference} ${d.exchange}.`;
      break;
    case "TXT":
      v = d.texts.map((t) => JSON.stringify(t)).join(" ");
      break;
    case "SOA":
      v = `${d.mname}. ${d.rname}. ${d.serial} ${d.refresh} ${d.retry} ${d.expire} ${d.minimum}`;
      break;
    case "RAW":
      v = `\\# ${d.bytes.length} ${d.bytes.toString("hex")}`;
  }
  return `${rr.name}.\t${rr.ttl}\tIN\t${typeName(rr.type)}\t${v}`;
}
