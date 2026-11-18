// stdio transport: one JSON message per line, UTF-8, "\n" delimited.
//   - stdin  = messages from the client
//   - stdout = messages to the client ONLY (anything else written here corrupts the protocol)
//   - stderr = logs
// JSON.stringify never emits a raw newline (it escapes them), so "one line = one message" is always safe.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { ErrorCode, fail } from "./jsonrpc.js";
import type { McpServer } from "./protocol.js";

/** Serve until the input stream ends. Resolves after every in-flight request has been answered. */
export async function serveStdio(server: McpServer, input: Readable, output: Writable): Promise<void> {
  const inflight = new Set<Promise<void>>();

  const send = (message: unknown): void => {
    output.write(JSON.stringify(message) + "\n");
  };

  const processLine = async (line: string): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      send(fail(null, ErrorCode.ParseError, "parse error: line is not valid JSON"));
      return;
    }
    const response = await server.handle(parsed);
    if (response) send(response);
  };

  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", (raw) => {
    const line = raw.trim();
    if (!line) return;
    // Requests run concurrently; each response carries its own id, so order does not matter.
    const p = processLine(line).finally(() => inflight.delete(p));
    inflight.add(p);
  });

  await new Promise<void>((resolve) => rl.once("close", resolve));
  await Promise.all(inflight);
}
