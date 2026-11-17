import { useEffect, useState } from "react";
import type { Bank, IndexEntry, Question } from "./types";

// Data is produced by `npm run data` (interview/validate.py --bundle public/data --with-sources).
const BASE = "./data/";

const cache = new Map<string, Promise<unknown>>();
function getJson<T>(path: string): Promise<T> {
  if (!cache.has(path)) {
    cache.set(path, fetch(BASE + path).then((r) => {
      if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
      return r.json();
    }));
  }
  return cache.get(path) as Promise<T>;
}

export const loadIndex = () => getJson<IndexEntry[]>("index.json");
export const loadBank = (slug: string) => getJson<Bank>(`${slug}.json`);
export const loadSources = () => getJson<string[]>("sources.json");

export async function loadAll(): Promise<Record<string, Bank>> {
  const idx = await loadIndex();
  const banks = await Promise.all(idx.map((e) => loadBank(e.slug)));
  return Object.fromEntries(idx.map((e, i) => [e.slug, banks[i]]));
}

export async function loadSource(path: string): Promise<string> {
  const r = await fetch(BASE + "src/" + path.split("/").map(encodeURIComponent).join("/"));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    setState({});
    fn().then((data) => live && setState({ data }), (e) => live && setState({ error: String(e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function allQuestions(banks: Record<string, Bank>): Question[] {
  return Object.values(banks).flatMap((b) => b.questions);
}
