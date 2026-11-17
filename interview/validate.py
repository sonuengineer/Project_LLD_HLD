"""Validate interview data: structure, coverage, ASCII-only, and that every referenced
file (and ::symbol) really exists in the repo. Also emits the bundle used by the website.

    python interview/validate.py                 # validate all, print report
    python interview/validate.py --bundle out/   # also write merged JSON for the portfolio site
    python interview/validate.py --only p01-rate-limiter
    python interview/validate.py --bundle out/ --with-sources   # also copy every referenced repo file
                                                                # into out/src/ for the site's source viewer
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "interview" / "data"

CATEGORIES = [
    "Fundamentals", "Core Concepts", "Internal Implementation", "Architecture & System Design",
    "Database Design", "Concurrency & Distributed Systems", "Performance & Scalability", "Security",
    "Failure Scenarios", "Debugging & Troubleshooting", "Trade-offs & Design Decisions",
    "Production Scenarios", "Code-Level", "Advanced", "Coding Exercises",
]
DIFFICULTIES = ["Beginner", "Intermediate", "Advanced", "Senior/System Design"]
REQUIRED_STR = ["id", "project_slug", "category", "difficulty", "question", "answer_hinglish", "why_needed",
                "real_world_analogy", "how_it_works", "in_this_project", "code_example", "code_language"]
REQUIRED_LIST = ["implementation_files", "advantages", "disadvantages", "common_mistakes",
                 "follow_up_questions", "concepts"]
ADVANCED_KEYS = ["architecture_tradeoffs", "failure_scenarios", "alternatives", "scale_10x_100x",
                 "production_improvements"]
PITCH_KEYS = ["intro_30s", "explain_2min", "deep_5min", "architecture_walkthrough", "difficult_decisions",
              "biggest_challenges", "failure_scenarios", "improvements"]
MIN_QUESTIONS = 100


def non_ascii(obj, path="") -> list[str]:
    out = []
    if isinstance(obj, str):
        bad = sorted({c for c in obj if ord(c) > 127})
        if bad:
            out.append(f"{path}: non-ASCII {''.join(bad)!r}")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            out += non_ascii(v, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out += non_ascii(v, f"{path}[{i}]")
    return out


def check_file_ref(ref: str) -> str | None:
    path, _, symbol = ref.partition("::")
    p = ROOT / path
    if not p.exists():
        return f"missing file {path}"
    if symbol:
        if p.is_dir():
            return f"symbol on directory {ref}"
        text = p.read_text(encoding="utf-8", errors="replace")
        if not re.search(r"\b" + re.escape(symbol.split(".")[-1]) + r"\b", text):
            return f"symbol {symbol!r} not found in {path}"
    return None


def validate_project(d: Path, seen_ids: set[str]) -> tuple[list[str], list[str], dict]:
    errors, warnings = [], []
    meta_path = d / "meta.json"
    meta = {}
    if not meta_path.exists():
        errors.append("meta.json missing")
    else:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        errors += [f"meta {e}" for e in non_ascii(meta)]
        for k in PITCH_KEYS:
            if not meta.get("pitch", {}).get(k):
                errors.append(f"meta.pitch.{k} missing")
        if meta.get("project_slug") != d.name:
            errors.append("meta.project_slug != directory name")
        if not (ROOT / meta.get("source_dir", "__none__")).is_dir():
            errors.append(f"meta.source_dir {meta.get('source_dir')} not found")
        for lp in meta.get("learning_path", []):
            for f in lp.get("files", []):
                if (e := check_file_ref(f)):
                    errors.append(f"meta.learning_path {lp.get('concept')}: {e}")
    questions = []
    for qf in sorted(d.glob("questions-*.json")):
        try:
            arr = json.loads(qf.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{qf.name}: invalid JSON: {exc}")
            continue
        questions += arr
    for q in questions:
        qid = q.get("id", "?")
        for k in REQUIRED_STR:
            if not isinstance(q.get(k), str):
                errors.append(f"{qid}: field {k} must be string")
        for k in REQUIRED_LIST:
            if not isinstance(q.get(k), list):
                errors.append(f"{qid}: field {k} must be list")
        if qid in seen_ids:
            errors.append(f"{qid}: duplicate id")
        seen_ids.add(qid)
        if q.get("project_slug") != d.name:
            errors.append(f"{qid}: project_slug mismatch")
        if q.get("category") not in CATEGORIES:
            errors.append(f"{qid}: bad category {q.get('category')!r}")
        if q.get("difficulty") not in DIFFICULTIES:
            errors.append(f"{qid}: bad difficulty {q.get('difficulty')!r}")
        if len(q.get("answer_hinglish", "")) < 400:
            errors.append(f"{qid}: answer_hinglish too short ({len(q.get('answer_hinglish', ''))} chars)")
        if len(q.get("follow_up_questions", [])) < 2:
            errors.append(f"{qid}: needs >= 2 follow_up_questions")
        if d.name != "cross-project" and not q.get("implementation_files"):
            errors.append(f"{qid}: implementation_files empty")
        for ref in q.get("implementation_files", []):
            if (e := check_file_ref(ref)):
                errors.append(f"{qid}: {e}")
        if q.get("difficulty") in ("Advanced", "Senior/System Design"):
            adv = q.get("advanced") or {}
            for k in ADVANCED_KEYS:
                if not adv.get(k):
                    errors.append(f"{qid}: advanced.{k} missing")
        errors += [f"{qid} {e}" for e in non_ascii(q)]
    cats = Counter(q.get("category") for q in questions)
    diffs = Counter(q.get("difficulty") for q in questions)
    if d.name != "cross-project":
        if len(questions) < MIN_QUESTIONS:
            errors.append(f"only {len(questions)} questions (< {MIN_QUESTIONS})")
        for c in CATEGORIES:
            if not cats.get(c):
                errors.append(f"category {c!r} has no questions")
        for df in DIFFICULTIES:
            if not diffs.get(df):
                errors.append(f"difficulty {df!r} has no questions")
    stats = {"questions": len(questions), "categories": dict(cats), "difficulties": dict(diffs)}
    return errors, warnings, {"meta": meta, "questions": questions, "stats": stats}


MAX_SOURCE_BYTES = 400_000


def copy_sources(bundle: dict, dest: Path) -> list[str]:
    """Copy every file referenced by questions / learning paths (paths are repo-relative and validated)."""
    refs: set[str] = set()
    for data in bundle.values():
        for q in data["questions"]:
            refs.update(r.partition("::")[0] for r in q.get("implementation_files", []))
        for lp in data["meta"].get("learning_path", []):
            refs.update(f.partition("::")[0] for f in lp.get("files", []))
    # plus every project's top-level docs (README, ARCHITECTURE, ... -- linked from the project pages)
    refs.update(str(md.relative_to(ROOT)).replace("\\", "/") for md in (ROOT / "projects").glob("*/*.md"))
    copied = []
    for ref in sorted(refs):
        src = ROOT / ref
        if not src.is_file() or src.stat().st_size > MAX_SOURCE_BYTES:
            continue
        out = dest / ref
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(src.read_bytes())
        copied.append(ref)
    (dest.parent / "sources.json").write_text(json.dumps(copied), encoding="utf-8")
    return copied


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", type=Path)
    ap.add_argument("--only")
    ap.add_argument("--with-sources", action="store_true")
    a = ap.parse_args()
    seen: set[str] = set()
    ok = True
    bundle = {}
    dirs = [p for p in sorted(DATA.iterdir()) if p.is_dir()] if DATA.exists() else []
    if a.only:
        dirs = [p for p in dirs if p.name == a.only]
    total = 0
    for d in dirs:
        errors, warnings, data = validate_project(d, seen)
        total += data["stats"]["questions"]
        status = "OK" if not errors else f"{len(errors)} ERRORS"
        print(f"[{status}] {d.name}: {data['stats']['questions']} questions; difficulties={data['stats']['difficulties']}")
        for e in errors[:40]:
            print(f"    - {e}")
        if len(errors) > 40:
            print(f"    ... {len(errors) - 40} more")
        ok &= not errors
        bundle[d.name] = data
    print(f"TOTAL questions: {total}")
    if a.bundle:
        a.bundle.mkdir(parents=True, exist_ok=True)
        index = []
        for slug, data in bundle.items():
            (a.bundle / f"{slug}.json").write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")
            index.append({"slug": slug, "project": data["meta"].get("project", slug),
                          "summary": data["meta"].get("summary", ""), "stats": data["stats"]})
        (a.bundle / "index.json").write_text(json.dumps(index, ensure_ascii=True, indent=1), encoding="utf-8")
        if a.with_sources:
            copied = copy_sources(bundle, a.bundle / "src")
            print(f"copied {len(copied)} referenced source files")
        print(f"bundle written to {a.bundle}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
