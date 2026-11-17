import { useCallback, useSyncExternalStore } from "react";

// Learned / bookmarked state lives in this browser only (localStorage). Every access is guarded: storage can
// be unavailable (private mode, blocked site data) and the site must still work.
const KEY = "bp-interview-progress-v1";
type State = { learned: Record<string, number>; bookmarked: Record<string, number> };

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { learned: {}, bookmarked: {} };
}

let state: State = read();
const listeners = new Set<() => void>();
function write(next: State) {
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* ignore */ }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useProgress() {
  const s = useSyncExternalStore(subscribe, () => state);
  const toggle = useCallback((kind: keyof State, id: string, on?: boolean) => {
    const cur = { ...state[kind] };
    const want = on ?? !cur[id];
    if (want) cur[id] = Date.now(); else delete cur[id];
    write({ ...state, [kind]: cur });
  }, []);
  const reset = useCallback(() => write({ learned: {}, bookmarked: {} }), []);
  return {
    learned: s.learned,
    bookmarked: s.bookmarked,
    isLearned: (id: string) => !!s.learned[id],
    isBookmarked: (id: string) => !!s.bookmarked[id],
    toggleLearned: (id: string, on?: boolean) => toggle("learned", id, on),
    toggleBookmark: (id: string, on?: boolean) => toggle("bookmarked", id, on),
    reset,
  };
}

export function useLocalSetting(key: string, initial: string): [string, (v: string) => void] {
  const get = () => { try { return localStorage.getItem(key) ?? initial; } catch { return initial; } };
  const v = useSyncExternalStore(subscribe, get);
  return [v, (nv: string) => {
    try { localStorage.setItem(key, nv); } catch { /* ignore */ }
    listeners.forEach((l) => l());
  }];
}
