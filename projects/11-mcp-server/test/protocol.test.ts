import { SUPPORTED_PROTOCOL_VERSIONS as SDK_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { ErrorCode } from "../src/jsonrpc.js";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../src/protocol.js";
import { init, makeServer, rpc } from "./helpers.js";

const errorOf = (r: unknown) => (r as { error: { code: number; message: string } }).error;
const resultOf = (r: unknown) => (r as { result: Record<string, unknown> }).result;

describe("initialize / version negotiation", () => {
  it("echoes a protocol version it supports", async () => {
    const { server } = makeServer();
    const r = resultOf(await init(server, "2025-03-26"));
    expect(r.protocolVersion).toBe("2025-03-26");
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect((r.serverInfo as { name: string }).name).toBe("test");
  });

  it("answers with its newest version when the client asks for an unknown one", async () => {
    const { server } = makeServer();
    expect(resultOf(await init(server, "1999-01-01")).protocolVersion).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("rejects initialize without protocolVersion", async () => {
    const { server } = makeServer();
    expect(errorOf(await rpc(server, "initialize", {})).code).toBe(ErrorCode.InvalidParams);
    expect(errorOf(await rpc(server, "initialize")).code).toBe(ErrorCode.InvalidParams);
  });

  it("every version we claim to speak is a real MCP version (checked against the official SDK list)", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(SDK_VERSIONS).toContain(v);
  });
});

describe("lifecycle rules", () => {
  it("rejects requests before initialize, but allows ping", async () => {
    const { server } = makeServer();
    expect(errorOf(await rpc(server, "tools/list")).code).toBe(ErrorCode.InvalidRequest);
    expect(resultOf(await rpc(server, "ping"))).toEqual({});
  });

  it("returns null (no reply) for notifications, known or unknown", async () => {
    const { server } = makeServer();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await server.handle({ jsonrpc: "2.0", method: "notifications/whatever", params: { a: 1 } })).toBeNull();
  });

  it("ignores messages that are responses to server requests", async () => {
    const { server } = makeServer();
    expect(await server.handle({ jsonrpc: "2.0", id: 9, result: {} })).toBeNull();
  });

  it("unknown method after init -> method not found", async () => {
    const { server } = makeServer();
    await init(server);
    expect(errorOf(await rpc(server, "resources/list")).code).toBe(ErrorCode.MethodNotFound);
  });
});

describe("request validation", () => {
  it.each([
    ["missing jsonrpc", { id: 1, method: "ping" }],
    ["wrong jsonrpc version", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["method not a string", { jsonrpc: "2.0", id: 1, method: 5 }],
  ])("%s -> invalid request, id echoed", async (_name, msg) => {
    const { server } = makeServer();
    const r = (await server.handle(msg)) as { id: unknown; error: { code: number } };
    expect(r.error.code).toBe(ErrorCode.InvalidRequest);
    expect(r.id).toBe(1);
  });

  it("rejects null / object ids, non-object messages and batches", async () => {
    const { server } = makeServer();
    for (const msg of [{ jsonrpc: "2.0", id: null, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }, 42, "x", null, []]) {
      expect(errorOf(await server.handle(msg)).code).toBe(ErrorCode.InvalidRequest);
    }
    expect(errorOf(await server.handle([{ jsonrpc: "2.0", id: 1, method: "ping" }])).message).toMatch(/batch/);
  });

  it("accepts string ids and echoes them back", async () => {
    const { server } = makeServer();
    const r = (await server.handle({ jsonrpc: "2.0", id: "abc-1", method: "ping" })) as { id: string };
    expect(r.id).toBe("abc-1");
  });
});

describe("tools/list and tools/call envelope", () => {
  it("lists all five tools with schemas and never exposes handlers", async () => {
    const { server } = makeServer();
    await init(server);
    const tools = resultOf(await rpc(server, "tools/list")).tools as Record<string, unknown>[];
    expect(tools.map((t) => t.name).sort()).toEqual(["get_pitch", "get_question", "list_projects", "random_questions", "search_questions"]);
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(["description", "inputSchema", "name"]);
      expect((t.inputSchema as { additionalProperties: boolean }).additionalProperties).toBe(false);
    }
  });

  it("unknown tool and missing name are protocol errors (-32602)", async () => {
    const { server } = makeServer();
    await init(server);
    expect(errorOf(await rpc(server, "tools/call", { name: "nope" })).code).toBe(ErrorCode.InvalidParams);
    expect(errorOf(await rpc(server, "tools/call", {})).code).toBe(ErrorCode.InvalidParams);
    expect(errorOf(await rpc(server, "tools/call")).code).toBe(ErrorCode.InvalidParams);
  });

  it("a crashing tool becomes isError without leaking internals, and is logged", async () => {
    const logs: string[] = [];
    const server = new McpServer({
      name: "t",
      log: (m) => logs.push(m),
      tools: [{ name: "boom", description: "d", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: () => { throw new Error("secret /etc/path detail"); } }],
    });
    await init(server);
    const r = resultOf(await rpc(server, "tools/call", { name: "boom" })) as { isError: boolean; content: { text: string }[] };
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe("tool failed unexpectedly");
    expect(logs.join("\n")).toContain("secret /etc/path detail");
  });

  it("refuses duplicate tool names at construction", () => {
    const t = { name: "x", description: "d", inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const }, handler: () => "" };
    expect(() => new McpServer({ name: "t", tools: [t, t] })).toThrow(/duplicate/);
  });
});
