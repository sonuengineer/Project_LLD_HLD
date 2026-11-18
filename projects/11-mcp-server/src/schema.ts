// Tool arguments come from an LLM, so they are untrusted input: validate every one before the handler runs.
// The schema objects below ARE valid JSON Schema, so the same object is sent to the client in tools/list
// and used here for validation -- one definition, no drift.

import { isObject } from "./jsonrpc.js";

export interface PropSchema {
  type: "string" | "integer";
  description: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  default?: string | number;
}

export interface ObjectSchema {
  type: "object";
  properties: Record<string, PropSchema>;
  required?: readonly string[];
  additionalProperties: false;
}

/** A problem the caller can fix (bad argument, unknown id). Becomes a tool result with isError=true. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function validateArgs(schema: ObjectSchema, input: unknown): Record<string, unknown> {
  const args = input === undefined ? {} : input;
  if (!isObject(args)) throw new ToolError("arguments must be a JSON object");

  for (const key of Object.keys(args)) {
    // hasOwn, not `in`: "constructor" / "toString" must not count as known properties
    if (!Object.hasOwn(schema.properties, key)) {
      throw new ToolError(`unknown argument "${key}" (allowed: ${Object.keys(schema.properties).join(", ") || "none"})`);
    }
  }

  const out: Record<string, unknown> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    const v = args[name];
    if (v === undefined) {
      if (schema.required?.includes(name)) throw new ToolError(`"${name}" is required`);
      if (prop.default !== undefined) out[name] = prop.default;
      continue;
    }
    if (prop.type === "string") {
      if (typeof v !== "string") throw new ToolError(`"${name}" must be a string`);
      if (prop.maxLength !== undefined && v.length > prop.maxLength) {
        throw new ToolError(`"${name}" is too long (max ${prop.maxLength} characters)`);
      }
      if (prop.enum && !prop.enum.includes(v)) {
        throw new ToolError(`"${name}" must be one of: ${prop.enum.join(", ")}`);
      }
    } else {
      if (typeof v !== "number" || !Number.isInteger(v)) throw new ToolError(`"${name}" must be an integer`);
      if (prop.minimum !== undefined && v < prop.minimum) throw new ToolError(`"${name}" must be >= ${prop.minimum}`);
      if (prop.maximum !== undefined && v > prop.maximum) throw new ToolError(`"${name}" must be <= ${prop.maximum}`);
    }
    out[name] = v;
  }
  return out;
}
