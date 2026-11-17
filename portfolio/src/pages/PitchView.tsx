import { useState } from "react";
import type { Pitch } from "../lib/types";
import { Button, Card } from "../components/ui";
import { Bullets, Rich } from "../components/Rich";

const TABS: [keyof Pitch, string][] = [
  ["intro_30s", "30 seconds"], ["explain_2min", "2 minutes"], ["deep_5min", "5 minute deep dive"],
  ["architecture_walkthrough", "Architecture walkthrough"], ["difficult_decisions", "Difficult decisions"],
  ["biggest_challenges", "Biggest challenges"], ["failure_scenarios", "Failure scenarios"], ["improvements", "Improvements"],
];

export function PitchView({ pitch }: { pitch?: Pitch }) {
  const [tab, setTab] = useState<keyof Pitch>("intro_30s");
  if (!pitch) return <p className="text-sm text-slate-500">Not written yet.</p>;
  const v = pitch[tab] ?? "";
  return (
    <div>
      <div className="flex flex-wrap gap-2">{TABS.map(([k, l]) => <Button key={k} active={k === tab} onClick={() => setTab(k)}>{l}</Button>)}</div>
      <Card className="mt-4">{Array.isArray(v) ? <Bullets items={v} /> : <Rich text={v} />}</Card>
    </div>
  );
}
