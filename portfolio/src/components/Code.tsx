import { useEffect, useMemo, useRef } from "react";
import hljs from "highlight.js/lib/core";
import python from "highlight.js/lib/languages/python";
import sql from "highlight.js/lib/languages/sql";
import lua from "highlight.js/lib/languages/lua";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import xml from "highlight.js/lib/languages/xml";
import nginx from "highlight.js/lib/languages/nginx";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import markdown from "highlight.js/lib/languages/markdown";
import "highlight.js/styles/github-dark.css";

// Only the languages this repo actually uses are registered (keeps the bundle small).
const LANGS = { python, sql, lua, bash, json, typescript, javascript, yaml, ini, xml, nginx, dockerfile, markdown };
Object.entries(LANGS).forEach(([n, l]) => hljs.registerLanguage(n, l));
const ALIAS: Record<string, string> = { py: "python", sh: "bash", shell: "bash", ts: "typescript", js: "javascript",
  html: "xml", toml: "ini", env: "ini", conf: "nginx", md: "markdown", yml: "yaml", mermaid: "markdown" };

export function langForPath(path: string): string {
  const name = path.split("/").pop() || "";
  if (/^Dockerfile/.test(name)) return "dockerfile";
  if (name.startsWith(".env")) return "ini";
  if (name.endsWith("nginx.conf")) return "nginx";
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return ALIAS[ext] || ext || "text";
}

export function Code({ code, lang, lineNumbers, focusLine }: { code: string; lang?: string; lineNumbers?: boolean; focusLine?: number }) {
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => { if (focusLine) mark.current?.scrollIntoView({ block: "center" }); }, [focusLine, code]);
  const html = useMemo(() => {
    const l = ALIAS[lang || ""] || lang || "";
    try {
      return hljs.getLanguage(l) ? hljs.highlight(code, { language: l }).value : escape(code);
    } catch {
      return escape(code);
    }
  }, [code, lang]);
  const lines = lineNumbers ? code.split("\n").length : 0;
  return (
    <div className="relative overflow-x-auto rounded-lg bg-[#0d1117] text-[13px] leading-5">
      {focusLine ? <div ref={mark} className="pointer-events-none absolute inset-x-0 h-5 bg-amber-400/15"
        style={{ top: `calc(0.75rem + ${(focusLine - 1) * 20}px)` }} /> : null}
      <div className="flex">
        {lineNumbers && (
          <pre className="select-none border-r border-slate-700 px-3 py-3 text-right text-slate-500">
            {Array.from({ length: lines }, (_, i) => i + 1).join("\n")}
          </pre>
        )}
        <pre className="flex-1 px-4 py-3"><code className="hljs !bg-transparent !p-0" dangerouslySetInnerHTML={{ __html: html }} /></pre>
      </div>
    </div>
  );
}

function escape(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
}
