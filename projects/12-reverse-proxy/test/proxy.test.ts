import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { closeAll, deadPort, echoUpstream, listen, startProxy } from "./helpers.js";
import type { RequestLog } from "../src/proxy.js";

afterEach(closeAll);

interface Echo {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  bodyLength: number;
  body: string;
}

describe("forwarding", () => {
  it("forwards method, path, query and body, and returns status, headers and body", async () => {
    const up = await listen(echoUpstream());
    const px = await startProxy(up);
    const res = await fetch(`http://127.0.0.1:${px}/a/b?x=1&y=two`, { method: "POST", body: "hello" });
    const echo = (await res.json()) as Echo;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-upstream")).toBe("echo");
    expect(echo.method).toBe("POST");
    expect(echo.url).toBe("/a/b?x=1&y=two");
    expect(echo.body).toBe("hello");
  });

  it("passes through upstream status codes (404 and 500 are not turned into 502)", async () => {
    const upServer = http.createServer((req, res) => {
      res.statusCode = req.url === "/missing" ? 404 : 500;
      res.end("upstream says no");
    });
    const px = await startProxy(await listen(upServer));
    expect((await fetch(`http://127.0.0.1:${px}/missing`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${px}/boom`)).status).toBe(500);
  });

  it("handles HEAD and 204 responses without a body", async () => {
    const upServer = http.createServer((req, res) => {
      if (req.method === "HEAD") res.writeHead(200, { "content-length": "5" }).end();
      else res.writeHead(204).end();
    });
    const px = await startProxy(await listen(upServer));
    const head = await fetch(`http://127.0.0.1:${px}/`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("5");
    expect((await fetch(`http://127.0.0.1:${px}/`, { method: "DELETE" })).status).toBe(204);
  });

  it("passes a redirect through to the client instead of following it", async () => {
    const upServer = http.createServer((_req, res) => {
      res.writeHead(302, { location: "/login" }).end();
    });
    const px = await startProxy(await listen(upServer));
    const res = await fetch(`http://127.0.0.1:${px}/private`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("keeps several Set-Cookie headers separate", async () => {
    const upServer = http.createServer((_req, res) => {
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.end("ok");
    });
    const px = await startProxy(await listen(upServer));
    const res = await fetch(`http://127.0.0.1:${px}/`);
    expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  });

  it("streams a large request body in full (2 MiB)", async () => {
    const up = await listen(echoUpstream());
    const px = await startProxy(up);
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    const res = await fetch(`http://127.0.0.1:${px}/upload`, { method: "POST", body: big });
    expect(((await res.json()) as Echo).bodyLength).toBe(big.length);
  });

  it("streams a large response body in full (3 MiB)", async () => {
    const size = 3 * 1024 * 1024;
    const upServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": String(size) });
      res.end(Buffer.alloc(size, 1));
    });
    const px = await startProxy(await listen(upServer));
    const res = await fetch(`http://127.0.0.1:${px}/big`);
    expect((await res.arrayBuffer()).byteLength).toBe(size);
  });

  it("re-frames a chunked request body (no Content-Length) for the upstream", async () => {
    const up = await listen(echoUpstream());
    const px = await startProxy(up);
    const body = await new Promise<Echo>((resolve, reject) => {
      const r = http.request({ port: px, host: "127.0.0.1", method: "POST", path: "/chunked" }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as Echo));
      });
      r.on("error", reject);
      r.write("part-one,");
      setTimeout(() => r.end("part-two"), 20);
    });
    expect(body.body).toBe("part-one,part-two");
    expect(body.headers["transfer-encoding"]).toBe("chunked");
  });
});

describe("headers", () => {
  it("does not forward hop-by-hop headers, including ones named in Connection", async () => {
    const up = await listen(echoUpstream());
    const px = await startProxy(up);
    const echo = await new Promise<Echo>((resolve, reject) => {
      const r = http.request(
        { port: px, host: "127.0.0.1", path: "/", headers: { connection: "keep-alive, x-secret", "x-secret": "leak", "x-keep": "ok", "keep-alive": "timeout=9" } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as Echo));
        },
      );
      r.on("error", reject);
      r.end();
    });
    expect(echo.headers["x-secret"]).toBeUndefined();
    expect(echo.headers["keep-alive"]).toBeUndefined();
    expect(echo.headers["x-keep"]).toBe("ok");
  });

  it("overwrites a spoofed X-Forwarded-For by default", async () => {
    const px = await startProxy(await listen(echoUpstream()));
    const res = await fetch(`http://127.0.0.1:${px}/`, { headers: { "x-forwarded-for": "6.6.6.6" } });
    expect(((await res.json()) as Echo).headers["x-forwarded-for"]).toBe("127.0.0.1");
  });

  it("extends X-Forwarded-For when trustForwarded is on", async () => {
    const px = await startProxy(await listen(echoUpstream()), { trustForwarded: true });
    const res = await fetch(`http://127.0.0.1:${px}/`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    expect(((await res.json()) as Echo).headers["x-forwarded-for"]).toBe("198.51.100.7, 127.0.0.1");
  });

  it("preserves the original Host header and adds Via in both directions", async () => {
    const px = await startProxy(await listen(echoUpstream()));
    const res = await fetch(`http://127.0.0.1:${px}/`);
    const echo = (await res.json()) as Echo;
    expect(echo.headers.host).toBe(`127.0.0.1:${px}`);
    expect(echo.headers.via).toBe("1.1 h11-proxy");
    expect(res.headers.get("via")).toBe("1.1 h11-proxy");
  });
});

