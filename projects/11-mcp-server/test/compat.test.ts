// Interoperability test: the OFFICIAL MCP client SDK talks to OUR server as a real child process over real stdio,
// reading the REAL interview banks. If our hand-written protocol layer deviated from the spec, this is where it fails.
// The SDK is a devDependency only -- the server itself has no runtime dependencies.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
let client: Client;

const textOf = (r: unknown): string => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

beforeAll(async () => {
  if (!existsSync(entry)) throw new Error("dist/index.js missing -- run `npm run build` first (npm test does it for you)");
  client = new Client({ name: "compat-test", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe" }));
}, 30_000);

afterAll(async () => {
  await client?.close();
});

describe("official SDK client <-> our server", () => {
  it("completes the initialize handshake", () => {
    expect(client.getServerVersion()?.name).toBe("interview-mcp");
    expect(client.getServerCapabilities()?.tools).toBeDefined();
    expect(client.getInstructions()).toMatch(/list_projects/);
  });

  it("lists the five tools with valid JSON Schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["get_pitch", "get_question", "list_projects", "random_questions", "search_questions"]);
    for (const t of tools) expect(t.inputSchema.type).toBe("object");
  });

  it("serves the real banks end to end: list -> search -> get", async () => {
    const list = textOf(await client.callTool({ name: "list_projects", arguments: {} }));
    expect(list).toMatch(/^11 projects, \d+ questions/);
    expect(list).toContain("p09-payments");

    const found = textOf(await client.callTool({ name: "search_questions", arguments: { query: "idempotency key", project: "payments", limit: 3 } }));
    const id = found.match(/PAYS-\d{3}/)?.[0];
    expect(id).toBeDefined();

    const full = textOf(await client.callTool({ name: "get_question", arguments: { id } }));
    expect(full).toContain(`# ${id}:`);
    expect(full).toContain("## Answer (Hinglish)");
  });

  it("serves pitches and quizzes from the real banks", async () => {
    expect(textOf(await client.callTool({ name: "get_pitch", arguments: { project: "p09" } }))).toContain("# Payment System (p09-payments)");
    const quiz = textOf(await client.callTool({ name: "random_questions", arguments: { count: 3, difficulty: "Advanced" } }));
    expect(quiz.split("\n")).toHaveLength(3);
  });

  it("surfaces bad arguments as isError results the model can read", async () => {
    const r = await client.callTool({ name: "get_question", arguments: { id: "NOPE-999" } });
    expect(r.isError).toBe(true);
  });

  it("surfaces an unknown tool as a protocol error", async () => {
    await expect(client.callTool({ name: "does_not_exist", arguments: {} })).rejects.toThrow(/unknown tool/);
  });
});
