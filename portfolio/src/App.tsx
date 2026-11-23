import { useEffect } from "react";
import { href, useRoute } from "./lib/router";
import { useLocalSetting } from "./lib/progress";
import Home from "./pages/Home";
import ProjectPage from "./pages/ProjectPage";
import Interview from "./pages/Interview";
import SystemDesign from "./pages/SystemDesign";
import ProgressPage from "./pages/Progress";
import SourceViewer from "./pages/SourceViewer";

const NAV = [
  ["/", "Portfolio"], ["/interview", "Interview prep"], ["/system-design", "System design"], ["/progress", "Progress"],
] as const;

export default function App() {
  const route = useRoute();
  const [theme, setTheme] = useLocalSetting("bp-theme", "dark");
  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  useEffect(() => { window.scrollTo(0, 0); }, [route.path]);

  let page;
  if (route.path === "/") page = <Home />;
  else if (route.path.startsWith("/project/")) page = <ProjectPage slug={route.path.slice(9)} />;
  else if (route.path === "/interview") page = <Interview params={route.params} />;
  else if (route.path === "/system-design") page = <SystemDesign params={route.params} />;
  else if (route.path === "/progress") page = <ProgressPage />;
  else if (route.path === "/source") page = <SourceViewer path={route.params.get("path") || ""} symbol={route.params.get("symbol") || ""} />;
  else page = <div className="p-8">Not found. <a className="text-sky-600" href="#/">Home</a></div>;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <a href="#/" className="font-semibold">Backend Systems Portfolio</a>
          <nav className="flex flex-wrap gap-1 text-sm">
            {NAV.map(([p, label]) => {
              const active = p === "/" ? route.path === "/" || route.path.startsWith("/project/") : route.path.startsWith(p);
              return <a key={p} href={href(p)} className={"rounded-md px-3 py-1.5 " + (active ? "bg-slate-200 dark:bg-slate-800" : "hover:bg-slate-100 dark:hover:bg-slate-900")}>{label}</a>;
            })}
          </nav>
          <button className="ml-auto rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-900"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? "Light mode" : "Dark mode"}</button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{page}</main>
      <footer className="border-t border-slate-200 py-6 text-center text-xs text-slate-500 dark:border-slate-800">
        The projects themselves are not deployed publicly; every project runs locally (the first ten with Docker Compose). Benchmark numbers come from each project's TESTING.md (projects 11 and 12: their READMEs and saved raw bench results; projects 13, 14, 16 and 18 have not been measured for speed; projects 15, 17 and 19: their READMEs and saved raw results).
      </footer>
    </div>
  );
}
