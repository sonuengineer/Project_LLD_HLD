import { describe, expect, it } from "vitest";
import { buildUpstreamHeaders, hasLoop, normalizeIp, stripHopByHop } from "../src/headers.js";

describe("stripHopByHop", () => {
  it("removes the standard hop-by-hop headers and keeps end-to-end ones", () => {
    const out = stripHopByHop({ connection: "keep-alive", "keep-alive": "timeout=5", te: "trailers", "content-type": "text/plain", accept: "*/*" });
    expect(out).toEqual({ "content-type": "text/plain", accept: "*/*" });
  });

  it("also removes headers NAMED in Connection", () => {
    const out = stripHopByHop({ connection: "close, X-Secret", "x-secret": "1", "x-keep": "2" });
    expect(out).toEqual({ "x-keep": "2" });
  });
});

describe("normalizeIp", () => {
  it("unwraps IPv4-mapped IPv6 and keeps real IPv6", () => {
    expect(normalizeIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normalizeIp("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeIp(undefined)).toBe("unknown");
  });
});

describe("buildUpstreamHeaders", () => {
  const info = { remoteAddress: "::ffff:203.0.113.9", host: "api.example.com" };

  it("ignores a client-supplied X-Forwarded-For by default (anti-spoofing)", () => {
    const out = buildUpstreamHeaders({ "x-forwarded-for": "1.2.3.4" }, info, { trustForwarded: false });
    expect(out["x-forwarded-for"]).toBe("203.0.113.9");
    expect(out["x-forwarded-proto"]).toBe("http");
    expect(out["x-forwarded-host"]).toBe("api.example.com");
  });

  it("appends to the chain when the previous hop is trusted", () => {
    const out = buildUpstreamHeaders(
      { "x-forwarded-for": "198.51.100.7", "x-forwarded-proto": "https", "x-forwarded-host": "shop.example.com" },
      info,
      { trustForwarded: true },
    );
    expect(out["x-forwarded-for"]).toBe("198.51.100.7, 203.0.113.9");
    expect(out["x-forwarded-proto"]).toBe("https");
    expect(out["x-forwarded-host"]).toBe("shop.example.com");
  });

  it("trusted mode with no prior header behaves like the first hop", () => {
    const out = buildUpstreamHeaders({}, info, { trustForwarded: true });
    expect(out["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("appends itself to Via", () => {
    expect(buildUpstreamHeaders({}, info, { trustForwarded: false }).via).toBe("1.1 h11-proxy");
    expect(buildUpstreamHeaders({ via: "1.0 fw" }, info, { trustForwarded: false }).via).toBe("1.0 fw, 1.1 h11-proxy");
  });

  it("re-frames a chunked request body as chunked", () => {
    const out = buildUpstreamHeaders({ "transfer-encoding": "chunked" }, info, { trustForwarded: false });
    expect(out["transfer-encoding"]).toBe("chunked");
  });
});

describe("hasLoop", () => {
  it("detects our own token in Via", () => {
    expect(hasLoop({ via: "1.1 h11-proxy" })).toBe(true);
    expect(hasLoop({ via: "1.0 fw, 1.1 h11-proxy" })).toBe(true);
  });
  it("does not trigger on other proxies or a missing header", () => {
    expect(hasLoop({ via: "1.1 caddy" })).toBe(false);
    expect(hasLoop({})).toBe(false);
  });
});
