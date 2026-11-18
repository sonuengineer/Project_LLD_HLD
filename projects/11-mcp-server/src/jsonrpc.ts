// JSON-RPC 2.0 building blocks. MCP is "JSON-RPC 2.0 + a fixed set of methods", so this is the wire format.
// Spec: https://www.jsonrpc.org/specification

export type RpcId = string | number;

export const ErrorCode = {
  ParseError: -32700, // the line was not valid JSON
  InvalidRequest: -32600, // valid JSON, but not a valid JSON-RPC request
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export type RpcResponse =
  | { jsonrpc: "2.0"; id: RpcId; result: unknown }
  | { jsonrpc: "2.0"; id: RpcId | null; error: RpcErrorBody };

/** Thrown by handlers to produce a JSON-RPC error response with a specific code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const ok = (id: RpcId, result: unknown): RpcResponse => ({ jsonrpc: "2.0", id, result });

export const fail = (id: RpcId | null, code: number, message: string, data?: unknown): RpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data },
});
