/**
 * The fixture "internet" used by the resolver, cache and server tests.
 *
 *   .  (root, 198.51.100.1)
 *   |-- test     (198.51.100.2)
 *   |    |-- alpha.test   ns1 192.0.2.1, ns2 192.0.2.2   (in-bailiwick glue)
 *   |    |-- beta.test    ns.hoster.example              (NO glue: out-of-bailiwick NS lookup needed)
 *   |    |-- loop1.test / loop2.test                     (each delegated to a host inside the other, no glue)
 *   |    `-- lame.test    ns.lame.test 192.0.2.30        (server exists; tests make it misbehave)
 *   `-- example  (198.51.100.3)
 *        `-- hoster.example  ns 203.0.113.5  (also serves beta.test)
 */
import { TYPE } from "../src/wire.js";
import type { RootHint } from "../src/root-hints.js";
import { A, CNAME, FakeNet, NS, SOA, rr } from "./fakenet.js";

export const ROOT_IP = "198.51.100.1";
export const TEST_TLD_IP = "198.51.100.2";
export const EXAMPLE_TLD_IP = "198.51.100.3";
export const ALPHA1_IP = "192.0.2.1";
export const ALPHA2_IP = "192.0.2.2";
export const LAME_IP = "192.0.2.30";
export const HOSTER_IP = "203.0.113.5";

export const FAKE_ROOT_HINTS: RootHint[] = [{ name: "a.root-servers.test", ipv4: ROOT_IP }];

/** 30 strings of 30 bytes: about 930 bytes of rdata, too big for a 512-byte UDP reply. */
export const BIG_TXT = Array.from({ length: 30 }, (_, i) => `chunk-${String(i).padStart(2, "0")}-${"x".repeat(21)}`);

export function buildNet(): FakeNet {
  const net = new FakeNet();
  net.add(ROOT_IP, {
    origin: "",
    records: [
      SOA("", 86400, 86400),
      NS("", "a.root-servers.test"),
      NS("test", "ns1.nic.test", 172800),
      A("ns1.nic.test", TEST_TLD_IP, 172800),
      NS("example", "ns.nic.example", 172800),
      A("ns.nic.example", EXAMPLE_TLD_IP, 172800),
    ],
  });
  net.add(TEST_TLD_IP, {
    origin: "test",
    records: [
      SOA("test", 900),
      NS("test", "ns1.nic.test"),
      A("ns1.nic.test", TEST_TLD_IP),
      NS("alpha.test", "ns1.alpha.test", 86400),
      NS("alpha.test", "ns2.alpha.test", 86400),
      A("ns1.alpha.test", ALPHA1_IP, 86400),
      A("ns2.alpha.test", ALPHA2_IP, 86400),
      NS("beta.test", "ns.hoster.example", 86400),
      NS("loop1.test", "ns.loop2.test"),
      NS("loop2.test", "ns.loop1.test"),
      NS("lame.test", "ns.lame.test"),
      A("ns.lame.test", LAME_IP),
    ],
  });
  net.add(EXAMPLE_TLD_IP, {
    origin: "example",
    records: [SOA("example"), NS("example", "ns.nic.example"), NS("hoster.example", "ns.hoster.example"), A("ns.hoster.example", HOSTER_IP)],
  });
  const chain = Array.from({ length: 10 }, (_, i) => CNAME(`c${i + 1}.alpha.test`, i === 9 ? "www.alpha.test" : `c${i + 2}.alpha.test`));
  const alpha = {
    origin: "alpha.test",
    records: [
      SOA("alpha.test", 60, 300),
      NS("alpha.test", "ns1.alpha.test"),
      NS("alpha.test", "ns2.alpha.test"),
      A("ns1.alpha.test", ALPHA1_IP),
      A("ns2.alpha.test", ALPHA2_IP),
      A("www.alpha.test", "192.0.2.80", 300),
      A("www.alpha.test", "192.0.2.81", 300),
      rr("www.alpha.test", { kind: "AAAA", address: "2001:db8::80" }, 300),
      CNAME("alias.alpha.test", "www.alpha.test", 600),
      rr("alpha.test", { kind: "MX", preference: 10, exchange: "mail.alpha.test" }),
      A("mail.alpha.test", "192.0.2.25"),
      rr("alpha.test", { kind: "TXT", texts: ["v=spf1 -all"] }),
      rr("big.alpha.test", { kind: "TXT", texts: BIG_TXT }),
      CNAME("to-beta.alpha.test", "www.beta.test"),
      ...chain,
      CNAME("loopa.alpha.test", "loopb.alpha.test"),
      CNAME("loopb.alpha.test", "loopa.alpha.test"),
      CNAME("dangling.alpha.test", "nothing.alpha.test"),
      A("host.sub.alpha.test", "192.0.2.90"),
      rr("ptr.alpha.test", { kind: "PTR", host: "www.alpha.test" }),
    ],
  };
  net.add(ALPHA1_IP, alpha);
  net.add(ALPHA2_IP, alpha);
  net.add(LAME_IP, { origin: "lame.test", records: [SOA("lame.test"), NS("lame.test", "ns.lame.test"), A("www.lame.test", "192.0.2.31")] });
  net.add(
    HOSTER_IP,
    {
      origin: "hoster.example",
      records: [SOA("hoster.example"), NS("hoster.example", "ns.hoster.example"), A("ns.hoster.example", HOSTER_IP)],
    },
    {
      origin: "beta.test",
      records: [SOA("beta.test", 120), NS("beta.test", "ns.hoster.example"), A("www.beta.test", "203.0.113.80")],
    },
  );
  return net;
}

export { TYPE };
