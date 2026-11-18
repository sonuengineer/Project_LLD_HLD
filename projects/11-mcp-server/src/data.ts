// Read-only access to interview/data/<project>/{meta.json,questions-*.json}.
// Everything is loaded once at startup (about a thousand small records) -- no database, no writes, no network.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolError } from "./schema.js";

export interface Question {
  id: string;
  project_slug: string;
  category: string;
  difficulty: string;
  question: string;
  answer_hinglish: string;
  why_needed: string;
  real_world_analogy: string;
  how_it_works: string;
  in_this_project: string;
  implementation_files: string[];
  code_example: string;
  code_language: string;
  advantages: string[];
  disadvantages: string[];
  common_mistakes: string[];
  follow_up_questions: string[];
  concepts: string[];
  advanced: Record<string, string> | null;
}

export interface Project {
  slug: string;
  name: string;
  summary: string;
  pitch: Record<string, string | string[]>;
  questions: Question[];
}

export interface Filter {
  project?: string; // already resolved to a slug
  category?: string;
  difficulty?: string;
}

/** interview/data relative to this file: src/ (or dist/) -> 11-mcp-server -> projects -> repo root. */
export function defaultDataDir(): string {
  return fileURLToPath(new URL("../../../interview/data", import.meta.url));
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function toQuestion(v: unknown, where: string): Question {
  if (typeof v !== "object" || v === null) throw new Error(`${where}: not an object`);
  const o = v as Record<string, unknown>;
  if (!str(o.id) || !str(o.question)) throw new Error(`${where}: missing id or question`);
  const adv = o.advanced;
  return {
    id: str(o.id),
    project_slug: str(o.project_slug),
    category: str(o.category),
    difficulty: str(o.difficulty),
    question: str(o.question),
    answer_hinglish: str(o.answer_hinglish),
    why_needed: str(o.why_needed),
    real_world_analogy: str(o.real_world_analogy),
    how_it_works: str(o.how_it_works),
    in_this_project: str(o.in_this_project),
    implementation_files: strArr(o.implementation_files),
    code_example: str(o.code_example),
    code_language: str(o.code_language),
    advantages: strArr(o.advantages),
    disadvantages: strArr(o.disadvantages),
    common_mistakes: strArr(o.common_mistakes),
    follow_up_questions: strArr(o.follow_up_questions),
    concepts: strArr(o.concepts),
    advanced:
      typeof adv === "object" && adv !== null
        ? Object.fromEntries(Object.entries(adv).filter((e): e is [string, string] => typeof e[1] === "string"))
        : null,
  };
}

interface Indexed {
  q: Question;
  question: string;
  concepts: string;
  category: string;
  body: string;
}

export class Bank {
  readonly projects = new Map<string, Project>();
  readonly byId = new Map<string, Question>();
  private readonly index: Indexed[] = [];

  static load(dir: string): Bank {
    const bank = new Bank();
    if (!existsSync(dir)) throw new Error(`interview data directory not found: ${dir}`);
    for (const slug of readdirSync(dir).sort()) {
      const projectDir = join(dir, slug);
      if (!statSync(projectDir).isDirectory() || !existsSync(join(projectDir, "meta.json"))) continue;
      bank.addProject(slug, projectDir);
    }
    if (bank.projects.size === 0) throw new Error(`no interview banks found in ${dir}`);
    return bank;
  }

  private addProject(slug: string, projectDir: string): void {
    const meta = readJson(join(projectDir, "meta.json")) as Record<string, unknown>;
    const pitchRaw = (typeof meta.pitch === "object" && meta.pitch !== null ? meta.pitch : {}) as Record<string, unknown>;
    const pitch: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(pitchRaw)) {
      if (typeof v === "string") pitch[k] = v;
      else if (Array.isArray(v)) pitch[k] = strArr(v);
    }

    const project: Project = { slug, name: str(meta.project) || slug, summary: str(meta.summary), pitch, questions: [] };
    const files = readdirSync(projectDir)
      .filter((f) => /^questions-.*\.json$/.test(f))
      .sort();
    for (const file of files) {
      const items = readJson(join(projectDir, file));
      if (!Array.isArray(items)) throw new Error(`${join(projectDir, file)}: expected a JSON array`);
      items.forEach((item, i) => {
        const q = toQuestion(item, `${slug}/${file}[${i}]`);
        if (this.byId.has(q.id)) throw new Error(`duplicate question id ${q.id} (${slug}/${file})`);
        this.byId.set(q.id, q);
        project.questions.push(q);
        this.index.push({
          q,
          question: q.question.toLowerCase(),
          concepts: q.concepts.join(" ").toLowerCase(),
          category: q.category.toLowerCase(),
          body: [q.answer_hinglish, q.how_it_works, q.in_this_project].join(" ").toLowerCase(),
        });
      });
    }
    this.projects.set(slug, project);
  }

  get questionCount(): number {
    return this.byId.size;
  }

  /** "p09", "payments", or the full slug -> the one matching project. Ambiguity is an error, never a guess. */
  resolveProject(ref: string): Project {
    const r = ref.trim().toLowerCase();
    const exact = this.projects.get(r);
    if (exact) return exact;
    const hits = [...this.projects.values()].filter((p) => p.slug.includes(r) || p.name.toLowerCase().includes(r));
    if (r && hits.length === 1) return hits[0]!;
    const known = [...this.projects.keys()].join(", ");
    if (hits.length === 0 || !r) throw new ToolError(`no project matches "${ref}". Known projects: ${known}`);
    throw new ToolError(`"${ref}" matches several projects (${hits.map((h) => h.slug).join(", ")}); be more specific`);
  }

  private matches(item: Indexed, f: Filter): boolean {
    return (
      (!f.project || item.q.project_slug === f.project) &&
      (!f.category || item.q.category === f.category) &&
      (!f.difficulty || item.q.difficulty === f.difficulty)
    );
  }

  /**
   * Keyword search. Scoring is intentionally simple and explainable (no embeddings):
   * a word in the question title weighs most, then concept tags, then category, then the answer body.
   * An exact id (e.g. "PAYS-001") always wins.
   */
  search(query: string, f: Filter, limit: number): Question[] {
    const q = query.trim().toLowerCase();
    const words = [...new Set(q.split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];
    const scored: { item: Indexed; score: number }[] = [];
    for (const item of this.index) {
      if (!this.matches(item, f)) continue;
      let score = item.q.id.toLowerCase() === q ? 1000 : 0;
      for (const w of words) {
        if (item.question.includes(w)) score += 5;
        if (item.concepts.includes(w)) score += 4;
        if (item.category.includes(w)) score += 2;
        if (item.body.includes(w)) score += 1;
      }
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score || a.item.q.id.localeCompare(b.item.q.id));
    return scored.slice(0, limit).map((s) => s.item.q);
  }

  /** Partial Fisher-Yates shuffle over the filtered set. `rng` is injectable so tests are deterministic. */
  random(f: Filter, count: number, rng: () => number): Question[] {
    const pool = this.index.filter((i) => this.matches(i, f)).map((i) => i.q);
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(rng() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, n);
  }
}
