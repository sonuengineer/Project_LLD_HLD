/**
 * The blocklist: "ads.example.com" blocks that exact name AND every subdomain of it ("*.ads.example.com").
 *
 * Structure: a trie over dot-separated labels, built TLD-first (so "ads.example.com" is inserted as the path
 * com -> example -> ads, with "ads" marked as a blocked node). Looking up a query name walks the same path; the
 * name is blocked the moment the walk passes a marked node, because every node under a marked node IS a subdomain
 * of it by construction.
 *
 * Why a trie over a Set of suffixes (the other sensible option): a real blocklist has tens of thousands of lines
 * that share huge common suffixes (".doubleclick.net", ".adroll.com", ...). A Set keyed by whole domain strings
 * would need a FRESH lookup per ancestor on every query -- `isBlocked("x.y.ads.example.com")` would build and hash
 * "x.y.ads.example.com", then "y.ads.example.com", then "ads.example.com", ... one string allocation and one hash
 * per label, with no sharing between entries. The trie shares every common suffix as actual shared nodes (one
 * "doubleclick.net" subtree no matter how many of its subdomains are individually listed), and a lookup is a
 * single walk of the query's own labels with one map lookup per label -- same asymptotic cost, no per-ancestor
 * string building, and it naturally gives the "name OR any subdomain" rule for free instead of needing it
 * special-cased.
 */
import { readFileSync } from "node:fs";

interface TrieNode {
  children: Map<string, TrieNode>;
  blocked: boolean;
}

function labelsOf(domain: string): string[] {
  const trimmed = domain.trim().toLowerCase().replace(/\.$/, "");
  if (trimmed === "") return [];
  const labels = trimmed.split(".");
  for (const l of labels) if (l === "") throw new RangeError(`blocklist: empty label in domain ${JSON.stringify(domain)}`);
  return labels;
}

export class BlockList {
  private readonly root: TrieNode = { children: new Map(), blocked: false };
  private count = 0;

  constructor(domains: Iterable<string> = []) {
    for (const d of domains) this.add(d);
  }

  /** Number of distinct domains added (not counting subdomains they implicitly cover). */
  get size(): number {
    return this.count;
  }

  add(domain: string): void {
    const labels = labelsOf(domain);
    if (labels.length === 0) throw new RangeError(`blocklist: empty domain ${JSON.stringify(domain)}`);
    let node = this.root;
    for (let i = labels.length - 1; i >= 0; i--) {
      const label = labels[i]!;
      let next = node.children.get(label);
      if (!next) {
        next = { children: new Map(), blocked: false };
        node.children.set(label, next);
      }
      node = next;
    }
    if (!node.blocked) {
      node.blocked = true;
      this.count++;
    }
  }

  /** True if `name` is exactly a blocked domain, or a subdomain of one. */
  isBlocked(name: string): boolean {
    const labels = labelsOf(name);
    let node = this.root;
    for (let i = labels.length - 1; i >= 0; i--) {
      const next = node.children.get(labels[i]!);
      if (!next) return false;
      node = next;
      if (node.blocked) return true;
    }
    return false;
  }
}

/** One domain per line; blank lines and lines starting with "#" or ";" are comments and are skipped. */
export function parseBlockListText(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    out.push(line);
  }
  return out;
}

export function loadBlockListFile(path: string): string[] {
  return parseBlockListText(readFileSync(path, "utf8"));
}
