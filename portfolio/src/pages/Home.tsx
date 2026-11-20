import { loadIndex, useAsync } from "../lib/data";
import { href } from "../lib/router";
import { PROJECTS } from "../lib/projects";
import { Badge, Card, Section } from "../components/ui";

const SKILLS = [
  ["Distributed systems", "Leases and fencing tokens, replication with ISR and high watermarks, ordered fan-out, at-least-once delivery with idempotent consumers, sagas and durable workflows."],
  ["Data & storage", "Postgres (RLS, SKIP LOCKED, deferred constraint triggers, row locks), Redis Lua scripting, a segmented commit log, AOF / snapshot persistence, streaming object storage."],
  ["Reliability", "Crash tests (real kill -9), fault injection with a mock payment provider, recovery workers, reconciliation, documented failure scenarios for every project."],
  ["Performance work", "Every benchmark on the project pages came from a measure -> hypothesis -> experiment -> fix loop; rejected hypotheses are documented in each TESTING.md (project 11: in its README)."],
];

export default function Home() {
  const { data: index } = useAsync(loadIndex, []);
  const count = (slug: string) => index?.find((e) => e.slug === slug)?.stats.questions;
  const total = index?.reduce((n, e) => n + e.stats.questions, 0);
  return (
    <div>
      <section className="py-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Eleven backend systems, built from first principles</h1>
        <p className="mt-4 max-w-3xl text-lg text-slate-600 dark:text-slate-400">
          Rate limiting, a Redis-compatible database, job queues, webhooks, a Kafka-style log, multi-tenant SaaS,
          object storage, real-time collaboration, payments, a durable workflow engine and a reverse proxy with a load
          balancer. The first ten are Python 3.12, FastAPI, Postgres and Redis, each with tests, Docker Compose,
          measured benchmarks and twelve design documents. The eleventh is TypeScript on Node with no runtime
          dependencies, with tests and results measured on a real server.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href={href("/interview")} className="rounded-md bg-sky-600 px-4 py-2 text-white hover:bg-sky-700">Interview prep{total ? ` (${total} questions)` : ""}</a>
          <a href="#projects" className="rounded-md border border-slate-300 px-4 py-2 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-900">See the projects</a>
        </div>
      </section>

      <Section title="What these projects demonstrate">
        <div className="grid gap-4 md:grid-cols-2">
          {SKILLS.map(([t, d]) => <Card key={t}><div className="font-semibold">{t}</div><p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{d}</p></Card>)}
        </div>
      </Section>

      <Section title="Projects" id="projects">
        <div className="grid gap-4 md:grid-cols-2">
          {PROJECTS.map((p) => (
            <a key={p.slug} href={href("/project/" + p.slug)} className="group block">
              <Card className="h-full transition group-hover:border-sky-400 dark:group-hover:border-sky-700">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-sm text-slate-400">{String(p.num).padStart(2, "0")}</span>
                  <h3 className="text-lg font-semibold group-hover:text-sky-700 dark:group-hover:text-sky-300">{p.name}</h3>
                </div>
                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">{p.tagline}</p>
                <div className="mt-3 flex flex-wrap gap-1">{p.stack.map((s) => <Badge key={s}>{s}</Badge>)}</div>
                <div className="mt-3 text-xs text-slate-500">Tests: {p.tests}{count(p.slug) ? ` | ${count(p.slug)} interview questions` : ""}</div>
              </Card>
            </a>
          ))}
        </div>
      </Section>

      <Section title="How to run">
        <Card>
          <p className="text-sm text-slate-600 dark:text-slate-400">Nothing here is deployed publicly. Everything runs on one machine:</p>
          <pre className="mt-3 overflow-x-auto rounded-lg bg-[#0d1117] p-4 text-[13px] text-slate-200">{`docker compose -f infra/docker-compose.yml up -d     # shared Postgres + Redis
cd projects/01-rate-limiter && ../../.venv/Scripts/python -m pytest -q
docker compose up -d --build                          # per-project stack
cd portfolio && npm install && npm run data && npm run dev`}</pre>
        </Card>
      </Section>
    </div>
  );
}
