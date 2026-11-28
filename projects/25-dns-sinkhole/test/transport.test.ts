/**
 * Unit tests for transport.ts's forwardQuery, below the proxy layer: UDP success, timeout, and the wrong-source
 * defense (a reply from an address/port that is not the configured upstream must be ignored, even if it beats
 * the real reply there).
 */
import dgram from "node:dgram";
import { afterEach, describe, expect, it } from "vitest";
import { StubUpstream } from "../src/stub-upstream.js";
import { TimeoutError, forwardQuery } from "../src/transport.js";
import { TYPE, buildQuery, decodeResponse, emptyHeader, encodeARecord, encodeMessage } from "../src/wire.js";

let stub: StubUpstream | undefined;
afterEach(async () => {
  if (stub) await stub.close();
  stub = undefined;
});

describe("forwardQuery", () => {
  it("resolves with the real upstream's reply", async () => {
    stub = new StubUpstream({ behavior: () => ({ kind: "answer", ttl: 60, address: "203.0.113.5" }) });
    const upstream = await stub.listen();
    const query = buildQuery(1, "a.test", TYPE.A);
    const reply = decodeResponse(await forwardQuery(query, upstream, { udpTimeoutMs: 1000, tcpTimeoutMs: 1000 }));
    expect(reply.header.id).toBe(1);
  });

  it("times out (TimeoutError) if nothing ever answers, and does not hang", async () => {
    stub = new StubUpstream({ behavior: () => ({ kind: "drop" }) });
    const upstream = await stub.listen();
    const query = buildQuery(1, "a.test", TYPE.A);
    await expect(forwardQuery(query, upstream, { udpTimeoutMs: 100, tcpTimeoutMs: 100 })).rejects.toThrow(TimeoutError);
  });

  it("ignores a reply from a different address/port than the configured upstream, even if it arrives first", async () => {
    stub = new StubUpstream({ behavior: () => ({ kind: "answer", ttl: 60, address: "203.0.113.5" }) });
    const upstream = await stub.listen();

    const rogue = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => rogue.bind(0, resolve));
    const spoofed = encodeMessage({ ...emptyHeader(1), qr: true }, [{ name: "a.test", type: TYPE.A, class: 1 }], [
      encodeARecord("a.test", 60, "6.6.6.6"), // a clearly different, bogus answer
    ]);

    const query = buildQuery(1, "a.test", TYPE.A);
    const raw = await forwardQuery(query, upstream, {
      udpTimeoutMs: 1500,
      tcpTimeoutMs: 1500,
      // Fired the instant our socket is bound -- BEFORE the real query is even sent to upstream -- so the rogue
      // packet has every chance to arrive first if the source check did not stop it.
      onUdpBound: (port) => rogue.send(spoofed, port, "127.0.0.1"),
    });
    rogue.close();
    // The real upstream's answer is 203.0.113.5; the rogue's spoofed one is 6.6.6.6. Only the real one may win.
    expect(raw.subarray(raw.length - 4)).toEqual(Buffer.from([203, 0, 113, 5]));
  });
});
