import { useState } from "react";
import { loadBank, useAsync } from "../lib/data";
import { href } from "../lib/router";
import { bySlug } from "../lib/projects";
import { DIFFICULTIES } from "../lib/types";
import { Badge, Button, Card, Loading, Section } from "../components/ui";
import { Bullets, Rich } from "../components/Rich";
import { BenchChart } from "../components/BenchChart";
import { FileLink } from "../components/FileLink";
import { PitchView } from "./PitchView";

const DOCS = ["README", "ARCHITECTURE", "SYSTEM_DESIGN", "DATABASE_DESIGN", "API_DOCUMENTATION", "INTERVIEW_PREPARATION",
  "TRADEOFFS", "FAILURE_SCENARIOS", "SECURITY", "TESTING", "DEPLOYMENT", "LEARNING_GUIDE"];

export default function ProjectPage({ slug }: { slug: string }) {
  const p = bySlug(slug);
  const { data: bank, error } = useAsync(() => loadBank(slug), [slug]);
  const [lp, setLp] = useState(0);
  if (!p) return <p>Unknown project.</p>;
  return (
    <div>
      <a href="#/" className="text-sm text-sky-700 hover:underline dark:text-sky-300">&lt;- All projects</a>
      <h1 className="mt-2 text-3xl font-bold">{p.num}. {p.name}</h1>
      <p className="mt-2 text-lg text-slate-600 dark:text-slate-400">{p.tagline}</p>
      <div className="mt-3 flex flex-wrap gap-1">{p.stack.map((s) => <Badge key={s}>{s}</Badge>)}</div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <h2 className="font-semibold">Implemented</h2>
          <div className="mt-2 text-sm"><Bullets items={p.features} /></div>
        </Card>
        <Card>
          <h2 className="font-semibold">Tests</h2>
          <p className="mt-2 text-sm">{p.tests}</p>
          <h2 className="mt-4 font-semibold">Run</h2>
          <pre className="mt-2 whitespace-pre-wrap break-all rounded bg-[#0d1117] p-2 text-xs text-slate-200">{p.run}</pre>
        </Card>
      </div>

      {bank?.meta.summary && <Section title="Overview"><Rich text={bank.meta.summary} /></Section>}

      <Section title="Measured benchmarks">
        {p.benches.length === 0
          ? <p className="text-sm text-slate-600 dark:text-slate-400">Nothing has been measured for this project yet, so no numbers are shown.</p>
          : <div className="grid gap-4 lg:grid-cols-2">{p.benches.map((b) => <BenchChart key={b.title} b={b} />)}</div>}
      </Section>

      <Section title="Design documents">
        <div className="flex flex-wrap gap-2">
          {(p.docs ?? DOCS).map((d) => <a key={d} href={href("/source", { path: `${p.dir}/${d}.md` })}
            className="rounded-md border border-slate-300 px-2 py-1 font-mono text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900">{d}.md</a>)}
        </div>
      </Section>

      {!bank ? <div className="mt-10"><Loading error={error} /></div> : (
        <>
          <Section title="Explain this project in an interview"><PitchView pitch={bank.meta.pitch} /></Section>

          {bank.meta.learning_path?.length > 0 && (
            <Section title="Learning path">
              <div className="flex flex-wrap gap-2">
                {bank.meta.learning_path.map((l, i) => <Button key={l.concept} active={i === lp} onClick={() => setLp(i)}>{i + 1}. {l.concept}</Button>)}
              </div>
              {bank.meta.learning_path[lp] && (
                <Card className="mt-4">
                  <ol className="list-decimal space-y-1 pl-6 text-sm">{bank.meta.learning_path[lp].steps.map((s, i) => <li key={i}><Rich text={s.replace(/^\d+\.\s*/, "")} /></li>)}</ol>
                  <div className="mt-3 space-y-1">{bank.meta.learning_path[lp].files.map((f) => <div key={f}><FileLink ref_={f} /></div>)}</div>
                </Card>
              )}
            </Section>
          )}

          <Section title={`Interview questions (${bank.stats.questions})`}>
            <div className="flex flex-wrap gap-2">
              {DIFFICULTIES.map((d) => (
                <a key={d} href={href("/interview", { project: slug, difficulty: d })}>
                  <Badge tone={d}>{d}: {bank.stats.difficulties[d] || 0}</Badge>
                </a>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <a className="rounded-md bg-sky-600 px-4 py-2 text-sm text-white" href={href("/interview", { project: slug })}>Browse questions</a>
              <a className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700" href={href("/interview", { project: slug, mode: "mock" })}>Mock interview on this project</a>
            </div>
          </Section>
        </>
      )}
    </div>
  );
}
