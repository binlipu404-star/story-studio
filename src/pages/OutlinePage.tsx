// ============================================================
// story-studio M3 — 大纲工作台
// 左列：工具栏（生成总纲 / 下一幕提案 / 导出 Markdown）+ 大纲树；
// 右列：节点编辑器（内容 + 状态机 + 删除子树 + AI 共写提案）。
// 约定：树渲染/层级/状态机全部走 flow/outline 纯函数；
//       读经 repos 门面；批量插入与手工组节点直用 db 单例（规格指定）。
// ============================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Beat,
  Character,
  ForeshadowLink,
  LedgerRecord,
  OutlineLevel,
  OutlineNode,
  OutlineStatus,
  Project,
} from "../core/types";
import * as repos from "../store/repos";
import type { OutlineNodePatch } from "../store/repos";
import { db } from "../store/db";
import {
  beatsFromStrings,
  canTransition,
  childrenOf,
  LEVEL_NAMES,
  LEVEL_ORDER,
  lineageOf,
  masterToNodes,
  preorder,
  treeToMarkdown,
  validatePlacement,
  type MasterOutlineJson,
} from "../flow/outline.js";
import { chatJSON } from "../ai/client";
import { abortJob, startJob, useJobs } from "../core/jobBus";
import {
  masterOutlinePrompt,
  nextScenePrompt,
  nodeDiscussPrompt,
  outlineCoachPrompt,
  sceneBeatsPrompt,
  STRUCTURE_NAMES,
  type OutlineStructure,
} from "../ai/prompts";
import { draftToBookScenes, outlineBookJson, type OutlineBookScene } from "../flow/outlinebook";

// ---------- 展示常量 ----------

const LEVEL_ICONS: Record<OutlineLevel, string> = {
  volume: "📚",
  chapter: "📖",
  scene: "🎬",
  beat: "•",
};
const STATUS_LABELS: Record<OutlineStatus, string> = {
  idea: "灵感",
  draft: "草案",
  refined: "细化",
  tested: "已试跑",
  locked: "已锁定",
};
const ALL_STATUSES: OutlineStatus[] = ["idea", "draft", "refined", "tested", "locked"];
const STRUCTURES: OutlineStructure[] = ["three-act", "kishotenketsu", "hero"];

// ---------- 内联样式（styles.css 不在本代理可改范围） ----------

const twoCol: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(320px, 5fr) minmax(360px, 7fr)",
  gap: 16,
  alignItems: "start",
};
const warnBox: CSSProperties = {
  background: "#fdf6dd",
  border: "1px solid #e3cf8e",
  borderRadius: 10,
  padding: "10px 12px",
  color: "#7a6013",
  fontSize: 13,
};
const errBox: CSSProperties = {
  background: "#fbe9e7",
  border: "1px solid #e0a8a0",
  borderRadius: 10,
  padding: "10px 12px",
  color: "#8c2f22",
  fontSize: 13,
};
const badge: CSSProperties = {
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 8px",
  borderRadius: 999,
  background: "#efece4",
  color: "#6f6a60",
  whiteSpace: "nowrap",
};
const fieldStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 13,
  color: "var(--muted)",
};

