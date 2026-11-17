import { loadSource, loadSources, useAsync } from "../lib/data";
import { Card, Loading } from "../components/ui";
import { Code, langForPath } from "../components/Code";

// Shows a repo file copied into the site bundle. If a ::symbol was given, scroll to its first definition.
export default function SourceViewer({ path, symbol }: { path: string; symbol: string }) {
  const { data: list } = useAsync(loadSources, []);
  const known = !list || list.includes(path) || path.endsWith(".md");
  const { data, error } = useAsync(() => (known ? loadSource(path) : Promise.reject("not bundled")), [path, known]);
  const line = data && symbol ? findLine(data, symbol) : 0;
  return (
    <div>
      <button onClick={() => history.back()} className="text-sm text-sky-700 hover:underline dark:text-sky-300">&lt;- Back</button>
      <h1 className="mt-2 break-all font-mono text-lg">{path}{symbol && <span className="text-amber-600">::{symbol}</span>}</h1>
      {line > 0 && <p className="text-xs text-slate-500">{symbol} at line {line}</p>}
      <div className="mt-4">
        {data ? <Code code={data} lang={langForPath(path)} lineNumbers focusLine={line || undefined} />
          : error ? <Card>This file is not included in the site bundle. Open it in the repository at <code>{path}</code>.</Card>
          : <Loading />}
      </div>
    </div>
  );
}

function findLine(text: string, symbol: string): number {
  const name = symbol.split(".").pop()!;
  const lines = text.split("\n");
  const def = new RegExp(`(def|class|function|const|let|async def|CREATE[A-Z ]*)\\s+${name}\\b|^\\s*${name}\\s*[:=]`);
  let i = lines.findIndex((l) => def.test(l));
  if (i < 0) i = lines.findIndex((l) => new RegExp(`\\b${name}\\b`).test(l));
  return i + 1;
}
