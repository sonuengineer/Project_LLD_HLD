# Brief for writing a project's interview question bank

You are writing interview preparation content for ONE project of a backend engineering portfolio.
The owner is an experienced full-stack developer preparing for backend / distributed systems
interviews. He wants to deeply understand THIS code so he can explain it confidently.

## Inputs (read these first, fully)

1. `interview/SCHEMA.md` -- the exact JSON format. Follow it precisely.
2. The project's source directory (given in your task): every `.py`, `.lua`, `.json`, `.sql` file,
   the tests, and all its `*.md` docs (README, ARCHITECTURE, TRADEOFFS, FAILURE_SCENARIOS, SECURITY,
   TESTING, LEARNING_GUIDE ...). TESTING.md contains the REAL measured results; never invent others.
3. `shared/bpcommon/` -- shared logging / errors / metrics used by every project.

## Output

Directory `interview/data/<project-slug>/`:
- `meta.json` (pitch + learning_path, see SCHEMA.md)
- `questions-01.json` ... `questions-05.json` -- JSON arrays, ~20-25 questions each, **at least 100
  questions in total** (aim 105 so a few rejects don't drop you under 100).

Write one file at a time, then run `python interview/validate.py --only <project-slug>` and fix all
errors before moving on. You are done ONLY when the validator prints `[OK]` for the project.

## Distribution

- All 15 categories must appear. Roughly 6-8 per category; more for Core Concepts, Internal
  Implementation, Concurrency & Distributed Systems, Failure Scenarios, Trade-offs.
- Difficulty mix about: Beginner 20%, Intermediate 35%, Advanced 30%, Senior/System Design 15%.
- `Coding Exercises`: a realistic task based on this code (e.g. "add X to script Y", "write a test
  proving Z"); put a working solution in `code_example`.
- `Debugging & Troubleshooting`: symptom -> how to investigate (which metric/log/command) -> cause -> fix.
  Use the real bugs documented in TESTING.md where they exist.
- IDs: the project's prefix (given in your task) + zero-padded number, e.g. `RATE-001`.

## Language: natural Hinglish

Hindi sentence structure in Latin script with English technical terms, like a senior colleague
explaining over chai. NOT textbook English, NOT Devanagari. Example tone:

> "Suppose hamara application 3 servers par run ho raha hai. Agar hum counter har server ki local
> memory mein rakhenge, toh Server 1 ko user ki 10 requests dikhengi aur Server 2 ko alag se 10.
> Matlab user limit se zyada requests bhej sakta hai. Isliye hum Redis use karte hain..."

`question` stays in English (that is how interviewers ask). Everything else is Hinglish, except code.

## Quality bar (each question)

- `answer_hinglish`: 120-300 words. Direct answer first, then reasoning. This is what he would SAY
  in the interview.
- `in_this_project`: concrete -- name the file, function, Lua line logic, config value, test name.
  Example: "`token_bucket.lua` mein refill `elapsed * rate / 1000` se lazily calculate hota hai..."
- `implementation_files`: repo-relative paths that EXIST, optionally `path::symbol` where the symbol
  literally appears in the file (validator checks this). Never invent paths or symbols. Do not
  reference files that are not in the repo.
- `code_example`: real snippet from the repo (trimmed) or a small illustrative one; mark which.
  Empty string is fine when code adds nothing.
- `follow_up_questions`: 2-4 things the interviewer would plausibly ask next.
- Advanced / Senior questions must fill `advanced` (trade-offs, failure scenarios, alternatives,
  what changes at 10x/100x, production improvements).
- Be honest about limitations the docs list. Never claim a feature exists that the code lacks;
  if a question is about something NOT implemented (e.g. Redis Cluster), say clearly
  "is project mein yeh implement nahi hai; production mein aise karte..." .
- Numbers: only the ones in TESTING.md (and say which machine/conditions), or clearly generic
  ballpark figures labelled as such ("typically", "order of magnitude").
- No duplicates: each question must teach something distinct.

## Formatting rules

- Plain ASCII only. No smart quotes, em/en dashes, ellipsis char, arrows, checkmarks.
  Use `--`, `->`, `"`, `'`. The validator rejects non-ASCII.
- Valid JSON (escape newlines inside strings as `\n`, escape double quotes).
- Use `\n\n` to separate paragraphs inside long strings.

## meta.json pitch

All Hinglish, first person ("Maine ek distributed rate limiter banaya..."):
- `intro_30s` (~70 words), `explain_2min` (~280 words), `deep_5min` (~650 words, walk through the
  request lifecycle and the hardest decisions), `architecture_walkthrough` (component by component),
  `difficult_decisions` (4-6 items), `biggest_challenges` (3-5, include real bugs from TESTING.md),
  `failure_scenarios` (4-6), `improvements` (4-6, honest next steps).
- `learning_path`: 6-10 concepts, each with numbered steps following: explain concept -> why this
  project needs it -> show the API/code -> show implementation detail -> demonstrate with a specific
  test or command -> what the interviewer asks next. `files` must exist.

When finished, report: number of questions, distribution by category and difficulty, and the final
validator output line. Do not modify any file outside `interview/data/<project-slug>/`.
