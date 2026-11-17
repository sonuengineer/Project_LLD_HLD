import { Fragment } from "react";
import { href } from "../lib/router";

// Renders answer text: paragraphs separated by blank lines, `inline code`, **bold**, and bullet lines
// ("- " / "1. "). Text is never injected as HTML.
function inline(text: string, key: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) {
      const inner = p.slice(1, -1);
      if (/^projects\/[\w./-]+\.\w+$/.test(inner)) {
        return <a key={key + i} href={href("/source", { path: inner })} className="rounded bg-slate-200 px-1 font-mono text-[0.85em] text-sky-700 hover:underline dark:bg-slate-800 dark:text-sky-300">{inner}</a>;
      }
      return <code key={key + i} className="rounded bg-slate-200 px-1 font-mono text-[0.85em] dark:bg-slate-800">{inner}</code>;
    }
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={key + i}>{p.slice(2, -2)}</strong>;
    return <Fragment key={key + i}>{p}</Fragment>;
  });
}

export function Rich({ text, className = "" }: { text: string; className?: string }) {
  const blocks = text.split(/\n\s*\n/);
  return (
    <div className={"space-y-3 leading-relaxed " + className}>
      {blocks.map((b, bi) => {
        const lines = b.split("\n");
        if (lines.every((l) => /^\s*(- |\* |\d+[.)] )/.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]);
          const L = ordered ? "ol" : "ul";
          return (
            <L key={bi} className={(ordered ? "list-decimal" : "list-disc") + " space-y-1 pl-6"}>
              {lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*(- |\* |\d+[.)] )/, ""), `${bi}-${li}-`)}</li>)}
            </L>
          );
        }
        return <p key={bi} className="whitespace-pre-line">{inline(b, `${bi}-`)}</p>;
      })}
    </div>
  );
}

export function Bullets({ items }: { items: string[] }) {
  return <ul className="list-disc space-y-1 pl-6">{items.map((t, i) => <li key={i}>{inline(t, `b${i}-`)}</li>)}</ul>;
}
