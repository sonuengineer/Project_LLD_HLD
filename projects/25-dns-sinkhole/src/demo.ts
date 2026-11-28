import dgram from "node:dgram";
import {
  BlockList,
  RCODE,
  SinkholeProxy,
  SinkholeServer,
  StubUpstream,
  TYPE,
  buildQuery,
  decodeResponse,
} from "./index.js";

/** A plain UDP client, playing the role of a browser/OS asking our proxy a question. */
function ask(port: number, name: string, type: number) {
  return new Promise<ReturnType<typeof decodeResponse>>((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error(`no reply for ${name}`));
    }, 2000);
    sock.on("message", (buf) => {
      clearTimeout(timer);
      sock.close();
      resolve(decodeResponse(buf));
    });
    sock.send(buildQuery(Math.floor(Math.random() * 0x10000), name, type), port, "127.0.0.1");
  });
}

async function main() {
  console.log("-- a fake upstream resolver, standing in for a real one like 1.1.1.1 --");
  const upstream = new StubUpstream({
    behavior: (name) => {
      if (name === "big-file.cdn.test") return { kind: "truncate", ttl: 300, address: "203.0.113.9" };
      return { kind: "answer", ttl: 300, address: "203.0.113.5" };
    },
  });
  const upstreamAddr = await upstream.listen();
  console.log(`upstream listening on ${upstreamAddr.host}:${upstreamAddr.port}`);

  console.log("\n-- the blocklist: a few ad/tracker domains, exact name + every subdomain --");
  const blockList = new BlockList(["ads.example.com", "doubleclick.net"]);
  console.log("blocklist entries:", blockList.size);

  const proxy = new SinkholeProxy({
    blockList,
    mode: "sinkhole",
    sinkholeAddress: "0.0.0.0",
    upstream: upstreamAddr,
    udpTimeoutMs: 1000,
    tcpTimeoutMs: 1000,
  });
  const server = new SinkholeServer({ proxy, port: 0 });
  const addr = await server.listen();
  console.log(`\nsinkhole proxy listening on ${addr.host}:${addr.port}`);

  console.log("\n-- a blocked query never reaches upstream --");
  const blocked = await ask(addr.port, "tracker.ads.example.com", TYPE.A); // subdomain of a blocked name
  console.log("tracker.ads.example.com ->", blocked.header.rcode === RCODE.NOERROR ? blocked.answers[0] : "NXDOMAIN", "| upstream calls so far:", upstream.callCount);

  console.log("\n-- an allowed query is forwarded and relayed back --");
  const allowed = await ask(addr.port, "news.example.com", TYPE.A);
  console.log("news.example.com ->", allowed.answers[0], "| upstream calls so far:", upstream.callCount);

  console.log("\n-- the same allowed query again: served from cache, upstream is not called a second time --");
  const callsBefore = upstream.callCount;
  await ask(addr.port, "news.example.com", TYPE.A);
  console.log(`upstream calls before: ${callsBefore}, after a repeat query: ${upstream.callCount} (unchanged = cache hit)`);

  console.log("\n-- a truncated upstream UDP reply triggers a TCP retry, transparently --");
  const big = await ask(addr.port, "big-file.cdn.test", TYPE.A);
  console.log("big-file.cdn.test ->", big.answers[0], "| last upstream call was over:", upstream.calls.at(-1)?.transport);

  console.log("\nproxy stats:", proxy.stats);

  await server.close();
  await upstream.close();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
