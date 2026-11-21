// Small helpers on top of node:http: form bodies, cookies, OAuth error responses.
import type { IncomingMessage, ServerResponse } from "node:http";

export const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on("data", (c: Buffer) => {
      if (failed) return;
      size += c.length;
      if (size > limit) {
        failed = true;
        reject(new HttpError(413, "request body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (e) => {
      if (!failed) reject(e);
    });
  });
}

export function isFormEncoded(req: IncomingMessage): boolean {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  return ct === "application/x-www-form-urlencoded";
}

/**
 * Parses a form body into single values. RFC 6749 3.1 / 3.2: request parameters MUST NOT appear more than
 * once, so a repeated name is reported instead of silently taking the first or last value.
 */
export function parseForm(body: string): { params: Map<string, string>; duplicate?: string } {
  const sp = new URLSearchParams(body);
  const params = new Map<string, string>();
  for (const [k, v] of sp) {
    if (params.has(k)) return { params, duplicate: k };
    params.set(k, v);
  }
  return { params };
}

export function parseCookies(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k && !out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

export function noStore(res: ServerResponse): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers });
  res.end(data);
}

/** RFC 6749 5.2 error response. Token-endpoint style errors are always no-store. */
export function oauthError(res: ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
  noStore(res);
  sendJson(res, status, { error, error_description: description }, headers);
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

export function sendHtml(res: ServerResponse, status: number, html: string, headers: Record<string, string | string[]> = {}): void {
  noStore(res);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    // The login page must not be framed (clickjacking) and runs no scripts. No form-action directive: some
    // browsers apply it to the redirect that follows the form post, which goes to the client's redirect_uri.
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(html);
}
