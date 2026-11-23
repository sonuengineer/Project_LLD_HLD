// Test helpers shared by the framework adapter tests: a scripted upstream HTTP server and a fetch wrapper.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { HttpError, parseRetryAfter } from "../src/http.js";

export type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Upstream {
  url: string;
  hits: () => number;
  closedEarly: () => number; // requests whose client went away before we answered
  setHandler: (h: Handler) => void;
  close: () => Promise<void>;
}

export async function upstream(initial: Handler): Promise<Upstream> {
  let handler = initial;
  let hits = 0;
  let closedEarly = 0;
  const server: Server = createServer((req, res) => {
    hits++;
    res.on("close", () => {
      if (!res.writableFinished) closedEarly++;
    });
    handler(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    hits: () => hits,
    closedEarly: () => closedEarly,
    setHandler: (h) => (handler = h),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export const json = (body: unknown): Handler => (_req, res) => {
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
};
export const status = (code: number): Handler => (_req, res) => {
  res.writeHead(code).end();
};
export const hang: Handler = () => {};

export async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
  }
  return res.json();
}

export async function eventually(check: () => boolean, ms = 1000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("condition not reached in time");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function addressOf(server: Server): string {
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
