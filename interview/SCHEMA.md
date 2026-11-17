# Interview data format

One directory per project: `interview/data/<project-slug>/`

- `meta.json` -- project info and the "Explain This Project in an Interview" pitch.
- `questions-*.json` -- one or more files, each a JSON array of question objects. Split into several
  files only to keep files reviewable (e.g. `questions-01.json` ... `questions-04.json`).

Cross-project system design questions live in `interview/data/cross-project/` with the same format
(`project_slug` = `cross-project`).

## meta.json

```json
{
  "project_slug": "p01-rate-limiter",
  "project": "Distributed Rate Limiter",
  "source_dir": "projects/01-rate-limiter",
  "summary": "one paragraph",
  "pitch": {
    "intro_30s": "Hinglish",
    "explain_2min": "Hinglish",
    "deep_5min": "Hinglish",
    "architecture_walkthrough": "Hinglish",
    "difficult_decisions": ["Hinglish", "..."],
    "biggest_challenges": ["Hinglish", "..."],
    "failure_scenarios": ["Hinglish", "..."],
    "improvements": ["Hinglish", "..."]
  },
  "learning_path": [
    {"concept": "Atomicity", "steps": ["1. ...", "2. ..."], "files": ["projects/01-rate-limiter/..."]}
  ]
}
```

## Question object

| Field | Type | Rule |
|---|---|---|
| `id` | string | `<PREFIX>-NNN`, unique across all data (e.g. `RATE-001`) |
| `project_slug` | string | matches directory |
| `category` | string | one of the 15 categories below |
| `difficulty` | string | `Beginner` / `Intermediate` / `Advanced` / `Senior/System Design` |
| `question` | string | English |
| `answer_hinglish` | string | main answer, Hinglish, >= 400 chars |
| `why_needed` | string | Hinglish |
| `real_world_analogy` | string | Hinglish |
| `how_it_works` | string | Hinglish, internals |
| `in_this_project` | string | Hinglish, how THIS repo does it |
| `implementation_files` | string[] | repo-relative paths; optional `::symbol` suffix that must appear in the file |
| `code_example` | string | may be `""` when not useful; language-tagged with `code_language` |
| `code_language` | string | `python`, `lua`, `bash`, `sql`, `typescript`, `json`, `text`, ... |
| `advantages` | string[] | |
| `disadvantages` | string[] | |
| `common_mistakes` | string[] | |
| `follow_up_questions` | string[] | >= 2 |
| `concepts` | string[] | tags |
| `advanced` | object or null | REQUIRED for `Advanced` and `Senior/System Design`: `{architecture_tradeoffs, failure_scenarios, alternatives, scale_10x_100x, production_improvements}` (all Hinglish strings) |

Categories: `Fundamentals`, `Core Concepts`, `Internal Implementation`, `Architecture & System Design`,
`Database Design`, `Concurrency & Distributed Systems`, `Performance & Scalability`, `Security`,
`Failure Scenarios`, `Debugging & Troubleshooting`, `Trade-offs & Design Decisions`,
`Production Scenarios`, `Code-Level`, `Advanced`, `Coding Exercises`.

All text must be plain ASCII (no smart quotes, em dashes, arrows): the owner's terminal renders
non-ASCII as mojibake. Validate with `python interview/validate.py`.
