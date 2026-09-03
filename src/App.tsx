import { useState } from "react";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPanel } from "./components/SettingsPanel";
import { JobMonitor } from "./components/JobMonitor";
import { Playground } from "./pages/Playground";
import { PersonasPage } from "./pages/PersonasPage";

type Tab = "projects" | "personas" | "settings" | "play";

const TABS: { id: Tab; label: string }[] = [
  { id: "projects", label: "作品" },
  { id: "personas", label: "画像" }, // 全局数据：{{user}} 形象，跨作品
  { id: "settings", label: "设置" },
  { id: "play", label: "调试台" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("projects");
  return (
    <div className="app">
      <header className="topbar">
        <span className="logo">📖 Story Studio</span>
        <nav>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? "tab active" : "tab"}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content">
        {tab === "projects" && <ProjectsPage />}
        {tab === "personas" && <PersonasPage />}
        {tab === "settings" && <SettingsPanel />}
        {tab === "play" && <Playground />}
      </main>
      <JobMonitor />
    </div>
  );
}
