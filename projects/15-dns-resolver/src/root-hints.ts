/**
 * The 13 root server names and addresses ("root hints").
 *
 * Source: IANA / InterNIC, https://www.internic.net/domain/named.root
 * Copied 2026-11-21 from the file whose header says "last update: November 12, 2026" and
 * "related version of root zone: 2026111201". These are public addresses, the same in every resolver.
 *
 * A resolver only needs ONE reachable root server to start; the full list is for resilience. The addresses change
 * very rarely (B moved to 170.247.170.2 in 2023), which is why real resolvers also "prime" by asking a root for the
 * current NS set of "." at start-up -- not done here, see README NOT implemented.
 */
export interface RootHint {
  name: string;
  ipv4: string;
  /** kept for completeness; the resolver sends over IPv4 only */
  ipv6?: string;
}

export const ROOT_HINTS: readonly RootHint[] = [
  { name: "a.root-servers.net", ipv4: "198.41.0.4", ipv6: "2001:503:ba3e::2:30" },
  { name: "b.root-servers.net", ipv4: "170.247.170.2", ipv6: "2801:1b8:10::b" },
  { name: "c.root-servers.net", ipv4: "192.33.4.12", ipv6: "2001:500:2::c" },
  { name: "d.root-servers.net", ipv4: "199.7.91.13", ipv6: "2001:500:2d::d" },
  { name: "e.root-servers.net", ipv4: "192.203.230.10", ipv6: "2001:500:a8::e" },
  { name: "f.root-servers.net", ipv4: "192.5.5.241", ipv6: "2001:500:2f::f" },
  { name: "g.root-servers.net", ipv4: "192.112.36.4", ipv6: "2001:500:12::d0d" },
  { name: "h.root-servers.net", ipv4: "198.97.190.53", ipv6: "2001:500:1::53" },
  { name: "i.root-servers.net", ipv4: "192.36.148.17", ipv6: "2001:7fe::53" },
  { name: "j.root-servers.net", ipv4: "192.58.128.30", ipv6: "2001:503:c27::2:30" },
  { name: "k.root-servers.net", ipv4: "193.0.14.129", ipv6: "2001:7fd::1" },
  { name: "l.root-servers.net", ipv4: "199.7.83.42", ipv6: "2001:500:9f::42" },
  { name: "m.root-servers.net", ipv4: "202.12.27.33", ipv6: "2001:dc3::35" },
];
