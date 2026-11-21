import { describe, expect, it } from "vitest";
import { SubjectTrie, isValidPublishSubject, isValidSubscribeSubject } from "../src/subjects.js";

describe("subject validation", () => {
  it.each(["foo", "foo.bar", "foo.*", "foo.>", "*", ">", "*.bar.>", "ord*.x"])("subscribe ok: %s", (s) => {
    expect(isValidSubscribeSubject(s)).toBe(true);
  });
  it.each(["", "foo..bar", ".foo", "foo.", "foo.>.bar", "foo bar", "foo\tbar"])("subscribe rejected: %j", (s) => {
    expect(isValidSubscribeSubject(s)).toBe(false);
  });
  it("publish subjects may not contain wildcard tokens, but a * inside a token is literal", () => {
    expect(isValidPublishSubject("foo.bar")).toBe(true);
    expect(isValidPublishSubject("ord*.x")).toBe(true);
    expect(isValidPublishSubject("foo.*")).toBe(false);
    expect(isValidPublishSubject("foo.>")).toBe(false);
  });
});

describe("SubjectTrie matching", () => {
  const build = (...subjects: string[]) => {
    const t = new SubjectTrie<string>();
    for (const s of subjects) t.insert(s, s);
    return t;
  };
  const m = (t: SubjectTrie<string>, s: string) => t.match(s).sort();

  it("literal subjects match exactly", () => {
    const t = build("foo.bar", "foo.baz", "foo");
    expect(m(t, "foo.bar")).toEqual(["foo.bar"]);
    expect(m(t, "foo")).toEqual(["foo"]);
    expect(m(t, "foo.bar.x")).toEqual([]);
  });

  it("* matches exactly one token", () => {
    const t = build("orders.*.created");
    expect(m(t, "orders.eu.created")).toEqual(["orders.*.created"]);
    expect(m(t, "orders.created")).toEqual([]);
    expect(m(t, "orders.eu.x.created")).toEqual([]);
  });

  it("> matches one or more trailing tokens but not zero", () => {
    const t = build("orders.>");
    expect(m(t, "orders.eu")).toEqual(["orders.>"]);
    expect(m(t, "orders.eu.created.v2")).toEqual(["orders.>"]);
    expect(m(t, "orders")).toEqual([]);
  });

  it("a subject matched by several subscriptions returns each of them", () => {
    const t = build("a.b.c", "a.*.c", "a.>", "*.*.*", ">", "a.b");
    expect(m(t, "a.b.c")).toEqual([">", "*.*.*", "a.*.c", "a.>", "a.b.c"].sort());
  });

  it("a ord* token is literal, not a wildcard", () => {
    const t = build("ord*.x");
    expect(m(t, "orders.x")).toEqual([]);
    expect(m(t, "ord*.x")).toEqual(["ord*.x"]);
  });

  it("the same item on two subjects is returned once per matching subscription", () => {
    const t = new SubjectTrie<string>();
    t.insert("a.b", "client1");
    t.insert("a.*", "client1");
    expect(t.match("a.b")).toEqual(["client1", "client1"]);
  });
});

describe("SubjectTrie removal", () => {
  it("remove deletes one subscription and leaves the others", () => {
    const t = new SubjectTrie<string>();
    t.insert("a.b", "x");
    t.insert("a.b", "y");
    expect(t.remove("a.b", "x")).toBe(true);
    expect(t.match("a.b")).toEqual(["y"]);
    expect(t.size).toBe(1);
  });

  it("removing something that is not there returns false and changes nothing", () => {
    const t = new SubjectTrie<string>();
    t.insert("a.b", "x");
    expect(t.remove("a.c", "x")).toBe(false);
    expect(t.remove("a.b", "nope")).toBe(false);
    expect(t.size).toBe(1);
  });

  it("empty branches are pruned, so the trie returns to empty", () => {
    const t = new SubjectTrie<string>();
    t.insert("a.b.c.d", "x");
    t.insert("a.b.*", "y");
    t.insert("a.>", "z");
    expect(t.nodeCount()).toBeGreaterThan(0);
    t.remove("a.b.c.d", "x");
    t.remove("a.b.*", "y");
    t.remove("a.>", "z");
    expect(t.size).toBe(0);
    expect(t.nodeCount()).toBe(0);
  });

  it("pruning stops at a node that still has another subscription", () => {
    const t = new SubjectTrie<string>();
    t.insert("a", "keep");
    t.insert("a.b.c", "go");
    t.remove("a.b.c", "go");
    expect(t.nodeCount()).toBe(1);
    expect(t.match("a")).toEqual(["keep"]);
  });
});