// ---------- 防御式解析小工具（AI 返回一律 unknown 进、安全字段出） ----------

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
/** 下载一个文本文件：Blob + 临时 <a download>.click()，用完即 revoke */
function downloadText(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
/** 复制：优先 navigator.clipboard；失败/不可用降级隐藏 textarea select + execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 非安全上下文/权限拒绝：走降级 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
function asStrArray(v: unknown): string[] {
  return Array.isArray(v)
    ? v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    : [];
}

// ---------- 页面本地形态 ----------

/** 「下一幕提案」JSON 的规整形态 */
interface SceneProposal {
  title: string;
  intent: string;
  location: string;
  timepoint: string;
  castNames: string[];
  beats: string[];
}
/** 「AI 共写」提案形态（nodeDiscussPrompt 的 JSON 规整后） */
interface DiscussProposal {
  comment: string;
  title: string;
  intent: string;
  beats: string[];
  foreshadows: { setup: string; payoffIn: string }[];
}
/** runAI 的结果包装：区分「AI 失败/被停止」与「合法返回了 null 等假值」 */
type AiResult<T> = { ok: true; value: T } | { ok: false };

function charactersByNameMap(chars: Character[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of chars) if (c.name) m[c.name] = c.id;
  return m;
}

// ============================================================
// 主组件
// ============================================================
export function OutlinePage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [ledger, setLedger] = useState<LedgerRecord[]>([]); // 仅 confirmed
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);

  // 全局 AI 忙碌态：所有 chatJSON 共用一个 AbortController + 一个停止按钮
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 生成总纲走后台任务总线：切页/卸载不打断，完成即在任务闭包落库
  const jobs = useJobs();
  const runningMaster = jobs.find(
    (j) => j.kind === "master" && j.projectId === projectId && j.status === "running",
  );
  const announcedRef = useRef<Set<string> | null>(null);

  // 生成总纲表单
  const [structure, setStructure] = useState<OutlineStructure>("three-act");
  const [volumeCount, setVolumeCount] = useState("");
  const [hint, setHint] = useState("");

  // 行尾「＋」加子节点菜单（parentId=null ⇔ 根级新卷）
  const [addMenu, setAddMenu] = useState<{ parentId: string | null } | null>(null);
  const [addLevel, setAddLevel] = useState<OutlineLevel>("volume");
  const [addTitle, setAddTitle] = useState("");

  // 下一幕提案
  const [sceneProp, setSceneProp] = useState<SceneProposal | null>(null);
  const [mountChapterId, setMountChapterId] = useState("");

  // 剧情世界书（ST）：勾选若干幕 → 一整本不绑角色的剧情推进书
  const [bookSel, setBookSel] = useState<Set<string>>(new Set());
  const [bookIncludeDone, setBookIncludeDone] = useState(false);
  const [bookOut, setBookOut] = useState<{
    json: string;
    lines: string[];
    fileName: string;
    skippedDone: number;
  } | null>(null);
  const bookInit = useRef(false);

  // 大纲共创访谈：AI 每轮一问一边搭草稿（粗放：整体大纲/走向/细纲题目，beats 恒空）
  const [coachMsgs, setCoachMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [coachDraft, setCoachDraft] = useState<MasterOutlineJson | null>(null);
  const [coachInput, setCoachInput] = useState("");

  const reload = useCallback(async () => {
    try {
      const [proj, rows, chars, led] = await Promise.all([
        repos.getProject(projectId),
        repos.listNodes(projectId),
        repos.listCharacters(projectId),
        repos.listLedger(projectId, "confirmed"),
      ]);
      setProject(proj ?? null);
      setNodes(rows);
      setCharacters(chars);
      setLedger(led);
      setError("");
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  // ---------- 剧情世界书（ST · 幕粒度 · 不绑角色） ----------

  /** 树序（叙事序）里的全部「幕」 */
  const bookScenes = preorder(nodes).filter((n) => n.level === "scene");
  /** 整幕退场判定：有节拍且全部已演（复盘里标记的 done） */
  const isScenePlayed = (n: OutlineNode) => n.beats.length > 0 && n.beats.every((b) => b.done);

  // 首次载入：默认勾上所有未演完的幕（此后不再覆盖用户的手动选择）
  useEffect(() => {
    if (!loaded || bookInit.current) return;
    const scenes = preorder(nodes).filter((n) => n.level === "scene");
    if (scenes.length === 0) return;
    bookInit.current = true;
    setBookSel(new Set(scenes.filter((n) => !(n.beats.length > 0 && n.beats.every((b) => b.done))).map((n) => n.id)));
  }, [loaded, nodes]);

  const toggleBookScene = (id: string) =>
    setBookSel((prev) => {
      const s = new Set(prev);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return s;
    });

  const buildOutlineBook = () => {
    setError("");
    setInfo("");
    const nameById = new Map(characters.map((c) => [c.id, c.name] as const));
    const picked = preorder(nodes).filter((n) => n.level === "scene" && bookSel.has(n.id));
    if (picked.length === 0) {
      setError("先在左侧清单勾选至少一幕。");
      return;
    }
    const scenes: OutlineBookScene[] = picked.map((n) => ({
      nodeId: n.id,
      title: n.title,
      lineage:
        lineageOf(nodes, n.id)
          .filter((x) => x.level !== "scene")
          .map((x) => x.title)
          .join("·") || undefined,
      intent: n.intent || undefined,
      location: n.location || undefined,
      timepoint: n.timepoint || undefined,
      beats: n.beats,
      castNames: n.cast.map((id) => nameById.get(id) ?? "").filter(Boolean),
      done: isScenePlayed(n),
    }));
    try {
      const { json, result } = outlineBookJson(scenes, { projectId, includeDone: bookIncludeDone });
      if (result.entries.length <= 1) {
        setBookOut(null);
        setError("所选幕均已演完且无剩余指令——取消「跳过已演完」或去大纲里清除节拍的已演标记。");
        return;
      }
      setBookOut({
        json,
        lines: result.scenesByEntry.map(
          (s) => `${s.scene}｜触发：${s.keys.join("、")}${s.fallback ? "（弱触发 → 蓝灯常驻）" : ""}`,
        ),
        fileName: `worldbook-剧情推进-${project?.title || "project"}.json`,
        skippedDone: result.skippedDone,
      });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const copyBook = async () => {
    if (!bookOut) return;
    setInfo((await copyToClipboard(bookOut.json)) ? "剧情世界书 JSON 已复制到剪贴板" : "复制失败，请改用下载");
  };

  // ---------- 大纲共创访谈：一边访谈一边搭草稿 → 应用 / 填细纲 / 直通成书 ----------

  const coachStats = (() => {
    let v = 0;
    let c = 0;
    let s = 0;
    for (const vol of coachDraft?.volumes ?? []) {
      v++;
      for (const ch of Array.isArray(vol?.chapters) ? vol.chapters : []) {
        c++;
        s += Array.isArray(ch?.scenes) ? ch.scenes.length : 0;
      }
    }
    return { v, c, s };
  })();

  const sendCoach = async () => {
    const text = coachInput.trim();
    if (!text || !project) return;
    const hist = coachMsgs;
    const draftNow = coachDraft;
    setCoachInput("");
    setCoachMsgs((m) => [...m, { role: "user", content: text }]);
    const r = await runAI("共创访谈", (signal) =>
      chatJSON<unknown>(
        [
          { role: "system", content: outlineCoachPrompt(project.bible.fields, draftNow) },
          ...hist,
          { role: "user", content: text },
        ],
        { role: "writer", signal },
      ),
    );
    if (!r.ok) return;
    const rec = asRecord(r.value);
    const reply = asStr(rec?.reply) || "（本轮模型未给出可读回复，可直接重发上一条）";
    const draftVal = rec?.draft;
    if (draftVal && typeof draftVal === "object" && !Array.isArray(draftVal)) {
      setCoachDraft(draftVal as MasterOutlineJson);
    }
    setCoachMsgs((m) => [...m, { role: "assistant", content: reply }]);
    if (rec?.ready === true || asStr(rec?.phase) === "ready") {
      setInfo("大纲草稿已就绪：可「应用到大纲树」「AI 填充细纲」（先应用）或「导出为世界书」。");
    }
  };

  const applyCoachDraft = async () => {
    if (!coachDraft) return;
    if (
      nodes.length > 0 &&
      !window.confirm("当前大纲非空：草稿将追加为新卷根节点（不动既有节点）。继续？")
    ) {
      return;
    }
    try {
      const mapped = masterToNodes(coachDraft, projectId, {
        charactersByName: charactersByNameMap(characters),
        uid: repos.uid,
      });
      if (mapped.nodes.length === 0) {
        setError("草稿里还没有任何卷/幕，先继续访谈再应用。");
        return;
      }
      await db.outlineNodes.bulkAdd(mapped.nodes);
      await reload();
      setWarnings(mapped.warnings);
      setInfo(
        `草稿已应用 ${mapped.nodes.length} 个节点（卷/章/幕，状态=草案）。` +
          (mapped.logline ? `logline：${mapped.logline}` : ""),
      );
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** 细纲填充：为树上所有「空幕」批量生成节拍（先应用草稿；逐个串行，可停止） */
  const fillBeats = async () => {
    if (!project) return;
    const targets = preorder(nodes).filter((n) => n.level === "scene" && n.beats.length === 0);
    if (targets.length === 0) {
      setInfo("没有空节拍的幕：请先「应用到大纲树」，或所有幕已有节拍（细纲已填或手动写过）。");
      return;
    }
    const fields = project.bible.fields;
    const pre = preorder(nodes);
    const allScenes = pre.filter((n) => n.level === "scene");
    let filled = 0;
    const r = await runAI(`AI 填充细纲（共 ${targets.length} 幕）`, async (signal) => {
      for (const sc of targets) {
        if (signal.aborted) break;
        const prev = allScenes[allScenes.indexOf(sc) - 1] ?? null;
        const value = await chatJSON<unknown>(
          sceneBeatsPrompt(sc, lineageOf(nodes, sc.id).filter((x) => x.id !== sc.id), prev, fields),
          { role: "writer", signal },
        );
        const rec = asRecord(value);
        const beats = beatsFromStrings(Array.isArray(rec?.beats) ? (rec?.beats as unknown[]) : [], repos.uid);
        if (beats.length > 0) {
          await db.outlineNodes.update(sc.id, { beats, updatedAt: Date.now() });
          filled++;
        }
      }
      return filled;
    });
    if (r.ok) {
      await reload();
      setInfo(`AI 填充细纲完成：${filled}/${targets.length} 幕已写入节拍（停止或失败的幕保持空，可重试）。`);
    }
  };

  /** 草稿直通成书：不建树也能导出剧情推进世界书（幕条目无节拍，仅目标与时空） */
  const exportDraftBook = () => {
    const scenes = draftToBookScenes(coachDraft);
    if (scenes.length === 0) {
      setError("大纲草稿里还没有可用的幕：继续访谈到有幕标题再导出。");
      return;
    }
    try {
      const { json, result } = outlineBookJson(scenes, { projectId });
      setBookOut({
        json,
        lines: result.scenesByEntry.map(
          (s) => `${s.scene}｜触发：${s.keys.join("、")}${s.fallback ? "（弱触发 → 蓝灯常驻）" : ""}`,
        ),
        fileName: `worldbook-剧情推进-${project?.title || "project"}.json`,
        skippedDone: result.skippedDone,
      });
      setInfo("已从访谈草稿导出世界书——下载/复制见下方「剧情世界书」面板的结果区。");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  useEffect(() => {
    setSelectedId(null);
    void reload();
  }, [reload]);

  // 总纲任务终结 → 播报并刷新；首次进入时已终结的任务记为已知
  // （它们的结果早已落库，上面的 reload 已把数据带进来，不重复播报）。
  // 若任务在「离开本页期间」完成，重进时同样不会重复弹窗，但数据是新的。
  useEffect(() => {
    const finished = jobs.filter(
      (j) => j.kind === "master" && j.projectId === projectId && j.status !== "running",
    );
    if (announcedRef.current === null) {
      announcedRef.current = new Set(finished.map((j) => j.id));
      return;
    }
    for (const j of finished) {
      if (announcedRef.current.has(j.id)) continue;
      announcedRef.current.add(j.id);
      void reload();
      if (j.status === "done") {
        setInfo(
          "总纲生成完成（明细见右下「生成监视」窗）" +
            (j.log.includes("⚠") ? "；有映射警告，建议查看" : ""),
        );
      } else if (j.status === "error") {
        setError(`总纲生成失败：${j.error ?? "未知错误"}`);
      } else {
        setInfo("总纲生成已停止（未写入任何节点）。");
      }
    }
  }, [jobs, projectId, reload]);

  // ---------- 全局 AI 执行器：一个忙碌态、一个可停止的 AbortController ----------

  function stop() {
    abortRef.current?.abort();
  }

  async function runAI<T>(
    label: string,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<AiResult<T>> {
    if (busy) {
      window.alert(`「${busy}」正在进行中，请等待完成或先点「停止」。`);
      return { ok: false };
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy(label);
    setError("");
    try {
      const value = await fn(ctrl.signal);
      return { ok: true, value };
    } catch (e) {
      if (isAbort(e)) setInfo(`已停止：${label}`);
      else setError(`${label}失败：${errMsg(e)}`);
      return { ok: false };
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  }

  // ---------- 工具栏 1：生成总纲（后台任务：切页不打断，右下监视窗实时可见） ----------

  function generateMaster() {
    if (!project) return;
    if (runningMaster) {
      window.alert("本项目的总纲生成正在后台进行（右下角「生成监视」窗可查看，切页不会中断）。");
      return;
    }
    if (
      nodes.length > 0 &&
      !window.confirm("当前大纲非空：生成总纲将追加新卷根节点（不动既有节点）。继续？")
    ) {
      return;
    }
    const vc = Number.parseInt(volumeCount, 10);
    const req = {
      structure,
      volumeCount: Number.isNaN(vc) || vc <= 0 ? undefined : vc,
      hint: hint.trim() || undefined,
    };
    // 启动瞬间快照：之后离开本页、甚至改表单都不影响这个任务
    const fieldsSnapshot = project.bible.fields;
    const byName = charactersByNameMap(characters);
    startJob({
      kind: "master",
      label: `生成总纲 · ${structure}`,
      projectId,
      task: async (ctx) => {
        ctx.note(
          `提交请求：结构 ${req.structure}` +
            (req.volumeCount ? ` · 期望 ${req.volumeCount} 卷` : "") +
            (req.hint ? ` · 提示「${req.hint}」` : ""),
        );
        ctx.note("── 模型输出（流式） ──");
        const value = await chatJSON<unknown>(
          masterOutlinePrompt(fieldsSnapshot, req),
          { role: "writer", signal: ctx.signal, onDelta: ctx.onDelta },
        );
        ctx.note("── 输出结束，映射为大纲树 ──");
        const mapped = masterToNodes(value, projectId, {
          charactersByName: byName,
          uid: repos.uid,
        });
        if (mapped.nodes.length === 0) {
          throw new Error("总纲映射结果为空（没有可导入的卷），未写入任何节点");
        }
        await db.outlineNodes.bulkAdd(mapped.nodes);
        ctx.note(
          `已写入 ${mapped.nodes.length} 个节点（卷/章/幕，状态=草案）` +
            (mapped.logline ? `；logline：${mapped.logline}` : ""),
        );
        for (const w of mapped.warnings) ctx.note(`⚠ ${w}`);
      },
    });
    setWarnings([]);
    setError("");
    setInfo("总纲生成已转入后台：切换页面不会中断，进度见右下角「生成监视」窗；完成后自动写入大纲树。");
  }

  // ---------- 工具栏 2：下一幕提案 ----------

  async function proposeNext() {
    if (!project) return;
    const pre = preorder(nodes);
    const chapters = pre.filter((n) => n.level === "chapter");
    if (chapters.length === 0) {
      window.alert("大纲里还没有「章」。请先用「生成总纲」（或手动建卷/章），再提案下一幕。");
      return;
    }
    const spine = pre.filter((n) => n.level === "volume" || n.level === "chapter");
    const doneScenes = pre.filter(
      (n) => n.level === "scene" && (n.status === "tested" || n.status === "locked"),
    );
    const r = await runAI("下一幕提案", (signal) =>
      chatJSON<unknown>(nextScenePrompt(spine, doneScenes, project.bible.fields, ledger), {
        role: "writer",
        signal,
      }),
    );
    if (!r.ok) return;
    // 防御式校验：json.scene 必须是对象且 title 非空，否则拒绝入库
    const sceneRec = asRecord(asRecord(r.value)?.scene);
    const title = asStr(sceneRec?.title);
    if (!sceneRec || !title) {
      setError("下一幕提案形态非法（缺 scene.title），已拒绝入库。可重试一次。");
      return;
    }
    // 默认挂载点：最后一个已上演幕的父章；没有则第一个章
    const byId = new Map(nodes.map((n) => [n.id, n]));
    let mount = chapters[0].id;
    const lastDone = doneScenes[doneScenes.length - 1];
    const lastParent = lastDone?.parentId ? byId.get(lastDone.parentId) : undefined;
    if (lastParent && lastParent.level === "chapter") mount = lastParent.id;
    setSceneProp({
      title,
      intent: asStr(sceneRec.intent),
      location: asStr(sceneRec.location),
      timepoint: asStr(sceneRec.timepoint),
      castNames: asStrArray(sceneRec.cast),
      beats: asStrArray(sceneRec.beats),
    });
    setMountChapterId(mount);
    setInfo("");
  }

  async function createSceneFromProposal() {
    if (!sceneProp) return;
    const chapter = nodes.find((n) => n.id === mountChapterId && n.level === "chapter");
    if (!chapter) {
      window.alert("请先选择一个有效的挂载章节。");
      return;
    }
    const siblings = childrenOf(nodes, chapter.id); // flow 纯函数：order 升序
    const now = Date.now();
    const map = charactersByNameMap(characters);
    const cast: string[] = [];
    const unmatched: string[] = [];
    for (const nm of sceneProp.castNames) {
      const cid = map[nm];
      if (cid) cast.push(cid);
      else unmatched.push(nm);
    }
    const node: OutlineNode = {
      id: repos.uid(),
      projectId,
      parentId: chapter.id,
      level: "scene",
      order: siblings.length ? siblings[siblings.length - 1].order + 1 : 0,
      title: sceneProp.title,
      intent: sceneProp.intent,
      beats: beatsFromStrings(sceneProp.beats, repos.uid),
      cast,
      location: sceneProp.location || undefined,
      timepoint: sceneProp.timepoint || undefined,
      foreshadows: [],
      status: "draft",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.outlineNodes.add(node);
    setSceneProp(null);
    setWarnings(unmatched.map((nm) => `角色「${nm}」未在人物库中匹配到，未写入本场 cast。`));
    setInfo(`已在章「${chapter.title}」下创建幕「${node.title}」。`);
    setSelectedId(node.id);
    await reload();
  }

  // ---------- 工具栏 3：导出 Markdown ----------

  function exportMarkdown() {
    if (nodes.length === 0) {
      window.alert("大纲为空，没有可导出的内容。");
      return;
    }
    const md = treeToMarkdown(nodes);
    const url = URL.createObjectURL(new Blob([md], { type: "text/markdown;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "outline.md";
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---------- 树：手动加子节点（层级下拉 = validatePlacement 允许的组合） ----------

  function allowedLevels(parent: OutlineNode | null): OutlineLevel[] {
    return LEVEL_ORDER.filter(
      (l) => validatePlacement({ level: l }, parent ? { id: parent.id, level: parent.level } : null) === null,
    );
  }

  function openAddMenu(parent: OutlineNode | null) {
    const allowed = allowedLevels(parent);
    if (allowed.length === 0) return;
    const pid = parent ? parent.id : null;
    setAddMenu((cur) => (cur && cur.parentId === pid ? null : { parentId: pid })); // 再点一次 = 收起
    setAddLevel(allowed[0]);
    setAddTitle("");
  }

  async function confirmAdd() {
    if (!addMenu) return;
    const t = addTitle.trim();
    if (!t) {
      window.alert("请输入新节点标题。");
      return;
    }
    const parent = addMenu.parentId ? nodes.find((n) => n.id === addMenu.parentId) ?? null : null;
    const bad = validatePlacement({ level: addLevel }, parent ? { id: parent.id, level: parent.level } : null);
    if (bad) {
      window.alert(bad);
      return;
    }
    try {
      const created = await repos.addNode(projectId, parent ? parent.id : null, addLevel, t);
      setAddMenu(null);
      setSelectedId(created.id);
      await reload();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  function renderAddForm(parent: OutlineNode | null, depth: number): ReactNode {
    const allowed = allowedLevels(parent);
    return (
      <div className="row" style={{ paddingLeft: depth * 18 + 26, paddingTop: 4, paddingBottom: 4 }}>
        <select value={addLevel} onChange={(e) => setAddLevel(e.target.value as OutlineLevel)}>
          {allowed.map((l) => (
            <option key={l} value={l}>
              {LEVEL_NAMES[l]}
              {parent ? `（挂于${LEVEL_NAMES[parent.level]}下）` : "（根）"}
            </option>
          ))}
        </select>
        <input
          autoFocus
          value={addTitle}
          placeholder="新节点标题"
          style={{ flex: 1, minWidth: 120 }}
          onChange={(e) => setAddTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void confirmAdd();
          }}
        />
        <button className="primary" onClick={() => void confirmAdd()}>
          添加
        </button>
        <button onClick={() => setAddMenu(null)}>取消</button>
      </div>
    );
  }

  // ---------- 树渲染：flow.childrenOf 对本地数组递归 + 缩进 ----------

  function renderTree(parentId: string | null, depth: number): ReactNode[] {
    return childrenOf(nodes, parentId).map((n) => (
      <div key={n.id}>
        <div
          className="row"
          style={{
            paddingLeft: depth * 18 + 6,
            paddingRight: 6,
            paddingTop: 4,
            paddingBottom: 4,
            cursor: "pointer",
            borderRadius: 6,
            background: selectedId === n.id ? "#efe6d8" : undefined,
          }}
          onClick={() => setSelectedId(n.id)}
        >
          <span style={{ width: 20, textAlign: "center" }}>{LEVEL_ICONS[n.level]}</span>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {n.title || "（未命名）"}
          </span>
          {n.beats.length > 0 && <span className="muted">{n.beats.length}拍</span>}
          <span style={badge}>{STATUS_LABELS[n.status]}</span>
          <button
            title={`在「${n.title}」下添加子节点`}
            style={{ padding: "0 8px" }}
            onClick={(e) => {
              e.stopPropagation();
              openAddMenu(n);
            }}
          >
            ＋
          </button>
        </div>
        {addMenu && addMenu.parentId === n.id ? renderAddForm(n, depth + 1) : null}
        {renderTree(n.id, depth + 1)}
      </div>
    ));
  }

  // ---------- 节点编辑器的持久操作（保存/状态/删除/AI 共写调用） ----------

  async function saveNode(id: string, patch: OutlineNodePatch) {
    try {
      await repos.updateNode(id, patch); // revision 由 repos 自增
      setInfo("已保存（修订 +1）。");
      await reload();
    } catch (e) {
      setError(`保存失败：${errMsg(e)}`);
    }
  }

  async function changeStatus(id: string, to: OutlineStatus) {
    try {
      await repos.setNodeStatus(id, to);
      setInfo(`状态 → ${STATUS_LABELS[to]}。`);
      await reload();
    } catch (e) {
      setError(`状态流转失败：${errMsg(e)}`);
    }
  }

  async function deleteSubtree(node: OutlineNode) {
    try {
      await repos.removeNodeCascade(projectId, node.id);
      if (selectedId === node.id) setSelectedId(null);
      setInfo(`已删除「${node.title}」及其子树。`);
      await reload();
    } catch (e) {
      setError(`删除失败：${errMsg(e)}`);
    }
  }

  async function runDiscuss(node: OutlineNode): Promise<DiscussProposal | null> {
    if (!project) return null;
    const ancestors = lineageOf(nodes, node.id).slice(0, -1); // 根→…→父（不含自身）
    const r = await runAI("AI 共写", (signal) =>
      chatJSON<unknown>(nodeDiscussPrompt(node, ancestors, project.bible.fields), {
        role: "writer",
        signal,
      }),
    );
    if (!r.ok) return null;
    const rec = asRecord(r.value);
    const nrec = asRecord(rec?.node);
    const rawFo = Array.isArray(rec?.foreshadows) ? rec.foreshadows : [];
    return {
      comment: asStr(rec?.comment),
      title: asStr(nrec?.title),
      intent: asStr(nrec?.intent),
      beats: asStrArray(nrec?.beats),
      foreshadows: rawFo
        .map(asRecord)
        .filter((x): x is Record<string, unknown> => x !== null)
        .map((f) => ({ setup: asStr(f.setup), payoffIn: asStr(f.payoffIn) }))
        .filter((f) => f.setup),
    };
  }

  // ---------- 渲染 ----------

  const selected = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  const selectedPath = selected
    ? lineageOf(nodes, selected.id).slice(0, -1).map((n) => n.title).join(" › ")
    : "";
  const chapterOptions = preorder(nodes).filter((n) => n.level === "chapter");

  return (
    <div>
      {error && <div style={{ ...errBox, marginBottom: 10 }}>❌ {error}</div>}
      {warnings.length > 0 && (
        <div style={{ ...warnBox, marginBottom: 10 }}>
          <div className="row">
            <strong>⚠ 映射警告（{warnings.length}）</strong>
            <button style={{ padding: "0 8px" }} onClick={() => setWarnings([])}>
              知道了
            </button>
          </div>
          <ul style={{ margin: "6px 0 0" }}>
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {info && <p className="muted">{info}</p>}

      <div style={twoCol}>
        {/* ================= 左列 ================= */}
        <div>
          <div className="panel">
            <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
              <label className="field">
                <span>结构骨架</span>
                <select value={structure} onChange={(e) => setStructure(e.target.value as OutlineStructure)}>
                  {STRUCTURES.map((s) => (
                    <option key={s} value={s}>
                      {STRUCTURE_NAMES[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>卷数（可空）</span>
                <input
                  type="number"
                  min={1}
                  style={{ width: 88 }}
                  value={volumeCount}
                  onChange={(e) => setVolumeCount(e.target.value)}
                />
              </label>
              <label className="field" style={{ flex: 1, minWidth: 200 }}>
                <span>补充要求（可选 hint）</span>
                <textarea rows={2} value={hint} onChange={(e) => setHint(e.target.value)} placeholder="如：第一卷必须以一场背叛收尾" />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10, flexWrap: "wrap" }}>
              <button
                className="primary"
                disabled={busy !== null || runningMaster !== undefined || !project}
                onClick={generateMaster}
              >
                {runningMaster ? "🧭 总纲生成中…" : "🧭 生成总纲"}
              </button>
              {runningMaster && (
                <button onClick={() => abortJob(runningMaster.id)}>⏹ 停止总纲</button>
              )}
              <button disabled={busy !== null || !project} onClick={() => void proposeNext()}>
                🎬 下一幕提案
              </button>
              <button disabled={nodes.length === 0} onClick={exportMarkdown}>
                ⬇ 导出 Markdown
              </button>
              {busy && (
                <>
                  <span className="muted">⏳ {busy}中…</span>
                  <button onClick={stop}>⏹ 停止</button>
                </>
              )}
            </div>
          </div>

          {/* ---------- 大纲共创访谈：AI 一边访谈一边搭大纲（粗放：只定盘子） ---------- */}
          <div className="panel">
            <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
              <strong>✍️ 大纲共创访谈</strong>
              <span className="muted">每轮一问，只谈整体大纲/走向/细纲题目；草稿随对话生长</span>
              {coachStats.s > 0 && (
                <span className="muted" style={{ marginLeft: "auto" }}>
                  草稿：{coachStats.v} 卷 · {coachStats.c} 章 · {coachStats.s} 幕
                </span>
              )}
            </div>
            {coachMsgs.length > 0 && (
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                {coachMsgs.map((m, i) => (
                  <div
                    key={i}
                    style={{
                      alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                      maxWidth: "92%",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      padding: "6px 10px",
                      borderRadius: 10,
                      border: "1px solid var(--line)",
                      background: m.role === "user" ? "var(--accent)" : "var(--panel)",
                      color: m.role === "user" ? "#fff" : undefined,
                      fontSize: 13,
                    }}
                  >
                    {m.content}
                  </div>
                ))}
                {busy && <div className="muted" style={{ fontSize: 12 }}>⏳ {busy}中…</div>}
              </div>
            )}
            <label className="field">
              <span>聊聊想法、回答上一问 — Enter 发送，Shift+Enter 换行</span>
              <textarea
                rows={2}
                value={coachInput}
                disabled={!!busy}
                placeholder="例：双男主，一桩旧案把两人重新卷进去，结局想要两败俱伤但留一线"
                onChange={(e) => setCoachInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void sendCoach();
                  }
                }}
                style={{ width: "100%" }}
              />
            </label>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="primary" onClick={() => void sendCoach()} disabled={!!busy || !coachInput.trim() || !project}>
                {busy ? "进行中…" : "发送"}
              </button>
              <button onClick={stop} disabled={!busy}>
                停止
              </button>
              <button onClick={() => void applyCoachDraft()} disabled={!!busy || coachStats.s === 0}>
                应用到大纲树
              </button>
              <button onClick={() => void fillBeats()} disabled={!!busy}>
                🪄 AI 填充细纲
              </button>
              <button onClick={exportDraftBook} disabled={!!busy || coachStats.s === 0}>
                🥁 导出为世界书
              </button>
              {coachMsgs.length > 0 && !busy && (
                <button
                  onClick={() => {
                    setCoachMsgs([]);
                    setCoachDraft(null);
                  }}
                >
                  重新开始
                </button>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              访谈只定盘子（节拍恒为空）。之后三选一或全要：「应用到大纲树」把草稿追加为新卷（状态=草案）；
              「AI 填充细纲」为树上所有空幕批量生成 3~8 拍（先应用再填，可停止可重试）；
              「导出为世界书」不建树直接把当前草稿导出为剧情推进世界书（幕条目仅含目标与时空）。
            </p>
          </div>

          <div className="panel">
            <div className="row" style={{ marginBottom: 8 }}>
              <strong>大纲树</strong>
              <span className="muted">{loaded ? `${nodes.length} 个节点` : "读取中…"}</span>
              <button onClick={() => openAddMenu(null)}>＋ 新卷</button>
            </div>
            {addMenu && addMenu.parentId === null ? renderAddForm(null, 0) : null}
            {loaded && nodes.length === 0 && (
              <p className="muted">还没有节点：用「生成总纲」批量生成，或「＋ 新卷」手动搭骨架。</p>
            )}
            <div style={{ maxHeight: "60vh", overflowY: "auto" }}>{renderTree(null, 0)}</div>
          </div>

          {/* ---------- 剧情世界书（ST · 幕粒度 · 不绑角色） ---------- */}
          <div className="panel">
            <div className="row" style={{ marginBottom: 6 }}>
              <strong>🥁 剧情世界书（ST）</strong>
              <span className="muted">{`每幕一条导演指令 · 不绑角色（用 {{char}}/{{user}} 变量）`}</span>
            </div>
            {loaded && bookScenes.length === 0 ? (
              <p className="muted">还没有「幕」节点：先生成总纲或手动搭建，再回来成书。</p>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 4, flexWrap: "wrap" }}>
                  <button onClick={() => setBookSel(new Set(bookScenes.map((n) => n.id)))}>全选</button>
                  <button onClick={() => setBookSel(new Set())}>清空</button>
                  <span className="muted">
                    已选 {bookScenes.filter((n) => bookSel.has(n.id)).length}/{bookScenes.length} 幕
                  </span>
                  <label className="row" style={{ gap: 4, fontSize: 13, color: "var(--text)" }}>
                    <input
                      type="checkbox"
                      checked={bookIncludeDone}
                      onChange={(e) => setBookIncludeDone(e.target.checked)}
                    />
                    包含已演完的幕
                  </label>
                </div>
                <div style={{ maxHeight: 190, overflowY: "auto", marginBottom: 8 }}>
                  {bookScenes.map((n) => {
                    const path = lineageOf(nodes, n.id)
                      .filter((x) => x.level !== "scene")
                      .map((x) => x.title)
                      .join(" › ");
                    return (
                      <label
                        key={n.id}
                        className="row"
                        style={{ gap: 6, fontSize: 13, color: "var(--text)", padding: "2px 0" }}
                      >
                        <input type="checkbox" checked={bookSel.has(n.id)} onChange={() => toggleBookScene(n.id)} />
                        <span>{n.title || "（无名幕）"}</span>
                        <span className="muted">
                          {n.beats.length}拍{isScenePlayed(n) ? " · 已演完" : ""}
                        </span>
                        <span className="muted" style={{ marginLeft: "auto" }}>
                          {path}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <button className="primary" onClick={buildOutlineBook}>
                  🥁 生成世界书
                </button>
                {bookOut && (
                  <div style={{ marginTop: 8 }}>
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        background: "var(--bg)",
                        padding: 10,
                        borderRadius: 8,
                        fontSize: 12,
                        margin: 0,
                        maxHeight: 180,
                        overflowY: "auto",
                      }}
                    >
                      {`共 ${bookOut.lines.length} 幕成条${bookOut.skippedDone ? `（跳过已演完 ${bookOut.skippedDone} 幕）` : ""}\n${bookOut.lines.join("\n")}`}
                    </pre>
                    <div className="row" style={{ marginTop: 6 }}>
                      <button onClick={() => downloadText(bookOut.fileName, bookOut.json)}>下载</button>
                      <button onClick={() => void copyBook()}>复制 JSON</button>
                    </div>
                    <p className="muted" style={{ fontSize: 12 }}>
                      在 ST「世界信息 World Info」面板导入即可整本管理。诚实说明 ST 原生机制：条目命中后 sticky
                      停留期内无需再命中也会注入，且 AI 演拍时会自己写进触发词、冷却后可能再次命中——所以参数取了
                      短停留(3)+长冷却(10)、同轮多幕命中时后幕优先，指令文案声明「演出即作废」由模型自律兜底。
                      真正可靠的「已演退场」发生在场间：复盘标记节拍已演 → 重新生成 → 覆盖导入（书名固定可直接替换旧书）。
                      指令不定义角色，换任何角色卡都即时可用。
                    </p>
                  </div>
                )}
                {info && bookOut && <p className="muted">{info}</p>}
              </>
            )}
          </div>

          {sceneProp && (
            <div className="panel" style={warnBox}>
              <strong>🎬 下一幕提案</strong>
              <p style={{ margin: "6px 0" }}>
                <b>{sceneProp.title}</b>
                {sceneProp.intent ? <> — {sceneProp.intent}</> : null}
              </p>
              {(sceneProp.location || sceneProp.timepoint || sceneProp.castNames.length > 0) && (
                <p className="muted" style={{ margin: "4px 0" }}>
                  {[
                    sceneProp.location ? `地点：${sceneProp.location}` : "",
                    sceneProp.timepoint ? `时间：${sceneProp.timepoint}` : "",
                    sceneProp.castNames.length ? `出场：${sceneProp.castNames.join("、")}` : "",
                  ]
                    .filter(Boolean)
                    .join("｜")}
                </p>
              )}
              {sceneProp.beats.length > 0 && (
                <ol style={{ margin: "4px 0" }}>
                  {sceneProp.beats.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ol>
              )}
              <label className="field">
                <span>挂载章节（默认：最后一个已上演幕的父章）</span>
                <select value={mountChapterId} onChange={(e) => setMountChapterId(e.target.value)}>
                  {chapterOptions.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {lineageOf(nodes, ch.id).map((x) => x.title).join(" › ")}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="primary" onClick={() => void createSceneFromProposal()}>
                  ➕ 创建幕节点
                </button>
                <button onClick={() => setSceneProp(null)}>放弃提案</button>
              </div>
            </div>
          )}
        </div>

        {/* ================= 右列：节点编辑器 ================= */}
        {selected ? (
          <NodeEditor
            // revision 进 key：保存/应用提案后重挂载，草稿态与库内同步
            key={`${selected.id}:${selected.revision}`}
            node={selected}
            characters={characters}
            busy={busy !== null}
            pathLabel={selectedPath}
            onSave={(patch) => saveNode(selected.id, patch)}
            onStatus={(to) => changeStatus(selected.id, to)}
            onDelete={() => deleteSubtree(selected)}
            onDiscuss={() => runDiscuss(selected)}
          />
        ) : (
          <div className="panel">
            <p className="muted">{loaded ? "点击左侧节点进行编辑；或用工具栏生成总纲 / 提案下一幕。" : "正在读取…"}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// 节点编辑器
// ============================================================
interface EditorProps {
  node: OutlineNode;
  characters: Character[];
  busy: boolean;
  /** 祖先链标题面包屑（不含自身） */
  pathLabel: string;
  onSave: (patch: OutlineNodePatch) => Promise<void>;
  onStatus: (to: OutlineStatus) => Promise<void>;
  onDelete: () => Promise<void>;
  onDiscuss: () => Promise<DiscussProposal | null>;
}

function NodeEditor({ node, characters, busy, pathLabel, onSave, onStatus, onDelete, onDiscuss }: EditorProps) {
  const [title, setTitle] = useState(node.title);
  const [intent, setIntent] = useState(node.intent);
  const [location, setLocation] = useState(node.location ?? "");
  const [timepoint, setTimepoint] = useState(node.timepoint ?? "");
  const [cast, setCast] = useState<string[]>(node.cast);
  const [beatsText, setBeatsText] = useState(node.beats.map((b) => b.text).join("\n"));
  const [foreshadows, setForeshadows] = useState<ForeshadowLink[]>(() => node.foreshadows.map((f) => ({ ...f })));
  const [proposal, setProposal] = useState<DiscussProposal | null>(null);

  // ---------- beats 行号对位保存规则 ----------
  // 编辑器是一列纯文本行，落库时按「行号 i」与 node.beats[i] 对位：
  //   i < 原拍数 且该行非空 → 沿用原 beat.id（{ ...旧, text }），done 标记保留；
  //   i < 原拍数 且该行为空 → 该行视为删除（原第 i 拍删除）；
  //   i ≥ 原拍数           → 尾部新增行，统一交给 beatsFromStrings 发新 id（空行被其过滤）。
  // 注意：在中间插行会把下移的原拍「移位保旧 id」——即旧 id 跟着行号走，不跟着文字走。
  function buildBeats(): Beat[] {
    const lines = beatsText.split("\n");
    const beats: Beat[] = [];
    const headCount = Math.min(lines.length, node.beats.length);
    for (let i = 0; i < headCount; i++) {
      const text = lines[i].trim();
      if (text) beats.push({ ...node.beats[i], text });
    }
    beats.push(...beatsFromStrings(lines.slice(node.beats.length), repos.uid));
    return beats;
  }

  async function save() {
    const t = title.trim();
    if (!t) {
      window.alert("标题不能为空。");
      return;
    }
    await onSave({
      title: t,
      intent: intent.trim(),
      location: location.trim() || undefined,
      timepoint: timepoint.trim() || undefined,
      cast,
      beats: buildBeats(),
      foreshadows: foreshadows
        .filter((f) => f.setup.trim())
        .map((f) => ({
          ...f,
          setup: f.setup.trim(),
          payoffIn: f.payoffIn?.trim() ? f.payoffIn.trim() : null,
        })),
    });
  }

  // ---------- 状态机条：唯一硬规则 = 锁定前必须 tested ----------

  async function clickStatus(to: OutlineStatus) {
    if (to === node.status) return;
    if (!canTransition(node.status, to)) {
      window.alert(`不能从「${STATUS_LABELS[node.status]}」直接切到「${STATUS_LABELS[to]}」：锁定前必须先试跑。`);
      return;
    }
    await onStatus(to);
  }

  async function removeSubtree() {
    if (!window.confirm(`删除「${node.title}」及其全部子节点？不可恢复。`)) return;
    await onDelete();
  }

  // ---------- AI 共写 ----------

  async function discuss() {
    const p = await onDiscuss();
    if (p) setProposal(p);
  }

  async function applyProposal() {
    if (!proposal) return;
    const patch: OutlineNodePatch = {};
    if (proposal.title) patch.title = proposal.title; // 非空才覆盖
    if (proposal.intent) patch.intent = proposal.intent;
    patch.beats = beatsFromStrings(proposal.beats, repos.uid);
    patch.foreshadows = [
      ...node.foreshadows,
      ...proposal.foreshadows.map((f) => ({
        id: repos.uid(),
        setup: f.setup,
        payoffIn: f.payoffIn || null,
        status: "planted" as const, // 提案带入的伏笔一律先标 planted
      })),
    ];
    await onSave(patch); // 保存后 revision+1，key 变化重挂载 → 提案框随之收起
  }

  function toggleCast(id: string, on: boolean) {
    setCast((prev) => (on ? [...prev, id] : prev.filter((x) => x !== id)));
  }
  function setFo(i: number, patch: Partial<ForeshadowLink>) {
    setForeshadows((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  }

  return (
    <div className="panel">
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 6 }}>
        <strong>
          {LEVEL_ICONS[node.level]} {LEVEL_NAMES[node.level]}编辑
        </strong>
        <span className="muted">
          {pathLabel ? `${pathLabel} › ` : ""}
          {node.title || "（未命名）"} ｜ 修订 {node.revision}
        </span>
      </div>

      {/* 状态条 */}
      <div className="row" style={{ flexWrap: "wrap", marginBottom: 10 }}>
        {ALL_STATUSES.map((s) => (
          <button key={s} className={node.status === s ? "tab active" : "tab"} onClick={() => void clickStatus(s)}>
            {STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      <label className="field">
        <span>标题</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span>叙事意图 intent（这一幕/章要完成什么）</span>
        <textarea rows={3} value={intent} onChange={(e) => setIntent(e.target.value)} />
      </label>
      <div className="grid2">
        <label className="field">
          <span>地点 location</span>
          <input value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className="field">
          <span>故事内时间 timepoint</span>
          <input value={timepoint} onChange={(e) => setTimepoint(e.target.value)} />
        </label>
      </div>

      <div style={{ ...fieldStack, marginTop: 8 }}>
        <span>出场人物 cast（来自项目人物库）</span>
        {characters.length === 0 ? (
          <span className="muted">人物库为空：先到「人物卡」页添加人物。</span>
        ) : (
          <div className="row" style={{ flexWrap: "wrap" }}>
            {characters.map((c) => (
              <label key={c.id} className="row" style={{ gap: 4, fontSize: 13, color: "var(--text)" }}>
                <input type="checkbox" checked={cast.includes(c.id)} onChange={(e) => toggleCast(c.id, e.target.checked)} />
                {c.name || "（无名）"}
              </label>
            ))}
          </div>
        )}
      </div>

      <label className="field">
        <span>节拍 beats（一行一拍；行号对位：改行文字保留原节拍 id，尾部加行自动发新 id，删行即删）</span>
        <textarea rows={8} value={beatsText} onChange={(e) => setBeatsText(e.target.value)} placeholder={"节拍1：谁做了什么、造成什么局面\n节拍2：…"} />
      </label>

      <div style={{ ...fieldStack, marginTop: 8 }}>
        <span>伏笔 foreshadows（setup → 预期回收）</span>
        {foreshadows.map((f, i) => (
          <div key={f.id} className="row" style={{ flexWrap: "wrap" }}>
            <input style={{ flex: 2, minWidth: 140 }} value={f.setup} placeholder="伏笔内容" onChange={(e) => setFo(i, { setup: e.target.value })} />
            <select value={f.status} onChange={(e) => setFo(i, { status: e.target.value as ForeshadowLink["status"] })}>
              <option value="planted">未回收 planted</option>
              <option value="paid">已回收 paid</option>
              <option value="abandoned">弃坑 abandoned</option>
            </select>
            <input style={{ flex: 1, minWidth: 100 }} value={f.payoffIn ?? ""} placeholder="回收于（节点/描述）" onChange={(e) => setFo(i, { payoffIn: e.target.value })} />
            <button title="删除该伏笔" onClick={() => setForeshadows((fs) => fs.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
        ))}
        <div>
          <button
            onClick={() =>
              setForeshadows((fs) => [...fs, { id: repos.uid(), setup: "", payoffIn: null, status: "planted" }])
            }
          >
            ＋ 添加伏笔
          </button>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <button className="primary" onClick={() => void save()}>
          💾 保存
        </button>
        <button disabled={busy} onClick={() => void discuss()}>
          🤝 AI 共写提案
        </button>
        {busy && <span className="muted">⏳ AI 进行中…可在左栏点「停止」</span>}
        <button onClick={() => void removeSubtree()}>🗑 删除子树</button>
      </div>

      {proposal && (
        <div style={{ ...warnBox, marginTop: 12 }}>
          <strong>🤝 AI 共写提案</strong>
          <p style={{ margin: "6px 0" }}>{proposal.comment || <span className="muted">（无点评）</span>}</p>
          {proposal.title && (
            <p style={{ margin: "4px 0" }}>
              <b>标题：</b>
              {proposal.title}
            </p>
          )}
          {proposal.intent && (
            <p style={{ margin: "4px 0" }}>
              <b>意图：</b>
              {proposal.intent}
            </p>
          )}
          {proposal.beats.length > 0 ? (
            <ol style={{ margin: "4px 0" }}>
              {proposal.beats.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ol>
          ) : (
            <p className="muted" style={{ margin: "4px 0" }}>（提案未给节拍；应用后将清空现有节拍）</p>
          )}
          {proposal.foreshadows.length > 0 && (
            <ul style={{ margin: "4px 0" }}>
              {proposal.foreshadows.map((f, i) => (
                <li key={i}>
                  伏笔：{f.setup}
                  {f.payoffIn ? ` → 预期回收于 ${f.payoffIn}` : ""}
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" onClick={() => void applyProposal()}>
              ✅ 应用提案
            </button>
            <button onClick={() => setProposal(null)}>忽略</button>
          </div>
        </div>
      )}
    </div>
  );
}
