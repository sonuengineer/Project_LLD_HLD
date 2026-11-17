import type { ReactNode } from "react";

export const Card = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={"rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900 " + className}>{children}</div>
);

const DIFF_COLORS: Record<string, string> = {
  Beginner: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  Intermediate: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  Advanced: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  "Senior/System Design": "bg-rose-100 text-rose-800 dark:bg-rose-900/50 dark:text-rose-300",
};
export const Badge = ({ children, tone }: { children: ReactNode; tone?: string }) => (
  <span className={"inline-block rounded-full px-2 py-0.5 text-xs font-medium " +
    (DIFF_COLORS[tone || ""] || "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300")}>{children}</span>
);

export const Button = ({ children, onClick, active, className = "", title }:
  { children: ReactNode; onClick?: () => void; active?: boolean; className?: string; title?: string }) => (
  <button title={title} onClick={onClick} className={"rounded-md border px-3 py-1.5 text-sm transition " + (active
    ? "border-sky-600 bg-sky-600 text-white"
    : "border-slate-300 bg-white hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800") + " " + className}>
    {children}
  </button>
);

export const Section = ({ title, children, id }: { title: string; children: ReactNode; id?: string }) => (
  <section id={id} className="mt-10">
    <h2 className="mb-4 text-xl font-semibold">{title}</h2>
    {children}
  </section>
);

export const Loading = ({ error }: { error?: string }) => error
  ? <div className="rounded-lg border border-rose-300 bg-rose-50 p-4 text-rose-800 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-200">
      Could not load data: {error}. Run <code>npm run data</code> in <code>portfolio/</code> first.
    </div>
  : <div className="p-6 text-slate-500">Loading...</div>;
