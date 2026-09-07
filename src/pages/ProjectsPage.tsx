// ============================================================
// story-studio M0 — 作品管理页
// M0 验收：新建作品 → 刷新页面数据不丢（IndexedDB 持久化）。
// 页面只经 store/repos 门面读写数据；类型只 import type 自 core/types。
// ============================================================
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Project } from "../core/types";
import * as repos from "../store/repos";
import { downloadBlob, errMsg, formatTime } from "../core/uiUtils";
import { bundleZipBytes } from "../flow/bundle";
import { goTab } from "../flow/nav";
import { peekHandoff, putHandoff } from "../flow/handoff";
import { loadProgress, saveProgress } from "../flow/progress";
import { InterviewPage } from "./InterviewPage";
import { OutlinePage } from "./OutlinePage";
import { TrialPage } from "./TrialPage";
import { ProjectAssetsPanel } from "../components/ProjectAssetsPanel";

// v3.1-④：作品工作区不再有「台账」页签——台账整体迁入 🎭 RP 剧场（每剧组独立）。
// v4：人物卡/世界书升为顶层全局库，工作区对应页签换成「📦 资产」（本作品选用哪些全局资产）。
type WsTab = "interview" | "outline" | "trial" | "assets";
const WS_TABS: { id: WsTab; label: string }[] = [
  { id: "interview", label: "构思访谈" },
  { id: "outline", label: "大纲工作台" },
  { id: "trial", label: "ST 试跑" },
  { id: "assets", label: "📦 资产" },
];

// ------------------------------------------------------------
// 入口：作品列表 + 新建表单；点开进入 ProjectWorkspace（同文件组件）
// ------------------------------------------------------------

