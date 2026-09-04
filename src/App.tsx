import { useEffect, useState } from "react";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPanel } from "./components/SettingsPanel";
import { JobMonitor } from "./components/JobMonitor";
import { Playground } from "./pages/Playground";
import { PersonasPage } from "./pages/PersonasPage";
import { TheaterPage } from "./pages/TheaterPage";
import { GO_TAB_EVENT, type TopTab } from "./flow/nav";

const TABS: { id: TopTab; label: string }[] = [
  { id: "projects", label: "作品" },
  { id: "theater", label: "🎭 RP 剧场" }, // 独立酒馆：房间/节奏/副本/场记，跨作品
  { id: "personas", label: "画像" }, // 全局数据：{{user}} 形象，跨作品
  { id: "settings", label: "设置" },
  { id: "play", label: "调试台" },
];

export default function App() {
  const [tab, setTab] = useState<TopTab>("projects");
  // 深层页面（试跑「续写去剧场」等）经导航总线请求切页，免层层传 prop
  useEffect(() => {
    const h = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: TopTab } | undefined;
      if (detail?.tab) setTab(detail.tab);
    };
    window.addEventListener(GO_TAB_EVENT, h);
    return () => window.removeEventListener(GO_TAB_EVENT, h);
  }, []);
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
        {tab === "theater" && <TheaterPage />}
        {tab === "personas" && <PersonasPage />}
        {tab === "settings" && <SettingsPanel />}
        {tab === "play" && <Playground />}
      </main>
      <JobMonitor />
    </div>
  );
}
