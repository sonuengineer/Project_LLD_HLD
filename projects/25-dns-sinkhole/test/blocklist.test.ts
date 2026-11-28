import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BlockList, loadBlockListFile, parseBlockListText } from "../src/blocklist.js";

describe("BlockList: exact and wildcard-subdomain blocking", () => {
  it("blocks the exact domain", () => {
    const bl = new BlockList(["ads.example.com"]);
    expect(bl.isBlocked("ads.example.com")).toBe(true);
  });

  it("blocks every subdomain of a blocked domain", () => {
    const bl = new BlockList(["ads.example.com"]);
    expect(bl.isBlocked("tracker.ads.example.com")).toBe(true);
    expect(bl.isBlocked("a.b.c.ads.example.com")).toBe(true);
  });

  it("does not block the parent, a sibling, or an unrelated domain", () => {
    const bl = new BlockList(["ads.example.com"]);
    expect(bl.isBlocked("example.com")).toBe(false);
    expect(bl.isBlocked("other.example.com")).toBe(false);
    expect(bl.isBlocked("ads-example.com")).toBe(false); // not a subdomain, just a similar-looking name
    expect(bl.isBlocked("evil.test")).toBe(false);
  });

  it("does not block a domain that merely ends with the same letters as a blocked label", () => {
    const bl = new BlockList(["ads.example.com"]);
    expect(bl.isBlocked("notads.example.com")).toBe(false); // "notads" is a different label than "ads"
  });

  it("is case-insensitive and ignores one trailing dot", () => {
    const bl = new BlockList(["Ads.Example.com"]);
    expect(bl.isBlocked("ADS.EXAMPLE.COM")).toBe(true);
    expect(bl.isBlocked("ads.example.com.")).toBe(true);
  });

  it("adding the same domain twice only counts it once in size()", () => {
    const bl = new BlockList(["ads.example.com", "ads.example.com"]);
    expect(bl.size).toBe(1);
  });

  it("a shorter listed domain blocks a longer query sharing its suffix, but a blocked leaf does not block its own parent", () => {
    const bl = new BlockList(["tracker.net", "deep.sub.tracker.net"]);
    expect(bl.isBlocked("x.tracker.net")).toBe(true); // covered by the shorter entry
    expect(bl.isBlocked("tracker.net")).toBe(true);
    expect(bl.isBlocked("sub.tracker.net")).toBe(true);
    expect(bl.size).toBe(2); // the second entry is redundant but still counted as its own addition
  });

  it("rejects an empty domain", () => {
    expect(() => new BlockList([""])).toThrow(RangeError);
  });

  it("rejects a domain with an empty label", () => {
    expect(() => new BlockList(["ads..example.com"])).toThrow(RangeError);
  });

  it("an empty blocklist blocks nothing", () => {
    const bl = new BlockList([]);
    expect(bl.isBlocked("anything.test")).toBe(false);
    expect(bl.size).toBe(0);
  });
});

describe("parseBlockListText", () => {
  it("skips blank lines and # / ; comments, keeps real domains in order", () => {
    const text = [
      "# ad networks",
      "",
      "ads.example.com",
      "  doubleclick.net  ", // surrounding whitespace is trimmed
      "; a semicolon comment",
      "tracker.test",
    ].join("\n");
    expect(parseBlockListText(text)).toEqual(["ads.example.com", "doubleclick.net", "tracker.test"]);
  });

  it("handles CRLF line endings", () => {
    expect(parseBlockListText("a.test\r\nb.test\r\n")).toEqual(["a.test", "b.test"]);
  });

  it("an empty file yields an empty list", () => {
    expect(parseBlockListText("")).toEqual([]);
  });
});

describe("loadBlockListFile", () => {
  it("reads the sample config/blocklist.txt into a working BlockList", () => {
    const domains = loadBlockListFile(fileURLToPath(new URL("../config/blocklist.txt", import.meta.url)));
    expect(domains).toContain("doubleclick.net");
    const bl = new BlockList(domains);
    expect(bl.isBlocked("ads.doubleclick.net")).toBe(true);
    expect(bl.isBlocked("not-blocked.test")).toBe(false);
  });
});
