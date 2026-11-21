// HTML for the login page and the "cannot redirect" error page. Every dynamic value goes through escapeHtml.
import { escapeHtml } from "./http.js";

const STYLE = "body{font-family:sans-serif;max-width:24rem;margin:3rem auto;padding:0 1rem}" +
  "label,input,button{display:block;width:100%;margin:.4rem 0}input{padding:.4rem}.err{color:#a00}";

export function loginPage(opts: { clientName: string; scope: string[]; csrfToken: string; error?: string }): string {
  const err = opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign in</title><style>${STYLE}</style></head>
<body>
<h1>Sign in</h1>
<p>${escapeHtml(opts.clientName)} is asking for: ${escapeHtml(opts.scope.join(" "))}</p>
${err}
<form method="post" action="/login">
<input type="hidden" name="csrf_token" value="${escapeHtml(opts.csrfToken)}">
<label for="username">Username</label><input id="username" name="username" autocomplete="username" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Sign in</button>
</form>
</body></html>`;
}

export function errorPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><h1>${escapeHtml(title)}</h1><p class="err">${escapeHtml(message)}</p></body></html>`;
}

export function signedOutPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Signed out</title><style>${STYLE}</style></head>
<body><h1>Signed out</h1><p>You are signed out. You can close this window.</p></body></html>`;
}
