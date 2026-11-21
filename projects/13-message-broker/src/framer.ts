/**
 * Byte-stream framing shared by the client protocol (parser.ts) and the route protocol (route.ts).
 *
 * Both protocols are "a control line ending in CRLF, sometimes followed by a payload of N bytes and a CRLF". The framer
 * owns everything about turning TCP reads into those two kinds of frames; the protocol on top only decides what a
 * line means and, when a line announces a payload, calls expect(n).
 *
 * TCP is a byte stream, not a message stream: one read can hold half a line, three whole commands, or a payload that
 * contains "\r\n" itself. So the framer keeps state between feed() calls and reads payloads by their declared BYTE COUNT,
 * never by looking for a line ending inside them. A control line longer than maxControlLine is rejected as soon as that
 * many bytes arrived without a newline.
 */

/** A protocol error. The message is the text the server sends back as  -ERR '<message>'. */
export class ParseError extends Error {}

const LF = 10;
const CR = 13;
const EMPTY = Buffer.alloc(0);

export class Framer {
  private parts: Buffer[] = [];
  private partsLen = 0;
  private payloadSize: number | null = null;
  private dead = false;

  constructor(
    private readonly maxControlLine: number,
    private readonly onLine: (line: string) => void,
    private readonly onPayload: (payload: Buffer) => void,
  ) {}

  /** Bytes received but not yet turned into a frame (tests use it to prove nothing is held back). */
  get buffered(): number {
    return this.partsLen;
  }

  /** Called from onLine: the next `size` bytes (plus CRLF) are a payload, not a line. */
  expect(size: number): void {
    this.payloadSize = size;
  }

  /**
   * Feed bytes from the socket. Calls onLine / onPayload for every complete frame, in order. Throws ParseError on the
   * first violation (thrown by the framer itself or by a callback); after that further input is ignored.
   */
  feed(chunk: Buffer): void {
    if (this.dead || chunk.length === 0) return;
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
      if (this.payloadSize !== null) {
        const size = this.payloadSize;
        // Wait for the whole payload plus its CRLF WITHOUT copying: chunks are only joined once it is all here.
        if (this.partsLen < size + 2) return;
        const buf = this.flatten();
        if (buf[size] !== CR || buf[size + 1] !== LF) throw new ParseError("Protocol Error: payload size does not match");
        // Copy the payload so it does not keep the (possibly much larger) receive buffer alive.
        const payload = Buffer.from(buf.subarray(0, size));
        this.payloadSize = null;
        this.keep(buf.subarray(size + 2));
        this.onPayload(payload);
        continue;
      }

      const buf = this.flatten();
      const nl = buf.indexOf(LF);
      if (nl < 0) {
        if (buf.length > this.maxControlLine) throw new ParseError("Maximum Control Line Exceeded");
        return;
      }
      const end = nl > 0 && buf[nl - 1] === CR ? nl - 1 : nl;
      if (end > this.maxControlLine) throw new ParseError("Maximum Control Line Exceeded");
      const line = buf.toString("utf8", 0, end);
      this.keep(buf.subarray(nl + 1));
      this.onLine(line);
    }
  }
}
