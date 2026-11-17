export type Difficulty = "Beginner" | "Intermediate" | "Advanced" | "Senior/System Design";

export interface Advanced {
  architecture_tradeoffs: string;
  failure_scenarios: string;
  alternatives: string;
  scale_10x_100x: string;
  production_improvements: string;
}

export interface Question {
  id: string;
  project_slug: string;
  category: string;
  difficulty: Difficulty;
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
  advanced?: Advanced | null;
}

export interface Pitch {
  intro_30s: string;
  explain_2min: string;
  deep_5min: string;
  architecture_walkthrough: string;
  difficult_decisions: string[];
  biggest_challenges: string[];
  failure_scenarios: string[];
  improvements: string[];
}

export interface Meta {
  project_slug: string;
  project: string;
  source_dir: string;
  summary: string;
  pitch: Pitch;
  learning_path: { concept: string; steps: string[]; files: string[] }[];
}

export interface Stats {
  questions: number;
  categories: Record<string, number>;
  difficulties: Record<string, number>;
}

export interface Bank {
  meta: Meta;
  questions: Question[];
  stats: Stats;
}

export interface IndexEntry {
  slug: string;
  project: string;
  summary: string;
  stats: Stats;
}

export const CATEGORIES = [
  "Fundamentals", "Core Concepts", "Internal Implementation", "Architecture & System Design",
  "Database Design", "Concurrency & Distributed Systems", "Performance & Scalability", "Security",
  "Failure Scenarios", "Debugging & Troubleshooting", "Trade-offs & Design Decisions",
  "Production Scenarios", "Code-Level", "Advanced", "Coding Exercises",
];
export const DIFFICULTIES: Difficulty[] = ["Beginner", "Intermediate", "Advanced", "Senior/System Design"];
