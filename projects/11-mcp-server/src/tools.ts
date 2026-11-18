// The five tools. Each returns plain text: LLMs read text best, and it keeps the server free of output schemas.
// Descriptions matter as much as code here -- the model decides WHEN to call a tool from its description alone.

import type { Bank, Question } from "./data.js";
import type { ToolDef } from "./protocol.js";
import { ToolError, type ObjectSchema, type PropSchema } from "./schema.js";

// Fixed by interview/SCHEMA.md and enforced by interview/validate.py.
export const DIFFICULTIES = ["Beginner", "Intermediate", "Advanced", "Senior/System Design"] as const;
export const CATEGORIES = [
  "Fundamentals", "Core Concepts", "Internal Implementation", "Architecture & System Design", "Database Design",
  "Concurrency & Distributed Systems", "Performance & Scalability", "Security", "Failure Scenarios",
  "Debugging & Troubleshooting", "Trade-offs & Design Decisions", "Production Scenarios", "Code-Level", "Advanced",
  "Coding Exercises",
] as const;
export const PITCH_SECTIONS = [
  "intro_30s", "explain_2min", "deep_5min", "architecture_walkthrough", "difficult_decisions",
  "biggest_challenges", "failure_scenarios", "improvements",
] as const;

const MAX_TEXT = 60_000; // hard cap on one tool result, so a single call can never flood the model's context

const projectProp: PropSchema = {
  type: "string",
  maxLength: 80,
  description: 'Project filter: full slug ("p09-payments") or a unique part of it/its name ("payments", "p09"). See list_projects.',
};
const difficultyProp: PropSchema = { type: "string", enum: DIFFICULTIES, description: "Difficulty filter." };
const categoryProp: PropSchema = { type: "string", enum: CATEGORIES, description: "Category filter." };

const clip = (s: string): string => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + "\n[truncated]" : s);
const line = (q: Question): string => `${q.id}  [${q.difficulty} | ${q.category}]  ${q.question}`;

function section(title: string, body: string | string[]): string {
  const text = Array.isArray(body) ? body.map((b) => `- ${b}`).join("\n") : body;
  return text.trim() ? `## ${title}\n${text.trim()}` : "";
}

export function renderQuestion(q: Question): string {
  const parts = [
    `# ${q.id}: ${q.question}`,
    `Project: ${q.project_slug} | ${q.difficulty} | ${q.category}`,
    section("Answer (Hinglish)", q.answer_hinglish),
    section("Why it is needed", q.why_needed),
    section("Real-world analogy", q.real_world_analogy),
    section("How it works", q.how_it_works),
    section("In this project", q.in_this_project),
    section("Implementation files", q.implementation_files),
    q.code_example ? `## Code (${q.code_language || "text"})\n\`\`\`${q.code_language}\n${q.code_example}\n\`\`\`` : "",
    section("Advantages", q.advantages),
    section("Disadvantages", q.disadvantages),
    section("Common mistakes", q.common_mistakes),
    ...Object.entries(q.advanced ?? {}).map(([k, v]) => section(`Advanced: ${k.replace(/_/g, " ")}`, v)),
    section("Follow-up questions", q.follow_up_questions),
    section("Concepts", q.concepts.join(", ")),
  ];
  return parts.filter(Boolean).join("\n\n");
}

export function buildTools(bank: Bank, rng: () => number = Math.random): ToolDef[] {
  const filters = (a: Record<string, unknown>) => ({
    project: typeof a.project === "string" ? bank.resolveProject(a.project).slug : undefined,
    category: a.category as string | undefined,
    difficulty: a.difficulty as string | undefined,
  });
  const schema = (properties: ObjectSchema["properties"], required?: string[]): ObjectSchema => ({
    type: "object",
    properties,
    ...(required ? { required } : {}),
    additionalProperties: false,
  });

  return [
    {
      name: "list_projects",
      description:
        "List every interview project bank (slug, name, question count, difficulty split). Call this first to learn the valid project slugs.",
      inputSchema: schema({}),
      handler: () => {
        const rows = [...bank.projects.values()].map((p) => {
          const by = (d: string) => p.questions.filter((q) => q.difficulty === d).length;
          const split = DIFFICULTIES.map((d) => `${d}: ${by(d)}`).join(", ");
          return `${p.slug} -- ${p.name} -- ${p.questions.length} questions (${split})\n    ${p.summary.slice(0, 220)}`;
        });
        return `${bank.projects.size} projects, ${bank.questionCount} questions\n\n${rows.join("\n")}`;
      },
    },
    {
      name: "search_questions",
      description:
        "Keyword search over interview questions (title, concept tags, category, answer text). Returns ids and titles; use get_question for the full answer.",
      inputSchema: schema(
        {
          query: { type: "string", maxLength: 200, description: 'Words to look for, e.g. "idempotency retry" or an exact id like "PAYS-001".' },
          project: projectProp,
          category: categoryProp,
          difficulty: difficultyProp,
          limit: { type: "integer", minimum: 1, maximum: 25, default: 10, description: "Max results (default 10)." },
        },
        ["query"],
      ),
      handler: (a) => {
        const hits = bank.search(a.query as string, filters(a), a.limit as number);
        if (hits.length === 0) return "No questions matched. Try fewer or different words, or remove filters.";
        return clip(`${hits.length} result(s):\n${hits.map(line).join("\n")}`);
      },
    },
    {
      name: "get_question",
      description: "Get one question in full: Hinglish answer, analogy, internals, how this repo implements it, code, pitfalls, follow-ups.",
      inputSchema: schema({ id: { type: "string", maxLength: 40, description: 'Question id, e.g. "PAYS-001".' } }, ["id"]),
      handler: (a) => {
        const q = bank.byId.get((a.id as string).trim().toUpperCase());
        if (!q) throw new ToolError(`no question with id "${a.id}". Use search_questions to find ids.`);
        return clip(renderQuestion(q));
      },
    },
    {
      name: "random_questions",
      description:
        "Pick random questions for a quiz or mock interview. Returns ONLY the questions (no answers) so the user can try first; reveal answers with get_question.",
      inputSchema: schema({
        project: projectProp,
        category: categoryProp,
        difficulty: difficultyProp,
        count: { type: "integer", minimum: 1, maximum: 10, default: 3, description: "How many questions (default 3)." },
      }),
      handler: (a) => {
        const picks = bank.random(filters(a), a.count as number, rng);
        if (picks.length === 0) return "No questions match those filters.";
        return picks.map((q, i) => `${i + 1}. ${line(q)}`).join("\n");
      },
    },
    {
      name: "get_pitch",
      description:
        'Get a project\'s "explain this project in an interview" material: 30-second intro, 2-minute and 5-minute explanations, architecture walkthrough, hard decisions, challenges, failure scenarios, improvements.',
      inputSchema: schema(
        {
          project: { ...projectProp, description: projectProp.description },
          section: {
            type: "string",
            enum: [...PITCH_SECTIONS, "all"],
            default: "intro_30s",
            description: 'Which part of the pitch; "all" returns everything (long).',
          },
        },
        ["project"],
      ),
      handler: (a) => {
        const p = bank.resolveProject(a.project as string);
        const wanted = a.section === "all" ? PITCH_SECTIONS : [a.section as string];
        const parts = wanted.map((s) => {
          const body = p.pitch[s];
          return body === undefined ? "" : section(s, body);
        });
        const text = parts.filter(Boolean).join("\n\n");
        if (!text) throw new ToolError(`project ${p.slug} has no pitch section "${a.section}"`);
        return clip(`# ${p.name} (${p.slug})\n\n${text}`);
      },
    },
  ];
}
