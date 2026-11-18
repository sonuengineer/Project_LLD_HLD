import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bank } from "../src/data.js";
import { callTool, init, makeFixtureDir, makeServer, question } from "./helpers.js";

async function ready(rng?: () => number) {
  const ctx = makeServer(makeFixtureDir(), rng);
  await init(ctx.server);
  return ctx;
}

describe("list_projects", () => {
  it("shows every project, the total and the difficulty split", async () => {
    const { server } = await ready();
    const { text, isError } = await callTool(server, "list_projects");
    expect(isError).toBe(false);
    expect(text).toContain("2 projects, 6 questions");
    expect(text).toContain("p01-alpha -- Alpha Limiter -- 3 questions (Beginner: 1, Intermediate: 1, Advanced: 0, Senior/System Design: 1)");
    expect(text).toContain("p02-beta -- Beta Queue -- 3 questions");
  });
});

describe("search_questions", () => {
  it("ranks a title hit above a body-only hit", async () => {
    const { server } = await ready();
    const { text } = await callTool(server, "search_questions", { query: "idempotency" });
    const ids = text.match(/ALPHA-\d+/g);
    expect(ids).toEqual(["ALPHA-001", "ALPHA-002"]); // 001: title + concept, 002: body only
  });

  it("an exact id always ranks first", async () => {
    const { server } = await ready();
    const { text } = await callTool(server, "search_questions", { query: "beta-003" });
    expect(text.split("\n")[1]).toContain("BETA-003");
  });

  it("filters by project (partial reference), difficulty and category", async () => {
    const { server } = await ready();
    expect((await callTool(server, "search_questions", { query: "retry", project: "beta" })).text).toMatch(/^1 result\(s\):\nBETA-002/);
    expect((await callTool(server, "search_questions", { query: "queue", difficulty: "Advanced" })).text).toContain("BETA-003");
    expect((await callTool(server, "search_questions", { query: "limiter", category: "Architecture & System Design" })).text).toContain("ALPHA-003");
  });

  it("respects limit and reports no matches politely", async () => {
    const { server } = await ready();
    // "what" is in two titles (ALPHA-001, BETA-001): without a limit both come back, with limit=1 only one
    expect((await callTool(server, "search_questions", { query: "what" })).text).toMatch(/^2 result\(s\)/);
    expect((await callTool(server, "search_questions", { query: "what", limit: 1 })).text).toMatch(/^1 result\(s\)/);
    expect((await callTool(server, "search_questions", { query: "zzzzqqq" })).text).toMatch(/^No questions matched/);
  });

  it.each([
    ["missing query", {}, /"query" is required/],
    ["query wrong type", { query: 5 }, /must be a string/],
    ["limit 0", { query: "a", limit: 0 }, />= 1/],
    ["limit 26", { query: "a", limit: 26 }, /<= 25/],
    ["limit not integer", { query: "a", limit: 1.5 }, /integer/],
    ["bad difficulty", { query: "a", difficulty: "Easy" }, /one of: Beginner/],
    ["unknown argument", { query: "a", evil: 1 }, /unknown argument "evil"/],
    ["prototype key", { query: "a", constructor: 1 }, /unknown argument "constructor"/],
    ["query too long", { query: "x".repeat(201) }, /too long/],
    ["arguments not an object", "oops", /must be a JSON object/],
    ["unknown project", { query: "a", project: "zzz" }, /no project matches "zzz"/],
  ])("rejects bad input as a tool error: %s", async (_name, args, message) => {
    const { server } = await ready();
    const r = await callTool(server, "search_questions", args);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(message);
  });

  it("an ambiguous project reference is an error, not a guess", async () => {
    const { server } = await ready();
    const r = await callTool(server, "search_questions", { query: "a", project: "p0" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/several projects \(p01-alpha, p02-beta\)/);
  });
});

describe("get_question", () => {
  it("renders the full question with code fence and extra sections", async () => {
    const { server } = await ready();
    const { text, isError } = await callTool(server, "get_question", { id: "ALPHA-001" });
    expect(isError).toBe(false);
    expect(text).toContain("# ALPHA-001: What is idempotency?");
    expect(text).toContain("## Answer (Hinglish)\nSame request twice, same result.");
    expect(text).toContain("```python\nx = 1\n```");
    expect(text).toContain("- projects/01-alpha/limiter.py");
    expect(text).toContain("- forgetting TTL");
    expect(text).not.toContain("## Disadvantages"); // empty sections are omitted
  });

  it("includes advanced sections when present, and accepts lower-case ids", async () => {
    const { server } = await ready();
    const { text } = await callTool(server, "get_question", { id: " alpha-003 " });
    expect(text).toContain("## Advanced: architecture tradeoffs\ntradeoff text");
  });

  it("unknown id is a tool error that tells the model what to do next", async () => {
    const { server } = await ready();
    const r = await callTool(server, "get_question", { id: "NOPE-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/search_questions/);
  });
});

describe("random_questions", () => {
  it("returns only questions (no answers), count-limited, deterministic with a fixed rng", async () => {
    const { server } = await ready(() => 0);
    const { text } = await callTool(server, "random_questions", { count: 2 });
    expect(text.split("\n")).toHaveLength(2);
    expect(text).toMatch(/^1\. ALPHA-001/);
    expect(text).not.toContain("Answer body");
  });

  it("applies filters and never repeats a question", async () => {
    const { server } = await ready(() => 0.5);
    const { text } = await callTool(server, "random_questions", { project: "beta", count: 10 });
    const ids = text.match(/BETA-\d+/g)!;
    expect(new Set(ids).size).toBe(3);
  });

  it("says so when filters match nothing; rejects count out of range", async () => {
    const { server } = await ready();
    expect((await callTool(server, "random_questions", { project: "beta", difficulty: "Senior/System Design" })).text).toBe("No questions match those filters.");
    expect((await callTool(server, "random_questions", { count: 11 })).isError).toBe(true);
  });
});

describe("get_pitch", () => {
  it("defaults to the 30-second intro", async () => {
    const { server } = await ready();
    const { text } = await callTool(server, "get_pitch", { project: "alpha" });
    expect(text).toContain("# Alpha Limiter (p01-alpha)");
    expect(text).toContain("## intro_30s\nAlpha in thirty seconds");
  });

  it("renders list sections as bullets, and 'all' returns every available section", async () => {
    const { server } = await ready();
    expect((await callTool(server, "get_pitch", { project: "p01", section: "difficult_decisions" })).text).toContain("- decision one\n- decision two");
    const all = (await callTool(server, "get_pitch", { project: "p01", section: "all" })).text;
    expect(all).toContain("## intro_30s");
    expect(all).toContain("## difficult_decisions");
    expect(all).not.toContain("## deep_5min"); // not present in this fixture
  });

  it("errors clearly when the section does not exist for that project", async () => {
    const { server } = await ready();
    const r = await callTool(server, "get_pitch", { project: "beta" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no pitch section/);
  });
});

describe("Bank.load", () => {
  const dirWith = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "mcp-bad-"));
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(root, path.split("/")[0]!), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  };

  it("fails loudly on a missing directory", () => {
    expect(() => Bank.load(join(tmpdir(), "definitely-not-here-xyz"))).toThrow(/not found/);
  });

  it("fails on malformed JSON and names the file", () => {
    const dir = dirWith({ "p1/meta.json": "{}", "p1/questions-01.json": "{ not json" });
    expect(() => Bank.load(dir)).toThrow(/questions-01\.json/);
  });

  it("fails on duplicate ids across files", () => {
    const q = JSON.stringify([question("DUP-1", "p1")]);
    const dir = dirWith({ "p1/meta.json": "{}", "p1/questions-01.json": q, "p1/questions-02.json": q });
    expect(() => Bank.load(dir)).toThrow(/duplicate question id DUP-1/);
  });

  it("fails when the directory holds no banks", () => {
    expect(() => Bank.load(mkdtempSync(join(tmpdir(), "mcp-empty-")))).toThrow(/no interview banks/);
  });
});
