// A small test upstream for the experiments. Zero dependencies.
//
//   PORT           listen port (required)
//   NAME           body returned by "/"                      (default "upstream")
//   DELAY_MS       delay before answering "/"                 (default 0)
//   KEEPALIVE_MS   server keep-alive timeout                  (default: Node's, 5000)
//   RESET_PERCENT  % of "/" requests answered by dropping the connection (default 0)
//
//   GET /            -> NAME (after DELAY_MS)
//   GET /health      -> 200 "ok"
//   GET /work?ms=N   -> answers after N ms
//   GET /big?mb=N    -> streams N MiB of zeros, honouring back-pressure
import http from "node:http";

const port = Number(process.env.PORT);
const name = process.env.NAME ?? "upstream";
const delayMs = Number(process.env.DELAY_MS ?? 0);
const resetPercent = Number(process.env.RESET_PERCENT ?? 0);
if (!port) throw new Error("PORT is required");

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
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ msg: "listening", port, name })));
