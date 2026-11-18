import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bank } from "../src/data.js";
import { McpServer } from "../src/protocol.js";
import { buildTools } from "../src/tools.js";

export function question(id: string, slug: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    project_slug: slug,
    category: "Fundamentals",
    difficulty: "Beginner",
    question: `Question text for ${id}`,
    answer_hinglish: `Answer body for ${id}`,
    why_needed: "",
    real_world_analogy: "",
    how_it_works: "",
    in_this_project: "",
    implementation_files: [],
    code_example: "",
    code_language: "",
    advantages: [],
    disadvantages: [],
    common_mistakes: [],
    follow_up_questions: ["follow up one", "follow up two"],
    concepts: [],
    advanced: null,
    ...over,
  };
}

/** Two small projects in a temp dir:  p01-alpha (3 questions, pitch) and p02-beta (3 questions, no pitch). */
export function makeFixtureDir(): string {
  const root = mkdtempSync(join(tmpdir(), "mcp-bank-"));
  const alpha = join(root, "p01-alpha");
  const beta = join(root, "p02-beta");
  mkdirSync(alpha);
  mkdirSync(beta);

  writeFileSync(
    join(alpha, "meta.json"),
    JSON.stringify({
      project_slug: "p01-alpha",
      project: "Alpha Limiter",
      summary: "Alpha summary",
      pitch: {
        intro_30s: "Alpha in thirty seconds",
        difficult_decisions: ["decision one", "decision two"],
      },
    }),
  );
  writeFileSync(
    join(alpha, "questions-01.json"),
    JSON.stringify([
      question("ALPHA-001", "p01-alpha", {
        question: "What is idempotency?",
        concepts: ["idempotency", "retry"],
        answer_hinglish: "Same request twice, same result.",
        in_this_project: "See limiter.py",
        implementation_files: ["projects/01-alpha/limiter.py"],
        code_example: "x = 1",
        code_language: "python",
        common_mistakes: ["forgetting TTL"],
      }),
      question("ALPHA-002", "p01-alpha", {
        question: "How does the token bucket refill?",
        category: "Internal Implementation",
        difficulty: "Intermediate",
        concepts: ["token bucket"],
        answer_hinglish: "Mentions idempotency only in the body.",
      }),
    ]),
  );
  writeFileSync(
    join(alpha, "questions-02.json"),
    JSON.stringify([
      question("ALPHA-003", "p01-alpha", {
        question: "Design a global limiter",
        category: "Architecture & System Design",
        difficulty: "Senior/System Design",
        advanced: { architecture_tradeoffs: "tradeoff text" },
      }),
    ]),
  );

  writeFileSync(
    join(beta, "meta.json"),
    JSON.stringify({ project_slug: "p02-beta", project: "Beta Queue", summary: "Beta summary", pitch: {} }),
  );
  writeFileSync(
    join(beta, "questions-01.json"),
    JSON.stringify([
      question("BETA-001", "p02-beta", { question: "What is a visibility timeout?", concepts: ["visibility timeout"] }),
      question("BETA-002", "p02-beta", { question: "Explain retry with backoff", concepts: ["retry", "backoff"], difficulty: "Intermediate" }),
      question("BETA-003", "p02-beta", { question: "Dead letter queue", difficulty: "Advanced", advanced: { failure_scenarios: "x" } }),
    ]),
  );
  return root;
}

export function makeServer(dir = makeFixtureDir(), rng: () => number = () => 0) {
  const bank = Bank.load(dir);
  const logs: string[] = [];
  const server = new McpServer({ name: "test", tools: buildTools(bank, rng), log: (m) => logs.push(m) });
  return { bank, server, logs };
}

let nextId = 1;
export async function rpc(server: McpServer, method: string, params?: unknown) {
  return server.handle({ jsonrpc: "2.0", id: nextId++, method, params });
}

export async function init(server: McpServer, protocolVersion = "2025-06-18") {
  return rpc(server, "initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "t", version: "0" } });
}

/** Call a tool and return {text, isError}. Asserts the response is a successful JSON-RPC result. */
export async function callTool(server: McpServer, name: string, args?: unknown) {
  const res = await rpc(server, "tools/call", { name, arguments: args });
  if (!res || !("result" in res)) throw new Error(`expected result, got ${JSON.stringify(res)}`);
  const r = res.result as { content: { type: string; text: string }[]; isError?: boolean };
  return { text: r.content[0]!.text, isError: r.isError === true };
}
