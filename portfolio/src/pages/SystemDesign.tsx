import { loadBank, useAsync } from "../lib/data";
import { href } from "../lib/router";
import { Badge, Card, Loading, Section } from "../components/ui";
import { QuestionView } from "../components/QuestionView";
import { PitchView } from "./PitchView";

export default function SystemDesign({ params }: { params: URLSearchParams }) {
  const { data: bank, error } = useAsync(() => loadBank("cross-project"), []);
  if (!bank) return <Loading error={error} />;
  const id = params.get("q");
  const q = bank.questions.find((x) => x.id === id);
  if (q) {
    return (
      <div>
        <a className="text-sm text-sky-700 hover:underline dark:text-sky-300" href={href("/system-design")}>&lt;- All system design questions</a>
        <Card className="mt-4"><QuestionView key={q.id} q={q} /></Card>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-2xl font-bold">Cross-project system design</h1>
      <p className="mt-1 text-slate-600 dark:text-slate-400">Design questions answered with evidence from several projects at once.</p>
      <Section title="Using the ten projects in a design round"><PitchView pitch={bank.meta.pitch} /></Section>
      <Section title={`Questions (${bank.questions.length})`}>
        <div className="space-y-2">
          {bank.questions.map((x) => (
            <a key={x.id} href={href("/system-design", { q: x.id })} className="block rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-sky-400 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex flex-wrap gap-2 text-xs"><span className="font-mono text-slate-500">{x.id}</span><Badge tone={x.difficulty}>{x.difficulty}</Badge><Badge>{x.category}</Badge></div>
              <div className="mt-1 font-medium">{x.question}</div>
            </a>
          ))}
        </div>
      </Section>
    </div>
  );
}
