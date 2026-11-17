import { useEffect, useState } from "react";

// Minimal hash router: "#/interview?project=p01&q=RATE-001" -> { path: "/interview", params }.
// Hash routing keeps the built site working from any static file server without rewrite rules.
export interface Route { path: string; params: URLSearchParams }

function parse(): Route {
  const h = window.location.hash.replace(/^#/, "") || "/";
  const [path, qs] = h.split("?");
  return { path: path || "/", params: new URLSearchParams(qs || "") };
}

export function useRoute(): Route {
  const [r, setR] = useState(parse);
  useEffect(() => {
    const on = () => setR(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return r;
}

export function href(path: string, params?: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  Object.entries(params || {}).forEach(([k, v]) => v && p.set(k, v));
  const s = p.toString();
  return "#" + path + (s ? "?" + s : "");
}

export function navigate(path: string, params?: Record<string, string | undefined>) {
  window.location.hash = href(path, params).slice(1);
}
