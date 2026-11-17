import { useState } from "react";
import type { Question } from "../lib/types";
import { useProgress } from "../lib/progress";
import { bySlug } from "../lib/projects";
import { Badge, Button } from "./ui";
import { Bullets, Rich } from "./Rich";
import { Code } from "./Code";
import { FileLink } from "./FileLink";

const ADV_LABELS: [keyof NonNullable<Question["advanced"]>, string][] = [
  ["architecture_tradeoffs", "Architecture trade-offs"], ["failure_scenarios", "Failure scenarios"],
  ["alternatives", "Alternatives"], ["scale_10x_100x", "At 10x / 100x scale"],
  ["production_improvements", "Production improvements"],
];

export function QuestionHeader({ q }: { q: Question }) {
  const p = bySlug(q.project_slug);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="font-mono text-slate-500">{q.id}</span>
      <Badge tone={q.difficulty}>{q.difficulty}</Badge>
      <Badge>{q.category}</Badge>
      <span className="text-slate-500">{p ? p.name : "Cross-project system design"}</span>
    </div>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {children}
    </div>
  );
}

export function ProgressButtons({ id }: { id: string }) {
  const pr = useProgress();
  return (
    <div className="flex gap-2">
      <Button active={pr.isLearned(id)} onClick={() => pr.toggleLearned(id)}>{pr.isLearned(id) ? "Learned" : "Mark learned"}</Button>
      <Button active={pr.isBookmarked(id)} onClick={() => pr.toggleBookmark(id)}>{pr.isBookmarked(id) ? "Bookmarked" : "Bookmark"}</Button>
    </div>
  );
}

// Full answer. `hideAnswer` is used by mock-interview mode until the user reveals it.
export function QuestionView({ q, hideAnswer }: { q: Question; hideAnswer?: boolean }) {
  const [showAll, setShowAll] = useState(true);
  return (
    <article>
      <QuestionHeader q={q} />
      <h2 className="mt-2 text-xl font-semibold leading-snug">{q.question}</h2>
      <div className="mt-3"><ProgressButtons id={q.id} /></div>
      {hideAnswer ? null : (
        <>
          <Block title="Answer (Hinglish)"><Rich text={q.answer_hinglish} /></Block>
          <div className="mt-4">
            <button className="text-sm text-sky-700 hover:underline dark:text-sky-300" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Hide details" : "Show details (why, analogy, internals, code...)"}
            </button>
          </div>
          {showAll && (
            <>
              <Block title="Why it is needed"><Rich text={q.why_needed} /></Block>
              <Block title="Real-world analogy"><Rich text={q.real_world_analogy} /></Block>
              <Block title="How it works internally"><Rich text={q.how_it_works} /></Block>
              <Block title="In this project"><Rich text={q.in_this_project} /></Block>
              {q.implementation_files.length > 0 && (
                <Block title="Implementation files">
                  <ul className="space-y-1">{q.implementation_files.map((f) => <li key={f}><FileLink ref_={f} /></li>)}</ul>
                </Block>
              )}
              {q.code_example && <Block title="Code"><Code code={q.code_example} lang={q.code_language} /></Block>}
              <div className="grid gap-x-8 md:grid-cols-2">
                {q.advantages.length > 0 && <Block title="Advantages"><Bullets items={q.advantages} /></Block>}
                {q.disadvantages.length > 0 && <Block title="Disadvantages"><Bullets items={q.disadvantages} /></Block>}
              </div>
              {q.common_mistakes.length > 0 && <Block title="Common mistakes"><Bullets items={q.common_mistakes} /></Block>}
              {q.advanced && (
                <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">Advanced discussion</h3>
                  {ADV_LABELS.map(([k, label]) => q.advanced?.[k] ? (
                    <div key={k} className="mt-3"><div className="font-medium">{label}</div><Rich text={q.advanced[k]} className="text-sm" /></div>
                  ) : null)}
                </div>
              )}
              <Block title="Likely follow-up questions"><Bullets items={q.follow_up_questions} /></Block>
              <div className="mt-4 flex flex-wrap gap-1">{q.concepts.map((c) => <Badge key={c}>#{c}</Badge>)}</div>
            </>
          )}
        </>
      )}
    </article>
  );
}