describe("failures", () => {
  it("returns 502 when the upstream refuses the connection", async () => {
    const px = await startProxy(await deadPort());
    const res = await fetch(`http://127.0.0.1:${px}/`);
    expect(res.status).toBe(502);
  });

  it("returns 504 when the upstream does not answer in time", async () => {
    const hang = http.createServer(() => {
      /* never answers */
    });
    const px = await startProxy(await listen(hang), { upstreamTimeoutMs: 150 });
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${px}/`);
    expect(res.status).toBe(504);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("drops the client connection when the upstream dies mid-response (no silent truncation)", async () => {
    const upServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("partial");
      setTimeout(() => res.destroy(), 30);
    });
    const px = await startProxy(await listen(upServer));
    const res = await fetch(`http://127.0.0.1:${px}/`);
    expect(res.status).toBe(200); // headers were already sent, so the status cannot change
    await expect(res.text()).rejects.toThrow();
  });

  it("cancels the upstream request when the client disconnects", async () => {
    let upstreamSawClose: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => (upstreamSawClose = resolve));
    let gotRequest: () => void = () => undefined;
    const received = new Promise<void>((resolve) => (gotRequest = resolve));
    const upServer = http.createServer((_req, res) => {
      gotRequest();
      res.on("close", upstreamSawClose); // fires when the proxy tears down the upstream socket
    });
    const px = await startProxy(await listen(upServer));
    const ctl = new AbortController();
    const pending = fetch(`http://127.0.0.1:${px}/slow`, { signal: ctl.signal }).catch(() => undefined);
    await received;
    ctl.abort();
    await pending;
    await closed; // test times out if the proxy keeps the upstream request alive
  });

  it("returns 508 when the request has already passed through this proxy", async () => {
    const up = await listen(echoUpstream());
    const px = await startProxy(up);
    const res = await fetch(`http://127.0.0.1:${px}/`, { headers: { via: "1.1 h11-proxy" } });
    expect(res.status).toBe(508);
  });
});

describe("construction and logging", () => {
  it("rejects upstreams it cannot honour", async () => {
    const { createProxy } = await import("../src/proxy.js");
    expect(() => createProxy({ upstream: new URL("https://example.com") })).toThrow(/http/);
    expect(() => createProxy({ upstream: new URL("http://example.com/base") })).toThrow(/path/);
  });

  it("emits one log entry per request", async () => {
    const entries: RequestLog[] = [];
    const px = await startProxy(await listen(echoUpstream()), { log: (e) => entries.push(e) });
    await (await fetch(`http://127.0.0.1:${px}/logged`)).text();
    await new Promise((r) => setTimeout(r, 50));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ method: "GET", url: "/logged", status: 200, aborted: false });
  });
});
