import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { loadAll, useAsync } from "../lib/data";
import { useProgress, useLocalSetting } from "../lib/progress";
import { href } from "../lib/router";
import { bySlug } from "../lib/projects";
import { DIFFICULTIES } from "../lib/types";
import { Button, Card, Loading, Section } from "../components/ui";

export default function ProgressPage() {
  const { data, error } = useAsync(loadAll, []);
  const pr = useProgress();
  const [root, setRoot] = useLocalSetting("bp-repo-root", "");
  if (!data) return <Loading error={error} />;
  const rows = Object.entries(data).map(([slug, b]) => {
    const learned = b.questions.filter((q) => pr.isLearned(q.id)).length;
    return { slug, name: bySlug(slug) ? `P${String(bySlug(slug)!.num).padStart(2, "0")}` : "SysD", full: b.meta.project,
      learned, remaining: b.questions.length - learned, total: b.questions.length,
      bookmarked: b.questions.filter((q) => pr.isBookmarked(q.id)).length };
  });
  const all = Object.values(data).flatMap((b) => b.questions);
  const tot = all.length, learned = all.filter((q) => pr.isLearned(q.id)).length;
  const byDiff = DIFFICULTIES.map((d) => {
    const qs = all.filter((q) => q.difficulty === d);
    return { d, total: qs.length, learned: qs.filter((q) => pr.isLearned(q.id)).length };
  });
  return (
    <div>
      <h1 className="text-2xl font-bold">Progress</h1>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Card><div className="text-sm text-slate-500">Learned</div><div className="text-3xl font-bold">{learned} <span className="text-base font-normal text-slate-500">/ {tot}</span></div>
          <div className="mt-2 h-2 rounded bg-slate-200 dark:bg-slate-800"><div className="h-2 rounded bg-emerald-500" style={{ width: `${tot ? (100 * learned) / tot : 0}%` }} /></div></Card>
        <Card><div className="text-sm text-slate-500">Bookmarked</div><div className="text-3xl font-bold">{Object.keys(pr.bookmarked).length}</div>
          <a className="text-sm text-sky-700 hover:underline dark:text-sky-300" href={href("/interview", { mode: "revision" })}>Open revision mode</a></Card>
        <Card><div className="text-sm text-slate-500">By difficulty</div>
          {byDiff.map((x) => <div key={x.d} className="flex justify-between text-sm"><span>{x.d}</span><span>{x.learned} / {x.total}</span></div>)}</Card>
      </div>
      <Section title="Per project">
        <Card>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows}>
                <CartesianGrid strokeDasharray="3 3" stroke="#94a3b833" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: "#64748b" }} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} width={36} />
                <Tooltip labelFormatter={(_, p) => p?.[0]?.payload?.full ?? ""} contentStyle={{ fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="learned" stackId="a" fill="#10b981" isAnimationActive={false} />
                <Bar dataKey="remaining" stackId="a" fill="#94a3b8" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-slate-500"><th className="py-2">Bank</th><th>Learned</th><th>Bookmarked</th><th>Total</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.slug} className="border-t border-slate-200 dark:border-slate-800">
                <td className="py-2">{r.full}</td><td>{r.learned}</td><td>{r.bookmarked}</td><td>{r.total}</td>
                <td><a className="text-sky-700 hover:underline dark:text-sky-300" href={href("/interview", { project: r.slug, status: "unlearned" })}>study</a></td>
              </tr>))}</tbody>
          </table>
        </div>
      </Section>
      <Section title="Settings">
        <Card>
          <label className="block text-sm">Local path of this repository (optional, adds "open in VS Code" links)
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="H:/project"
              className="mt-1 block w-full max-w-md rounded-md border border-slate-300 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900" />
          </label>
          <div className="mt-4"><Button onClick={() => { if (confirm("Reset all learned / bookmarked marks?")) pr.reset(); }}>Reset progress</Button></div>
        </Card>
      </Section>
    </div>
  );
}
