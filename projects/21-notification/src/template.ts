// Templates: "Hi {{user.name}}, order {{orderId}} has shipped." A placeholder is a dotted path into the request data.
// - A missing value (absent, null, undefined) is an error, not an empty string: "Your OTP is " is worse than nothing.
// - Only the data's OWN properties are read, so {{constructor}} or {{__proto__}} cannot reach Object internals.
// - A value must be a string, a finite number or a boolean; an object or array would render "[object Object]".
// - escapeHtml is on for email bodies (HTML) only; SMS and push are plain text and must not show "&amp;".
import { NotificationError } from "./errors.js";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*\}\}/g;

export interface Template {
  subject?: string; // email only
  body: string;
}

// The paths used by a template, in order of first use. Throws INVALID_TYPE for a malformed template: a "{{" or "}}"
// that is not part of a valid placeholder (it would otherwise be sent to users literally).
export function placeholders(text: string): string[] {
  const rest = text.replace(PLACEHOLDER, "");
  if (rest.includes("{{") || rest.includes("}}")) {
    throw new NotificationError("INVALID_TYPE", `malformed placeholder in template: ${JSON.stringify(text)}`);
  }
  const paths: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const path = match[1]!;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lookup(data: Record<string, unknown>, path: string): string {
  let current: unknown = data;
  for (const part of path.split(".")) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) {
      throw new NotificationError("TEMPLATE_VARIABLE_MISSING", `no value for {{${path}}}`);
    }
    current = (current as Record<string, unknown>)[part];
  }
  if (current === null || current === undefined) {
    throw new NotificationError("TEMPLATE_VARIABLE_MISSING", `no value for {{${path}}}`);
  }
  if (typeof current === "string") return current;
  if (typeof current === "boolean") return String(current);
  if (typeof current === "number" && Number.isFinite(current)) return String(current);
  throw new NotificationError("INVALID_REQUEST", `{{${path}}} is not a string, finite number or boolean`);
}

export function renderText(text: string, data: Record<string, unknown>, escape: boolean): string {
  return text.replace(PLACEHOLDER, (_match, path: string) => {
    const value = lookup(data, path);
    return escape ? escapeHtml(value) : value;
  });
}

// Subject lines are plain text even in email (a mail client shows them as text), so only the body is escaped.
export function renderTemplate(template: Template, data: Record<string, unknown>, html: boolean): Template {
  const body = renderText(template.body, data, html);
  return template.subject === undefined ? { body } : { subject: renderText(template.subject, data, false), body };
}
