// ============================================================
// story-studio M0 — 作品管理页
// M0 验收：新建作品 → 刷新页面数据不丢（IndexedDB 持久化）。
// 页面只经 store/repos 门面读写数据；类型只 import type 自 core/types。
// ============================================================
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Project } from "../core/types";
import * as repos from "../store/repos";
import { bundleZipBytes } from "../flow/bundle";
import { goTab } from "../flow/nav";
import { peekHandoff, putHandoff } from "../flow/handoff";
import { InterviewPage } from "./InterviewPage";
import { OutlinePage } from "./OutlinePage";
import { TrialPage } from "./TrialPage";
import { LedgerPage } from "./LedgerPage";
import { CastPage } from "./CastPage";
import { LorePage } from "./LorePage";

type WsTab = "interview" | "outline" | "trial" | "ledger" | "cast" | "lore";
const WS_TABS: { id: WsTab; label: string }[] = [
  { id: "interview", label: "构思访谈" },
  { id: "outline", label: "大纲工作台" },
  { id: "trial", label: "ST 试跑" },
  { id: "ledger", label: "台账" },
  { id: "cast", label: "人物卡" },
  { id: "lore", label: "世界书" },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

/** 二进制下载（zip） */
function downloadBlob(name: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([(bytes.slice(0).buffer as ArrayBuffer)], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ------------------------------------------------------------
// 入口：作品列表 + 新建表单；点开进入 ProjectWorkspace（同文件组件）
// ------------------------------------------------------------
export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Project | null>(null);
  const [title, setTitle] = useState("");
  const [synopsis, setSynopsis] = useState("");

  const refresh = useCallback(async () => {
    try {
      setProjects(await repos.listProjects());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 「带对话去复盘」落在别的页签时：自动打开对应作品工作台（TrialPage 挂载后自消费投递）
  const recapPeekDone = useRef(false);
  useEffect(() => {
    if (!loaded || recapPeekDone.current || open) return;
    recapPeekDone.current = true;
    const h = peekHandoff("recap", "*") as { projectId?: string } | null;
    if (!h?.projectId) return;
    const proj = projects.find((p) => p.id === h.projectId);
    if (proj) setOpen(proj);
  }, [loaded, projects, open]);

  if (open) {
    return (
      <ProjectWorkspace
        project={open}
        onBack={() => {
          setOpen(null);
          void refresh();
        }}
      />
    );
  }

  const createProject = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    await repos.createProject(t, synopsis.trim());
    setTitle("");
    setSynopsis("");
    await refresh();
  };

  const removeProject = async (p: Project) => {
    if (
      !window.confirm(`删除作品《${p.title}》及其全部数据（大纲/人物/世界书/会话/台账）？此操作不可恢复。`)
    ) {
      return;
    }
    await repos.deleteProjectCascade(p.id);
    await refresh();
  };

  return (
    <div className="grid2">
      <form className="panel" onSubmit={(e) => void createProject(e)}>
        <h3>新建作品</h3>
        <label className="field">
          <span>标题（必填）</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="作品名" />
        </label>
        <label className="field">
          <span>一句话梗概</span>
          <input value={synopsis} onChange={(e) => setSynopsis(e.target.value)} placeholder="可留空，访谈后再补" />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={!title.trim()}>
            新建
          </button>
        </div>
      </form>

      <section className="panel">
        <h3>我的作品</h3>
        {error && <p className="muted">加载失败：{error}</p>}
        {!loaded && !error && <p className="muted">正在读取本地库…</p>}
        {loaded && !error && projects.length === 0 && <p className="muted">还没有作品，先新建一个。</p>}
        {projects.map((p) => (
          <div className="panel" key={p.id}>
            <div className="row">
              <button className="primary" onClick={() => setOpen(p)}>
                {p.title}
              </button>
              <span className="muted">更新于 {formatTime(p.updatedAt)}</span>
              <button onClick={() => void removeProject(p)}>删除</button>
            </div>
            <p>{p.synopsis || <span className="muted">（暂无梗概）</span>}</p>
          </div>
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------
// 工作台壳：统计概览（从 repos 取） + 后续里程碑占位
// ------------------------------------------------------------
interface Stats {
  characters: number;
  loreEntries: number;
  nodes: number;
  sessions: number;
}

function ProjectWorkspace({ project, onBack }: { project: Project; onBack: () => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 剧场「带对话去复盘」进来：直接落在 ST 试跑页签（TrialPage 挂载才消费投递）
  const [wsTab, setWsTab] = useState<WsTab>(() =>
    (peekHandoff("recap", project.id) as { sessionId?: string } | null)?.sessionId ? "trial" : "interview",
  );
  const [exporting, setExporting] = useState(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const exportBundle = async () => {
    setExporting(true);
    setExportMsg(null);
    try {
      const [proj, nodes, chars, lore, ledger, sessions] = await Promise.all([
        repos.getProject(project.id),
        repos.listNodes(project.id),
        repos.listCharacters(project.id),
        repos.listLoreEntries(project.id),
        repos.listLedger(project.id),
        repos.listSessions(project.id),
      ]);
      if (!proj) {
        setExportMsg("作品不存在（可能已被删除）。");
        return;
      }
      // 剧场房间（跨作品共享 sessions 表，projectId 已隔离）：一并进包
      const rooms = sessions.filter((s) => s.kind === "theater");
      const bytes = bundleZipBytes({
        project: proj,
        nodes,
        characters: chars,
        loreEntries: lore,
        ledger,
        sessions: [...sessions.filter((s) => s.kind !== "theater"), ...rooms],
      });
      const safeTitle = (proj.title || "story").replace(/[\\/:*?"<>|]/g, "_");
      downloadBlob(`${safeTitle}-story-studio.zip`, bytes);
      setExportMsg(`已导出 ${(bytes.length / 1024).toFixed(0)} KB${rooms.length ? `（含 ${rooms.length} 个剧场房间）` : ""}。`);
    } catch (e) {
      setExportMsg(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  };

  /** 作品级台账的「导去剧场演」：投递后跳顶层剧场页自动开房（剧本=当前全纲快照） */
  const toTheater = () => {
    putHandoff({ kind: "theater", projectId: project.id, nodeId: "", auto: true });
    goTab("theater");
  };

  const refreshStats = useCallback(async () => {
    try {
      const [characters, loreEntries, nodes, sessions] = await Promise.all([
        repos.listCharacters(project.id),
        repos.listLoreEntries(project.id),
        repos.listNodes(project.id),
        repos.listSessions(project.id),
      ]);
      setStats({
        characters: characters.length,
        loreEntries: loreEntries.length,
        nodes: nodes.length,
        sessions: sessions.length,
      });
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [project.id]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const removeProject = async () => {
    if (!window.confirm(`删除作品《${project.title}》及其全部数据？此操作不可恢复。`)) return;
    await repos.deleteProjectCascade(project.id);
    onBack();
  };

  const num = (n: number | undefined) => (stats ? String(n ?? 0) : "…");

  return (
    <div>
      <div className="panel row">
        <button onClick={onBack}>← 返回</button>
        <strong>{project.title}</strong>
        <span className="muted">更新于 {formatTime(project.updatedAt)}</span>
        <button onClick={() => void removeProject()}>删除作品</button>
      </div>
      {project.synopsis && <p className="muted">{project.synopsis}</p>}
      {error && <p className="muted">统计加载失败：{error}</p>}

      <div className="grid2">
        <div className="panel">
          <span className="muted">人物</span>
          <div>{num(stats?.characters)}</div>
        </div>
        <div className="panel">
          <span className="muted">世界书词条</span>
          <div>{num(stats?.loreEntries)}</div>
        </div>
        <div className="panel">
          <span className="muted">大纲节点</span>
          <div>{num(stats?.nodes)}</div>
        </div>
        <div className="panel">
          <span className="muted">RP 会话</span>
          <div>{num(stats?.sessions)}</div>
        </div>
      </div>

      <div className="panel row">
        <button onClick={() => void exportBundle()} disabled={exporting}>
          {exporting ? "打包中…" : "📦 导出项目包（zip）"}
        </button>
        <button onClick={toTheater} title="用当前大纲开一个剧场房间（full 模式：能感知这份大纲之后的变化）">
          🎭 导去剧场演全本
        </button>
        <span className="muted" style={{ fontSize: 12 }}>
          大纲 md/json + 作品档案 + 台账 + RP 转写 + 人物卡（V2）+ 世界书（ST 格式），备份/迁移/进酒馆一包带走。
        </span>
        {exportMsg && <span className="muted">{exportMsg}</span>}
      </div>

      <div className="panel row">
        {WS_TABS.map((t) => (
          <button key={t.id} className={wsTab === t.id ? "tab active" : "tab"} onClick={() => setWsTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {wsTab === "interview" && <InterviewPage projectId={project.id} />}
      {wsTab === "outline" && <OutlinePage projectId={project.id} />}
      {wsTab === "trial" && <TrialPage projectId={project.id} />}
      {wsTab === "ledger" && <LedgerPage projectId={project.id} />}
      {wsTab === "cast" && <CastPage projectId={project.id} />}
      {wsTab === "lore" && <LorePage projectId={project.id} />}
    </div>
  );
}