/** confirm/按钮里的作品名截断（审计 P1：长名把弹窗与按钮撑爆） */
function shortTitle(t: string, n = 24): string {
  const s = t.trim() || "（未命名）";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

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
      setError(errMsg(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 进入某作品即记住（v3.1-②）
  useEffect(() => {
    if (open) saveProgress("projects", undefined, { projectId: open.id });
  }, [open]);

  // v3.1-② 进度记忆：上次打开的作品自动回到工作台（页签由 ProjectWorkspace 自恢复；有复盘投递时让位）
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!loaded || restoredRef.current || open) return;
    restoredRef.current = true;
    if (peekHandoff("recap", "*")) return; // 复盘投递优先决定开哪个作品
    const last = loadProgress<{ projectId?: string }>("projects");
    if (!last?.projectId) return;
    const proj = projects.find((p) => p.id === last.projectId);
    if (proj) setOpen(proj);
  }, [loaded, projects, open]);

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
        key={open.id}
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
    try {
      await repos.createProject(t, synopsis.trim());
      setTitle("");
      setSynopsis("");
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const removeProject = async (p: Project) => {
    if (
      !window.confirm(
        `删除作品《${shortTitle(p.title)}》及其大纲/会话/台账/RP 剧场中挂在本作品下的全部剧组与剧组正典？\n注意：人物卡与世界书是全局资产库，**不会**随作品删除。此操作不可恢复。`,
      )
    ) {
      return;
    }
    try {
      await repos.deleteProjectCascade(p.id);
      await refresh();
    } catch (err) {
      setError(errMsg(err));
    }
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
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button
                className="primary"
                onClick={() => setOpen(p)}
                style={{ maxWidth: "60%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={p.title}
              >
                {shortTitle(p.title)}
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

function ProjectWorkspace({ project: initial, onBack }: { project: Project; onBack: () => void }) {
  // v4：「📦 资产」面板会回写选用列表，工作台持有可刷新的 project 副本（单一所有者仍在本组件）
  const [project, setProject] = useState<Project>(initial);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  // v3.1-②：工作现场记忆（上次页签）；复盘投递优先落 ST 试跑
  const [wsTab, setWsTab] = useState<WsTab>(() => {
    if ((peekHandoff("recap", project.id) as { sessionId?: string } | null)?.sessionId) return "trial";
    const saved = loadProgress<{ wsTab?: WsTab }>("ws", project.id);
    return saved?.wsTab && WS_TABS.some((t) => t.id === saved.wsTab) ? saved.wsTab : "interview";
  });
  useEffect(() => {
    saveProgress("ws", project.id, { wsTab });
  }, [project.id, wsTab]);
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
      // 剧场剧组与试跑会话同在 sessions 表（projectId 已隔离），随包整体导出。
      // v4：characters/loreEntries 取的是**可见集**（自有 ∪ 选用）——包里带的是"本作品用到的全部资产"，
      // 其中可能混有主场在他作品的共享资产（ST 通用格式，导入酒馆无差别）。
      const rooms = sessions.filter((s) => s.kind === "theater");
      const bytes = bundleZipBytes({
        project: proj,
        nodes,
        characters: chars,
        loreEntries: lore,
        ledger,
        sessions,
      });
      const safeTitle = (proj.title || "story").replace(/[\\/:*?"<>|]/g, "_");
      downloadBlob(`${safeTitle}-story-studio.zip`, bytes);
      setExportMsg(`已导出 ${(bytes.length / 1024).toFixed(0)} KB${rooms.length ? `（含 ${rooms.length} 个剧场剧组）` : ""}。`);
    } catch (e) {
      setExportMsg(`导出失败：${errMsg(e)}`);
    } finally {
      setExporting(false);
    }
  };

  /** 作品级台账的「导去剧场演」：投递后跳顶层剧场页自动开机（剧本=当前全纲快照） */
  const toTheater = () => {
    putHandoff({ kind: "theater", projectId: project.id, nodeId: "" });
    goTab("theater");
  };

  const refreshStats = useCallback(async () => {
    try {
      // 先回读并落位 project（资产面板勾选态的唯一视觉来源）——它不该被后面的统计聚合拖住：
      // 统计里任何一个读函数抛错（或耗时）都不能让勾选框"点了没反应"。
      const proj = await repos.getProject(project.id);
      if (proj) setProject(proj); // 资产选用面板可能已改库：以库为准
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
      setError(errMsg(err));
    }
  }, [project.id]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  const removeProject = async () => {
    if (!window.confirm(`删除作品《${shortTitle(project.title)}》及其大纲/会话/台账/RP 剧场中挂在本作品下的全部剧组与剧组正典？\n注意：人物卡与世界书是全局资产库，**不会**随作品删除（其它作品选用的照旧可用）。此操作不可恢复。`)) return;
    try {
      await repos.deleteProjectCascade(project.id);
      onBack();
    } catch (err) {
      setError(errMsg(err));
    }
  };

  const num = (n: number | undefined) => (stats ? String(n ?? 0) : "…");

  return (
    <div>
      <div className="panel row" style={{ flexWrap: "wrap" }}>
        <button onClick={onBack}>← 返回</button>
        <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "40%" }} title={project.title}>
          {shortTitle(project.title)}
        </strong>
        <span className="muted">更新于 {formatTime(project.updatedAt)}</span>
        <button onClick={() => void removeProject()}>删除作品</button>
      </div>
      {project.synopsis && <p className="muted">{project.synopsis}</p>}
      {error && <p className="muted">统计加载失败：{error}</p>}

      <div className="grid2">
        <div className="panel">
          <span className="muted">人物卡（可用）</span>
          <div>{num(stats?.characters)}</div>
        </div>
        <div className="panel">
          <span className="muted">世界书词条（可用）</span>
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
        <button onClick={toTheater} title="用当前大纲开一个剧场剧组（full 模式：能感知这份大纲之后的变化）">
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
      {wsTab === "assets" && <ProjectAssetsPanel project={project} onProjectChanged={() => void refreshStats()} />}
    </div>
  );
}
