import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { serveStdio } from "../src/stdio.js";
import { makeServer } from "./helpers.js";

/** Feed raw lines in, close stdin, return every JSON line the server wrote. */
async function run(lines: string[]): Promise<Record<string, unknown>[]> {
  const { server } = makeServer();
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (c: Buffer) => chunks.push(c));

  const done = serveStdio(server, input, output);
  for (const l of lines) input.write(l + "\n");
  input.end();
  await done;

  const text = Buffer.concat(chunks).toString("utf8");
  expect(text === "" || text.endsWith("\n")).toBe(true); // every message is newline terminated
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });

describe("stdio framing", () => {
  it("answers each request on its own line, matched by id", async () => {
    const out = await run([
      INIT,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_projects" } }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
    ]);
    expect(out.map((m) => m.id).sort()).toEqual([1, 2, 3]); // notification produced no output
    expect(out.every((m) => m.jsonrpc === "2.0")).toBe(true);
  });

  it("replies to garbage with a parse error (id null) and keeps serving", async () => {
    const out = await run(["this is not json", "{broken", INIT]);
    const errors = out.filter((m) => m.id === null);
    expect(errors).toHaveLength(2);
    expect((errors[0]!.error as { code: number }).code).toBe(-32700);
    expect(out.some((m) => m.id === 1 && "result" in m)).toBe(true);
  });

  it("ignores blank lines and tolerates CRLF line endings", async () => {
    const out = await run(["", "   ", INIT + "\r"]);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(1);
  });

  it("output messages never contain a raw newline, even when the answer text does", async () => {
    const out = await run([
      INIT,
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_question", arguments: { id: "ALPHA-001" } } }),
    ]);
    const call = out.find((m) => m.id === 2) as { result: { content: { text: string }[] } };
    expect(call.result.content[0]!.text).toContain("\n"); // multi-line answer survived, escaped on the wire
  });

  it("resolves after stdin closes with no input at all", async () => {
    expect(await run([])).toEqual([]);
  });
});
