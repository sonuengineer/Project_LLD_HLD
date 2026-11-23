# Portfolio + interview prep site

React 18 + TypeScript + Vite + Tailwind + Recharts. Static site, no backend: all data is JSON generated from
`interview/data/` by the validator.

```bash
cd portfolio
npm install
npm run data      # validates interview/data and writes public/data (+ copies referenced source files)
npm run dev       # http://127.0.0.1:5173
npm run build     # dist/ -- static files, open via any static server (e.g. npm run preview)
```

## Pages

| Route | What |
|---|---|
| `#/` | Portfolio: the 16 projects, what they demonstrate, how to run |
| `#/project/<slug>` | Implemented features, tests, measured benchmarks (from each TESTING.md), design docs, "Explain this project in an interview" (30s / 2min / 5min / architecture / decisions / challenges / failures / improvements), learning path, question stats |
| `#/interview` | All questions: search, filters (project, category, difficulty, learned / bookmarked); modes Browse, Random, Mock interview (timed, hidden answer, self-grading), Revision (bookmarked and not yet learned) |
| `#/system-design` | Cross-project system design questions |
| `#/progress` | Learned / bookmarked per project and difficulty; optional repo path for "open in VS Code" links |
| `#/source?path=...&symbol=...` | Syntax-highlighted source of any file an answer references, scrolled to the symbol |

## Notes

- Progress (learned / bookmarked) is stored in the browser's localStorage only.
- Benchmark charts use only numbers copied from each project's `TESTING.md`; every chart names its source file.
  Test conditions (Docker Desktop on Windows, in-process clusters) are shown next to each chart.
- Nothing is deployed and there is no public repository URL; file links open the copy bundled into the site.
- `src/lib/projects.ts` holds the per-project facts (features, test counts, benchmarks). Update it when a
  project's TESTING.md changes.
