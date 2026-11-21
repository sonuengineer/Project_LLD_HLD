// A small test upstream for the experiments. Zero dependencies.
//
//   PORT           listen port (required)
//   HOST           address to bind (default 127.0.0.1; for a two-host test use the machine's PRIVATE address, never 0.0.0.0)
//   NAME           body returned by "/"                      (default "upstream")
//   DELAY_MS       delay before answering "/"                 (default 0)
//   KEEPALIVE_MS   server keep-alive timeout                  (default: Node's, 5000)
//   RESET_PERCENT  % of "/" requests answered by dropping the connection (default 0)
//   RAW            "1" = a hand-written HTTP/1.1 server on a plain TCP socket that closes idle connections after
//                  KEEPALIVE_MS and sends NO Keep-Alive header. Many real servers behave like this; Node's own
//                  server always sends a "Keep-Alive: timeout=N" hint that a Node client may use to avoid reuse races.
//
//   GET /            -> NAME (after DELAY_MS)
//   GET /health      -> 200 "ok"
//   GET /work?ms=N   -> answers after N ms
//   GET /big?mb=N    -> streams N MiB of zeros, honouring back-pressure
import http from "node:http";
import net from "node:net";

const port = Number(process.env.PORT);
const bindHost = process.env.HOST ?? "127.0.0.1";
const name = process.env.NAME ?? "upstream";
const delayMs = Number(process.env.DELAY_MS ?? 0);
const resetPercent = Number(process.env.RESET_PERCENT ?? 0);
if (!port) throw new Error("PORT is required");

function startRaw() {
  const idleMs = Number(process.env.KEEPALIVE_MS ?? 200);
  const raw = net.createServer((socket) => {
    let buffer = "";
    socket.setTimeout(idleMs, () => socket.destroy()); // idle connection: close it, with no warning
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n\r\n")) >= 0) {
        buffer = buffer.slice(end + 4);
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${name.length}\r\n\r\n${name}`);
      }
    });
  });
  raw.listen(port, bindHost, () => console.log(JSON.stringify({ msg: "listening", port, name, raw: true })));
}

function startNode() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/health") return void res.end("ok");

    if (url.pathname === "/big") {
      const total = Number(url.searchParams.get("mb") ?? 1) * 1024 * 1024;
      const chunk = Buffer.alloc(64 * 1024);
      let sent = 0;
      res.writeHead(200, { "content-length": String(total) });
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump); // back-pressure
        }
        res.end();
      };
      return pump();
    }

    // drain any request body so keep-alive connections stay usable
    req.resume();
    if (resetPercent > 0 && Math.random() * 100 < resetPercent) return void req.socket.destroy();
    const wait = url.pathname === "/work" ? Number(url.searchParams.get("ms") ?? 0) : delayMs;
    if (wait <= 0) return void res.end(name); // no timer: on Windows even setTimeout(0) waits for the ~15 ms clock tick
    setTimeout(() => res.end(name), wait);
  });

  if (process.env.KEEPALIVE_MS) server.keepAliveTimeout = Number(process.env.KEEPALIVE_MS);
  server.listen(port, bindHost, () => console.log(JSON.stringify({ msg: "listening", host: bindHost, port, name })));
}

if (process.env.RAW === "1") startRaw();
else startNode();
