// The MCP server core: takes ONE parsed JSON message, returns ONE response (or null for notifications).
// No I/O here -- the transport (stdio.ts) owns bytes, this file owns meaning. That split is what makes it testable.
//
// Message flow of a session:
//   client -> initialize            server -> {protocolVersion, capabilities, serverInfo}
//   client -> notifications/initialized   (a notification: no id, no reply)
//   client -> tools/list            server -> {tools: [...]}
//   client -> tools/call            server -> {content: [...], isError?}

import { ErrorCode, RpcError, fail, isObject, ok, type RpcResponse } from "./jsonrpc.js";
import { ToolError, validateArgs, type ObjectSchema } from "./schema.js";

/** Newest first. The first entry is what we answer with when the client asks for a version we don't know. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const SERVER_VERSION = "1.0.0";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ObjectSchema;
  handler: (args: Record<string, unknown>) => string | Promise<string>;
}

export interface ServerOptions {
  name: string;
  instructions?: string;
  tools: ToolDef[];
  log?: (message: string) => void;
}

export class McpServer {
  private initialized = false;
  private readonly tools = new Map<string, ToolDef>();
  private readonly log: (message: string) => void;

  constructor(private readonly opts: ServerOptions) {
    for (const t of opts.tools) {
      if (this.tools.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
      this.tools.set(t.name, t);
    }
    this.log = opts.log ?? (() => {});
  }

  /** Handle one decoded JSON value. Never throws: every failure becomes a JSON-RPC error response. */
  async handle(raw: unknown): Promise<RpcResponse | null> {
    if (Array.isArray(raw)) {
      // Batching was dropped from MCP in 2025-06-18; refusing is simpler and spec-compliant for new clients.
      return fail(null, ErrorCode.InvalidRequest, "JSON-RPC batches are not supported");
    }
    if (!isObject(raw)) return fail(null, ErrorCode.InvalidRequest, "request must be a JSON object");

    // A message with no "method" is a response to something WE sent. We never send requests, so ignore it.
    if (!("method" in raw) && ("result" in raw || "error" in raw)) return null;

    const hasId = "id" in raw;
    const id = raw.id;
    if (raw.jsonrpc !== "2.0" || typeof raw.method !== "string") {
      return fail(typeof id === "string" || typeof id === "number" ? id : null, ErrorCode.InvalidRequest, "not a valid JSON-RPC 2.0 request");
    }

    if (!hasId) {
      this.onNotification(raw.method); // notifications never get a reply, even on error
      return null;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      return fail(null, ErrorCode.InvalidRequest, "id must be a string or a number");
    }

    try {
      return ok(id, await this.dispatch(raw.method, raw.params));
    } catch (e) {
      if (e instanceof RpcError) return fail(id, e.code, e.message, e.data);
      // Unknown bug: log the detail locally, but do not leak internals to the client.
      this.log(`internal error in ${raw.method}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return fail(id, ErrorCode.InternalError, "internal error");
    }
  }

  private onNotification(method: string): void {
    if (method === "notifications/initialized") this.log("client finished initialization");
    // other notifications (cancelled, progress, ...) are accepted and ignored: we have no long-running work
  }

  private async dispatch(method: string, params: unknown): Promise<unknown> {
    if (method === "initialize") return this.initialize(params);
    if (method === "ping") return {};

    if (!this.initialized) {
      throw new RpcError(ErrorCode.InvalidRequest, "server not initialized: send the initialize request first");
    }
    switch (method) {
      case "tools/list":
        return { tools: [...this.tools.values()].map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
      case "tools/call":
        return this.callTool(params);
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `method not found: ${method}`);
    }
  }

  private initialize(params: unknown): unknown {
    if (!isObject(params) || typeof params.protocolVersion !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "initialize requires params.protocolVersion (string)");
    }
    const requested = params.protocolVersion;
    // Version negotiation: echo the client's version if we speak it, otherwise offer our newest and let the client decide.
    const known = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested);
    this.initialized = true;
    return {
      protocolVersion: known ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: this.opts.name, version: SERVER_VERSION },
      ...(this.opts.instructions ? { instructions: this.opts.instructions } : {}),
    };
  }

  private async callTool(params: unknown): Promise<unknown> {
    if (!isObject(params) || typeof params.name !== "string") {
      throw new RpcError(ErrorCode.InvalidParams, "tools/call requires params.name (string)");
    }
    const tool = this.tools.get(params.name);
    // Unknown tool = the request itself is wrong -> protocol error. Bad arguments = tool-level error (below).
    if (!tool) throw new RpcError(ErrorCode.InvalidParams, `unknown tool: ${params.name}`);

    try {
      const args = validateArgs(tool.inputSchema, params.arguments);
      const text = await tool.handler(args);
      return { content: [{ type: "text", text }] };
    } catch (e) {
      // isError=true keeps the failure INSIDE the conversation, so the model can read it and retry with fixed arguments.
      if (e instanceof ToolError) return { content: [{ type: "text", text: e.message }], isError: true };
      this.log(`tool ${tool.name} crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      return { content: [{ type: "text", text: "tool failed unexpectedly" }], isError: true };
    }
  }
}
