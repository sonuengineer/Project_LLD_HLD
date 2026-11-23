import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Bench } from "../lib/projects";
import { FileLink } from "./FileLink";

const COLORS = ["#0284c7", "#f59e0b", "#10b981", "#e11d48"];
const fmt = (v: number) => v >= 10000 ? `${Math.round(v / 1000)}k` : String(v);

// Lower bound of a log axis: the power of ten at or below the smallest positive value. A fixed 1000 hid every bar
// below it (the resilience chart's 230-400 ns bars were not drawn).
function logFloor(b: Bench): number {
  const values = b.rows.flatMap((r) => b.series.map((s) => r[s])).filter((v): v is number => typeof v === "number" && v > 0);
  return values.length === 0 ? 1 : 10 ** Math.floor(Math.log10(Math.min(...values)));
}

export function BenchChart({ b }: { b: Bench }) {
  return (
    <figure className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <figcaption className="mb-2">
        <div className="font-medium">{b.title}</div>
        <div className="text-xs text-slate-500">{b.unit}</div>
      </figcaption>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={b.rows} margin={{ top: 8, right: 8, bottom: 8, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} interval={0} />
            <YAxis tick={{ fontSize: 11, fill: "#64748b" }} tickFormatter={fmt} width={48}
              {...(b.log ? { scale: "log" as const, domain: [logFloor(b), "auto"] as [number, string], allowDataOverflow: true } : {})} />
            <Tooltip formatter={(v: number) => v.toLocaleString()} contentStyle={{ fontSize: 12 }} />
            {b.series.length > 1 && <Legend wrapperStyle={{ fontSize: 12 }} />}
            {b.series.map((s, i) => <Bar key={s} dataKey={s} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} isAnimationActive={false} />)}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-slate-500">{b.note}</p>
      <p className="mt-1 text-xs text-slate-500">Source: <FileLink ref_={b.source} /></p>
    </figure>
  );
}
