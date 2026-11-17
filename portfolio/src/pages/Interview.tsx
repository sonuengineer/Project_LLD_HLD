import { useEffect, useMemo, useState } from "react";
import { allQuestions, loadAll, useAsync } from "../lib/data";
import { href, navigate } from "../lib/router";
import { useProgress } from "../lib/progress";
import { PROJECTS } from "../lib/projects";
import { CATEGORIES, DIFFICULTIES, type Question } from "../lib/types";
import { Badge, Button, Card, Loading } from "../components/ui";
import { QuestionHeader, QuestionView } from "../components/QuestionView";

type Status = "" | "learned" | "unlearned" | "bookmarked";
interface Filters { project: string; category: string; difficulty: string; status: Status; search: string }

const MODES = [
  ["browse", "Browse"], ["random", "Random"], ["mock", "Mock interview"], ["revision", "Revision"],
] as const;

function readFilters(p: URLSearchParams): Filters {
  return { project: p.get("project") || "", category: p.get("category") || "", difficulty: p.get("difficulty") || "",
    status: (p.get("status") || "") as Status, search: p.get("search") || "" };
}

export function applyFilters(qs: Question[], f: Filters, pr: ReturnType<typeof useProgress>): Question[] {
  const words = f.search.toLowerCase().split(/\s+/).filter(Boolean);
  return qs.filter((q) => {
    if (f.project && q.project_slug !== f.project) return false;
    if (f.category && q.category !== f.category) return false;
    if (f.difficulty && q.difficulty !== f.difficulty) return false;
    if (f.status === "learned" && !pr.isLearned(q.id)) return false;
    if (f.status === "unlearned" && pr.isLearned(q.id)) return false;
    if (f.status === "bookmarked" && !pr.isBookmarked(q.id)) return false;
    if (words.length) {
      const hay = (q.id + " " + q.question + " " + q.concepts.join(" ") + " " + q.answer_hinglish + " " +
        q.implementation_files.join(" ")).toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

const Select = ({ value, onChange, children, label }: { value: string; onChange: (v: string) => void; children: React.ReactNode; label: string }) => (
  <label className="block text-xs text-slate-500">{label}
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
      {children}
    </select>
  </label>
);

function FilterBar({ f, set, includeCross }: { f: Filters; set: (k: keyof Filters, v: string) => void; includeCross: boolean }) {
  const [search, setSearch] = useState(f.search);
  useEffect(() => setSearch(f.search), [f.search]);
  useEffect(() => {
    const t = setTimeout(() => search !== f.search && set("search", search), 250);
    return () => clearTimeout(t);
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
      <label className="block text-xs text-slate-500 sm:col-span-2 lg:col-span-1">Search
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="e.g. fencing lease, RLS, CRC"
          className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" />
      </label>
      <Select label="Project" value={f.project} onChange={(v) => set("project", v)}>
        <option value="">All projects</option>
        {PROJECTS.map((p) => <option key={p.slug} value={p.slug}>{p.num}. {p.name}</option>)}
        {includeCross && <option value="cross-project">Cross-project system design</option>}
      </Select>
      <Select label="Category" value={f.category} onChange={(v) => set("category", v)}>
        <option value="">All categories</option>
        {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
      </Select>
      <Select label="Difficulty" value={f.difficulty} onChange={(v) => set("difficulty", v)}>
        <option value="">All levels</option>
        {DIFFICULTIES.map((d) => <option key={d}>{d}</option>)}
      </Select>
      <Select label="Status" value={f.status} onChange={(v) => set("status", v)}>
        <option value="">Any</option>
        <option value="unlearned">Not learned</option>
        <option value="learned">Learned</option>
        <option value="bookmarked">Bookmarked</option>
      </Select>
    </div>
  );
}

function QuestionRow({ q, link }: { q: Question; link: string }) {
  const pr = useProgress();
  return (
    <a href={link} className="block rounded-lg border border-slate-200 bg-white px-4 py-3 hover:border-sky-400 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-sky-700">
      <QuestionHeader q={q} />
      <div className="mt-1 flex items-start gap-2">
        <span className="flex-1 font-medium">{q.question}</span>
        {pr.isLearned(q.id) && <Badge tone="Beginner">learned</Badge>}
        {pr.isBookmarked(q.id) && <Badge tone="Advanced">bookmark</Badge>}
      </div>
    </a>
  );
}

const PAGE = 50;

function Browse({ list, params }: { list: Question[]; params: URLSearchParams }) {
  const [limit, setLimit] = useState(PAGE);
  useEffect(() => setLimit(PAGE), [list]);
  const linkTo = (id: string) => href("/interview", { ...Object.fromEntries(params), q: id });
  return (
    <div className="space-y-2">
      {list.slice(0, limit).map((q) => <QuestionRow key={q.id} q={q} link={linkTo(q.id)} />)}
      {list.length > limit && <Button onClick={() => setLimit(limit + PAGE)}>Show more ({list.length - limit} left)</Button>}
      {!list.length && <p className="text-slate-500">No questions match these filters.</p>}
    </div>
  );
}

function Detail({ list, id, params }: { list: Question[]; id: string; params: URLSearchParams }) {
  const all = Object.fromEntries(params);
  const i = list.findIndex((q) => q.id === id);
  const q = i >= 0 ? list[i] : undefined;
  const go = (qid?: string) => navigate("/interview", { ...all, q: qid });
  if (!q) return <p>Question {id} is not in the current filter. <a className="text-sky-600" href={href("/interview", { ...all, q: undefined })}>Back to list</a></p>;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <a className="text-sky-700 hover:underline dark:text-sky-300" href={href("/interview", { ...all, q: undefined })}>&lt;- Back to list</a>
        <span className="text-slate-500">{i + 1} / {list.length}</span>
        <Button onClick={() => go(list[i - 1]?.id)} className={i <= 0 ? "pointer-events-none opacity-40" : ""}>Previous</Button>
        <Button onClick={() => go(list[i + 1]?.id)} className={i >= list.length - 1 ? "pointer-events-none opacity-40" : ""}>Next</Button>
      </div>
      <Card><QuestionView key={q.id} q={q} /></Card>
    </div>
  );
}

function RandomMode({ list }: { list: Question[] }) {
  const [id, setId] = useState<string>();
  const pick = () => list.length && setId(list[Math.floor(Math.random() * list.length)].id);
  useEffect(() => { pick(); }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = list.find((x) => x.id === id);
  if (!list.length) return <p className="text-slate-500">No questions match these filters.</p>;
  return (
    <div>
      <div className="mb-4 flex items-center gap-3"><Button onClick={pick} active>Next random question</Button>
        <span className="text-sm text-slate-500">picking from {list.length} questions</span></div>
      {q && <Card><QuestionView key={q.id} q={q} /></Card>}
    </div>
  );
}

function shuffle<T>(a: T[]): T[] {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

// Mock interview: N random questions, answer hidden; speak your answer, reveal, then grade yourself.
// "Got it" marks the question learned, "Needs work" bookmarks it for revision.
function MockMode({ list }: { list: Question[] }) {
  const pr = useProgress();
  const [size, setSize] = useState(5);
  const [minutes, setMinutes] = useState(3);
  const [set, setSet] = useState<Question[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grades, setGrades] = useState<Record<string, "ok" | "work">>({});
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!set || revealed || idx >= set.length) return;
    setLeft(minutes * 60);
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [set, idx, revealed, minutes]);

  if (!set) {
    return (
      <Card>
        <h3 className="text-lg font-semibold">Mock interview</h3>
        <p className="mt-1 text-sm text-slate-500">Questions are drawn from the current filters ({list.length} available).
          Answer out loud before you reveal. Grading yourself updates your progress.</p>
        <div className="mt-4 flex flex-wrap items-end gap-4">
          <Select label="Questions" value={String(size)} onChange={(v) => setSize(Number(v))}>
            {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <Select label="Minutes per question" value={String(minutes)} onChange={(v) => setMinutes(Number(v))}>
            {[2, 3, 5, 8].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
          <Button active onClick={() => { setSet(shuffle(list).slice(0, size)); setIdx(0); setGrades({}); setRevealed(false); }}
            className={list.length ? "" : "pointer-events-none opacity-40"}>Start</Button>
        </div>
      </Card>
    );
  }
  if (idx >= set.length) {
    const ok = set.filter((q) => grades[q.id] === "ok").length;
    return (
      <Card>
        <h3 className="text-lg font-semibold">Result: {ok} / {set.length} answered confidently</h3>
        <ul className="mt-4 space-y-2">
          {set.map((q) => (
            <li key={q.id} className="flex items-start gap-2">
              <Badge tone={grades[q.id] === "ok" ? "Beginner" : "Senior/System Design"}>{grades[q.id] === "ok" ? "got it" : "needs work"}</Badge>
              <a className="hover:underline" href={href("/interview", { q: q.id })}>{q.question}</a>
            </li>
          ))}
        </ul>
        <div className="mt-4"><Button active onClick={() => setSet(null)}>New mock interview</Button></div>
      </Card>
    );
  }
  const q = set[idx];
  const grade = (g: "ok" | "work") => {
    setGrades({ ...grades, [q.id]: g });
    if (g === "ok") pr.toggleLearned(q.id, true); else pr.toggleBookmark(q.id, true);
    setIdx(idx + 1);
    setRevealed(false);
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
        <span>Question {idx + 1} / {set.length}</span>
        {!revealed && <span className={"font-mono " + (left === 0 ? "text-rose-600" : "text-slate-500")}>
          {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} {left === 0 ? "time is up" : ""}</span>}
        <Button onClick={() => setSet(null)}>Quit</Button>
      </div>
      <Card>
        <QuestionView key={q.id} q={q} hideAnswer={!revealed} />
        <div className="mt-6 flex flex-wrap gap-2 border-t border-slate-200 pt-4 dark:border-slate-800">
          {!revealed
            ? <Button active onClick={() => setRevealed(true)}>Reveal answer</Button>
            : <><Button active onClick={() => grade("ok")}>Got it</Button><Button onClick={() => grade("work")}>Needs work</Button></>}
        </div>
      </Card>
    </div>
  );
}

// Revision: bookmarked questions you have not marked learned yet, oldest bookmark first.
function RevisionMode({ list, params }: { list: Question[]; params: URLSearchParams }) {
  const pr = useProgress();
  const due = list.filter((q) => pr.isBookmarked(q.id) && !pr.isLearned(q.id))
    .sort((a, b) => pr.bookmarked[a.id] - pr.bookmarked[b.id]);
  return (
    <div>
      <p className="mb-4 text-sm text-slate-500">
        {due.length} bookmarked question(s) not yet learned. Bookmark questions while browsing (or grade "Needs work" in a mock
        interview); mark them learned here once you can explain them without looking.
      </p>
      <Browse list={due} params={params} />
    </div>
  );
}

export default function Interview({ params }: { params: URLSearchParams }) {
  const { data, error } = useAsync(loadAll, []);
  const pr = useProgress();
  const f = readFilters(params);
  const mode = params.get("mode") || "browse";
  const qid = params.get("q");
  const all = useMemo(() => (data ? allQuestions(data) : []), [data]);
  const list = useMemo(() => applyFilters(all, f, pr), [all, f.project, f.category, f.difficulty, f.status, f.search, pr.learned, pr.bookmarked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <Loading error={error} />;
  const set = (k: keyof Filters, v: string) => navigate("/interview", { ...Object.fromEntries(params), [k]: v, q: undefined });

  return (
    <div>
      <h1 className="text-2xl font-bold">Interview preparation</h1>
      <p className="mt-1 text-sm text-slate-500">{all.length} questions across {Object.keys(data).length} banks, every
        answer tied to real files in this repo. Progress is stored in this browser only.</p>
      <div className="mt-5 flex flex-wrap gap-2">
        {MODES.map(([m, label]) => (
          <a key={m} href={href("/interview", { ...Object.fromEntries(params), mode: m, q: undefined })}
            className={"rounded-md border px-3 py-1.5 text-sm " + (mode === m ? "border-sky-600 bg-sky-600 text-white" : "border-slate-300 dark:border-slate-700")}>{label}</a>
        ))}
      </div>
      <div className="mt-5"><FilterBar f={f} set={set} includeCross /></div>
      <div className="mt-2 text-xs text-slate-500">{list.length} matching</div>
      <div className="mt-5">
        {qid ? <Detail list={list} id={qid} params={params} />
          : mode === "random" ? <RandomMode list={list} />
          : mode === "mock" ? <MockMode list={list} />
          : mode === "revision" ? <RevisionMode list={list} params={params} />
          : <Browse list={list} params={params} />}
      </div>
    </div>
  );
}
