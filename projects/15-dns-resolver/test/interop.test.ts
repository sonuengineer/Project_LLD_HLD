/**
 * Interop with a real DNS client: Windows' own nslookup.exe.
 *
 * Part 1 (always on): three packets that nslookup.exe really sent on this machine (Windows 11, build 10.0.26200),
 * captured on 2026-11-21 with a plain UDP listener, are decoded and answered by the stub server.
 *
 * Part 2 (opt-in, INTEROP_NSLOOKUP=1): nslookup.exe is run against the stub server. Finding: this nslookup build
 * IGNORES `-port=N` (and `set port=N`) and always sends to port 53 -- checked by listening on both 53 and N; only 53
 * received anything. So the live part binds 127.0.0.1:53 (loopback only), which may clash with a local DNS service
 * on other machines; that is why it is opt-in.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Resolver } from "../src/resolver.js";
import { DnsServer } from "../src/server.js";
import { RCODE, TYPE, decodeMessage, type Message } from "../src/wire.js";
import { FAKE_ROOT_HINTS, buildNet } from "./fixtures.js";

/** Captured from nslookup.exe: `nslookup www.alpha.test. 127.0.0.1` sends a PTR for the server, then A, then AAAA. */
export const NSLOOKUP_PACKETS = {
  ptr: "0001010000010000000000000131013001300331323707696e2d61646472046172706100000c0001",
  a: "0002010000010000000000000377777705616c70686104746573740000010001",
  aaaa: "0003010000010000000000000377777705616c706861047465737400001c0001",
};

const NSLOOKUP = "C:\\Windows\\System32\\nslookup.exe";
const live = process.env.INTEROP_NSLOOKUP === "1" && process.platform === "win32" && existsSync(NSLOOKUP);

class RecordingServer extends DnsServer {
  readonly seen: { transport: string; message: Message }[] = [];
  override async handle(buf: Buffer, transport: "udp" | "tcp") {
    this.seen.push({ transport, message: decodeMessage(buf) }); // throws (and fails the test) if we cannot parse it
    return super.handle(buf, transport);
  }
}

function nslookup(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(NSLOOKUP, args, { timeout: 15_000, windowsHide: true }, (_err, stdout, stderr) => resolve(`${stdout}\n${stderr}`));
  });
}

const fake = buildNet();
const newServer = (port: number) =>
  new RecordingServer({
    resolver: new Resolver({ rootHints: FAKE_ROOT_HINTS, route: fake.route, timeoutMs: 1000, shuffle: false }),
    port,
  });

beforeAll(() => fake.start());
afterAll(() => fake.stop());

describe("interop: packets captured from nslookup.exe", () => {
  it("decode as plain recursive queries (RD=1, one question, no EDNS)", () => {
    const ptr = decodeMessage(Buffer.from(NSLOOKUP_PACKETS.ptr, "hex"));
    expect(ptr.header).toMatchObject({ id: 1, rd: true, qr: false, opcode: 0 });
    expect(ptr.questions).toEqual([{ name: "1.0.0.127.in-addr.arpa", type: TYPE.PTR, class: 1 }]);
    expect(ptr.additional).toEqual([]);
    expect(decodeMessage(Buffer.from(NSLOOKUP_PACKETS.a, "hex")).questions[0]).toEqual({ name: "www.alpha.test", type: TYPE.A, class: 1 });
    expect(decodeMessage(Buffer.from(NSLOOKUP_PACKETS.aaaa, "hex")).questions[0]).toEqual({ name: "www.alpha.test", type: TYPE.AAAA, class: 1 });
  });

  it("the stub server answers each captured packet", async () => {
    const s = newServer(0);
    const reply = async (hex: string) => decodeMessage((await s.handle(Buffer.from(hex, "hex"), "udp"))!);
    const a = await reply(NSLOOKUP_PACKETS.a);
    expect(a.header).toMatchObject({ id: 2, qr: true, ra: true, rcode: RCODE.NOERROR });
    expect(a.answers).toHaveLength(2);
    const aaaa = await reply(NSLOOKUP_PACKETS.aaaa);
    expect(aaaa.answers[0]!.data).toEqual({ kind: "AAAA", address: "2001:db8::80" });
    // the fake root has no in-addr.arpa zone, so the reverse lookup of the server is NXDOMAIN
    expect((await reply(NSLOOKUP_PACKETS.ptr)).header.rcode).toBe(RCODE.NXDOMAIN);
  });
});

describe.skipIf(!live)("interop: live nslookup.exe against the stub server on 127.0.0.1:53 (INTEROP_NSLOOKUP=1)", () => {
  let server: RecordingServer;

  beforeAll(async () => {
    server = newServer(53);
    await server.listen();
  });
  afterAll(() => server?.close());

  it("resolves an A record through us, and we parsed every packet it sent", async () => {
    const out = await nslookup(["-timeout=3", "www.alpha.test.", "127.0.0.1"]);
    expect(out).toContain("192.0.2.80");
    expect(out).toContain("192.0.2.81");
    const q = server.seen.find((s) => s.message.questions[0]?.name.toLowerCase() === "www.alpha.test" && s.message.questions[0]?.type === TYPE.A);
    expect(q, `packets seen: ${JSON.stringify(server.seen.map((s) => s.message.questions))}`).toBeDefined();
    expect(q!.message.header.rd).toBe(true);
  }, 20_000);

  it("-type=MX, and NXDOMAIN", async () => {
    const mx = await nslookup(["-timeout=3", "-type=MX", "alpha.test.", "127.0.0.1"]);
    expect(mx).toMatch(/mail exchanger = mail\.alpha\.test/i);
    const nx = await nslookup(["-timeout=3", "nope.alpha.test.", "127.0.0.1"]);
    expect(nx).toMatch(/Non-existent domain/i);
  }, 30_000);

  it("-vc (TCP) gets the big TXT record that does not fit in 512 bytes of UDP", async () => {
    const before = server.seen.filter((s) => s.transport === "tcp").length;
    const out = await nslookup(["-timeout=3", "-vc", "-type=TXT", "big.alpha.test.", "127.0.0.1"]);
    expect(out).toContain("chunk-00");
    expect(out).toContain("chunk-29");
    expect(server.seen.filter((s) => s.transport === "tcp").length).toBeGreaterThan(before);
  }, 20_000);
});
