import { href } from "../lib/router";
import { useLocalSetting } from "../lib/progress";

// A referenced repo file: opens the in-site source viewer (files are copied by validate.py --with-sources),
// plus an optional "open in VS Code" link when the user has set the local path of their checkout.
export function FileLink({ ref_ }: { ref_: string }) {
  const [path, symbol] = ref_.split("::");
  const [root] = useLocalSetting("bp-repo-root", "");
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <a href={href("/source", { path, symbol })} className="font-mono text-sm text-sky-700 hover:underline dark:text-sky-300">
        {path}{symbol ? <span className="text-amber-600 dark:text-amber-400">::{symbol}</span> : null}
      </a>
      {root && (
        <a className="text-xs text-slate-500 hover:underline" href={`vscode://file/${root.replace(/\\/g, "/").replace(/\/$/, "")}/${path}`}>
          open in VS Code
        </a>
      )}
    </span>
  );
}
