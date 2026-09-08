// ============================================================
// story-studio M3/v6 — 大纲工作台（删繁就简：只剩两个视图）
// ✍️ 手动编写：左树（⠿ 拖拽柄排序/改父，落点校验走 flow/outline.moveNodePlan）
//              + 右编辑器（字段/状态机/移动到…/删除子树）
// 💬 对话创作：整页聊天 + 右侧草稿只读预览树；每轮显示草稿真实变化，
//              AI 空口宣称完成而草稿无变化 → 黄条戳穿（反「只说不做」红线）。
// 约定：树渲染/层级/状态机全部走 flow/outline 纯函数；读经 repos 门面；
//       批量插入直用 db 单例（规格指定）；排序落库走 repos.applyMovePlan
//       （revision 不动——编辑器 key=id:revision 重挂载契约，防吞未保存草稿）。
// ============================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
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
import { copyToClipboard, downloadText, errMsg, isAbort } from "../core/uiUtils";
import {
  beatsFromStrings,
  canTransition,
  childrenOf,
  draftDiff,
  LEVEL_NAMES,
  LEVEL_ORDER,
  lineageOf,
  masterToNodes,
  moveNodePlan,
  preorder,
  STATUS_NAMES as STATUS_LABELS,
  subtreeIds,
  treeToMarkdown,
  validatePlacement,
  type DraftDiff,
  type DropZone,
  type MasterOutlineJson,
} from "../flow/outline.js";
import { chatJSON } from "../ai/client";
import { outlineCoachPrompt, sceneBeatsPrompt } from "../ai/prompts";
import { draftToBookScenes, outlineBookJson, type OutlineBookScene } from "../flow/outlinebook";
import { ledgerFacts } from "../flow/snapshot";
import { loadProgress, makeDebouncer, saveProgress } from "../flow/progress";
import { claimsCompletion } from "../core/claims";

// ---------- 展示常量 ----------

const LEVEL_ICONS: Record<OutlineLevel, string> = {
  volume: "📚",
  chapter: "📖",
  scene: "🎬",
  beat: "•",
};
// 状态中文名单一来源：flow/outline.STATUS_NAMES（页面不再复制第二份）
const ALL_STATUSES: OutlineStatus[] = ["idea", "draft", "refined", "tested", "locked"];

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

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ---------- 页面本地形态 ----------

/** runAI 的结果包装：区分「AI 失败/被停止」与「合法返回了 null 等假值」 */
type AiResult<T> = { ok: true; value: T } | { ok: false };

/** 对话创作的一条消息：diff=本轮草稿真实变化；claimed=宣称完成；badDraft=本轮没回有效草稿 */
interface CoachMsg {
  role: "user" | "assistant";
  content: string;
  diff?: DraftDiff;
  claimed?: boolean;
  badDraft?: boolean;
}

/** 进度桶里的紧凑消息形态（localStorage 截尾存储） */
interface SavedMsg {
  role: "user" | "assistant";
  content: string;
  d?: [number, number, number];
  claimed?: boolean;
  bad?: boolean;
}

function charactersByNameMap(chars: Character[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const c of chars) if (c.name) m[c.name] = c.id;
  return m;
}

/** draftDiff 的三项是否全 0（=本轮界面未发生创作） */
function isZeroDiff(d: DraftDiff): boolean {
  return d.volumes === 0 && d.chapters === 0 && d.scenes === 0;
}

/** 草稿三层计数（预览面板计数行用；flow 的 countDraft 未导出，页面本地数） */
function countDraft(d: MasterOutlineJson | null): { v: number; c: number; s: number } {
  let v = 0;
  let c = 0;
  let s = 0;
  for (const vol of Array.isArray(d?.volumes) ? d.volumes : []) {
    v++;
    for (const ch of Array.isArray(vol?.chapters) ? vol.chapters : []) {
      c++;
      s += Array.isArray(ch?.scenes) ? ch.scenes.length : 0;
    }
  }
  return { v, c, s };
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

  // 顶层视图：手动编写 / 对话创作（进度记忆记住上次）
  const [view, setView] = useState<"manual" | "coach">("manual");

  // 全局 AI 忙碌态：所有 chatJSON 共用一个 AbortController + 一个停止按钮
  const [busy, setBusy] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // 切页即卸载（App 条件渲染）：在飞的 runAI 请求随之中止，不让它悄悄烧 token。
  useEffect(() => () => abortRef.current?.abort(), []);

  // 行尾「＋」加子节点菜单（parentId=null ⇔ 根级新卷）
  const [addMenu, setAddMenu] = useState<{ parentId: string | null } | null>(null);
  const [addLevel, setAddLevel] = useState<OutlineLevel>("volume");
  const [addTitle, setAddTitle] = useState("");

  // 拖拽落点提示（id=null ⇔ 根级空白区投放；zone=三态）
  const [tip, setTip] = useState<{ id: string | null; zone: DropZone } | null>(null);

  // 导出菜单 / 剧情世界书面板（v6：面板收进「⬇ 导出」菜单，不再常驻）
  const [openExport, setOpenExport] = useState(false);
  const [bookPanelOpen, setBookPanelOpen] = useState(false);
  const [bookSel, setBookSel] = useState<Set<string>>(new Set());
  const [bookIncludeDone, setBookIncludeDone] = useState(false);
  const [bookOut, setBookOut] = useState<{
    json: string;
    lines: string[];
    fileName: string;
    skippedDone: number;
  } | null>(null);
  const bookInit = useRef(false);

  // 对话创作：AI 每轮一问一边搭草稿（粗放：整体大纲/走向/细纲题目，beats 恒空）
  const [coachMsgs, setCoachMsgs] = useState<CoachMsg[]>([]);
  const [coachDraft, setCoachDraft] = useState<MasterOutlineJson | null>(null);
  const [coachInput, setCoachInput] = useState("");
  // 「应用到大纲树」一步弹窗 + 顺手填充节拍勾选
  const [appModal, setAppModal] = useState(false);
  const [fillOnApply, setFillOnApply] = useState(true);

  const reload = useCallback(async (): Promise<OutlineNode[]> => {
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
      return rows;
    } catch (e) {
      setError(errMsg(e));
      return [];
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  // ---------- 剧情世界书（ST · 幕粒度 · 不绑角色；入口在「⬇ 导出」菜单） ----------

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
      setError("先在清单里勾选至少一幕。");
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

  // ---------- 对话创作：访谈搭草稿 → 弹窗应用（可顺手填节拍）/ 直通成书 ----------

  const coachStats = countDraft(coachDraft);

  /** textArg：气泡「重试本轮」传入该轮的用户原文；省略=取输入框当前内容 */
  const sendCoach = async (textArg?: string) => {
    if (!project) return;
    const text = (textArg ?? coachInput).trim();
    if (!text) return;
    const hist = coachMsgs.map((m) => ({ role: m.role, content: m.content }));
    const draftPrev = coachDraft;
    if (textArg === undefined) setCoachInput("");
    setCoachMsgs((m) => [...m, { role: "user", content: text }]);
    const r = await runAI("共创访谈", (signal) =>
      chatJSON<unknown>(
        [
          { role: "system", content: outlineCoachPrompt(project.bible.fields, draftPrev, ledgerFacts(ledger, nodes)) },
          ...hist,
          { role: "user", content: text },
        ],
        { role: "writer", signal },
      ),
    );
    if (!r.ok) return;
    const rec = asRecord(r.value);
    const reply = asStr(rec?.reply) || "（本轮模型未给出可读回复，可点「重试本轮」）";
    const draftVal = rec?.draft;
    // 反「只说不做」解析层：不信任模型——draft 无效则保留旧草稿并记 badDraft，界面如实说"未发生创作"
    const draftOk = !!draftVal && typeof draftVal === "object" && !Array.isArray(draftVal);
    const nextDraft = draftOk ? (draftVal as MasterOutlineJson) : draftPrev;
    if (draftOk) setCoachDraft(nextDraft);
    setCoachMsgs((m) => [
      ...m,
      {
        role: "assistant",
        content: reply,
        diff: draftDiff(draftPrev, nextDraft),
        claimed: claimsCompletion(reply),
        badDraft: !draftOk,
      },
    ]);
    if (rec?.ready === true || asStr(rec?.phase) === "ready") {
      setInfo("AI 认为盘子已齐：核对右侧草稿预览，满意后点「应用到大纲树」（永不自动写入）。");
    }
  };

  /**
   * 细纲填充：给指定空幕批量生成节拍（逐个串行，可停止；中途停止已写入保留）。
   * 必须走 repos.updateNode（revision+1）：编辑器 key 含 revision，会重挂载同步草稿态。
   * 直写 db 不动 revision → 打开着的编辑器仍持旧副本，下一次保存静默抹掉 AI 填的节拍。
   */
  const fillBeats = async (targets: OutlineNode[], rows: OutlineNode[]) => {
    if (!project || targets.length === 0) return;
    const fields = project.bible.fields;
    const allScenes = preorder(rows).filter((n) => n.level === "scene");
    let filled = 0;
    const r = await runAI(`AI 填充细纲（共 ${targets.length} 幕）`, async (signal) => {
      for (const sc of targets) {
        if (signal.aborted) break;
        const prev = allScenes[allScenes.indexOf(sc) - 1] ?? null;
        const value = await chatJSON<unknown>(
          sceneBeatsPrompt(sc, lineageOf(rows, sc.id).filter((x) => x.id !== sc.id), prev, fields),
          { role: "writer", signal },
        );
        const rec = asRecord(value);
        const beats = beatsFromStrings(Array.isArray(rec?.beats) ? (rec?.beats as unknown[]) : [], repos.uid);
        if (beats.length > 0) {
          await repos.updateNode(sc.id, { beats });
          filled++;
        }
      }
      return filled;
    });
    // 部分写入也要可见：中途出错/停止时已写入的幕立即刷新上树
    await reload();
    if (r.ok) {
      setInfo(`AI 填充细纲完成：${filled}/${targets.length} 幕已写入节拍（停止或失败的幕保持空，可重试）。`);
    }
  };

  /** 「应用到大纲树」弹窗确认：bulkAdd 直通 + 可勾选顺手填充这些新空幕 */
  async function applyDraft(fill: boolean) {
    if (!coachDraft) return;
    setAppModal(false);
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
      const rows = await reload();
      setWarnings(mapped.warnings);
      setInfo(
        `草稿已应用 ${mapped.nodes.length} 个节点（卷/章/幕，状态=草案）。` +
          (mapped.logline ? `logline：${mapped.logline}` : ""),
      );
      if (fill) {
        const newIds = new Set(
          mapped.nodes.filter((n) => n.level === "scene" && n.beats.length === 0).map((n) => n.id),
        );
        const newScenes = rows.filter((n) => newIds.has(n.id));
        if (newScenes.length > 0) await fillBeats(newScenes, rows);
      }
    } catch (e) {
      setError(errMsg(e));
    }
  }

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
      setInfo("已从访谈草稿导出世界书——下载/复制见下方结果区。");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  useEffect(() => {
    setSelectedId(null);
    void reload();
  }, [reload]);

  // v3.1-② 进度记忆（v6 扩容）：视图 + 选中节点 + 访谈输入框/消息/草稿，数据就绪后恢复一次。
  // 全部防御式解析：旧桶缺新键=默认值；校验保存的 selectedId 仍在现有节点里（防已删节点）。
  const selRestoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || selRestoredFor.current === projectId) return;
    selRestoredFor.current = projectId;
    const saved = loadProgress<{
      selectedId?: string;
      coachInput?: string;
      view?: string;
      msgs?: SavedMsg[];
      draft?: unknown;
    }>("outline", projectId);
    if (!saved) return;
    if (saved.view === "coach") setView("coach");
    if (saved.selectedId && nodes.some((n) => n.id === saved.selectedId)) setSelectedId(saved.selectedId);
    if (typeof saved.coachInput === "string" && saved.coachInput) setCoachInput(saved.coachInput.slice(0, 4000));
    if (Array.isArray(saved.msgs)) {
      const msgs: CoachMsg[] = [];
      for (const item of saved.msgs) {
        if (!item || (item.role !== "user" && item.role !== "assistant") || typeof item.content !== "string") continue;
        const m: CoachMsg = { role: item.role, content: item.content.slice(0, 2000) };
        if (Array.isArray(item.d) && item.d.length === 3 && item.d.every((x) => typeof x === "number")) {
          m.diff = { volumes: item.d[0], chapters: item.d[1], scenes: item.d[2] };
        }
        if (item.claimed === true) m.claimed = true;
        if (item.bad === true) m.badDraft = true;
        msgs.push(m);
      }
      setCoachMsgs(msgs.slice(-60));
    }
    const dr = asRecord(saved.draft);
    if (dr) setCoachDraft(saved.draft as MasterOutlineJson);
  }, [loaded, nodes, projectId]);
  // 进度持久化：coachInput 每击键都会触发整个进度回写 localStorage，改为 400ms 防抖；
  // 卸载/关页前 flushNow 兜底，不丢最后一笔。coachMsgs 截尾 60 条/单条 2000 字；
  // coachDraft 序列化后 ≤200KB 才入桶（超限宁可这轮不存草稿，不整桶写失败）。
  const progressWriteRef = useRef<() => void>(() => {});
  progressWriteRef.current = () => {
    if (!loaded || selRestoredFor.current !== projectId) return;
    const draftStr = coachDraft ? JSON.stringify(coachDraft) : "";
    saveProgress("outline", projectId, {
      view,
      selectedId,
      coachInput: coachInput.slice(0, 4000),
      msgs: coachMsgs.slice(-60).map((m) => ({
        role: m.role,
        content: m.content.slice(0, 2000),
        ...(m.diff ? { d: [m.diff.volumes, m.diff.chapters, m.diff.scenes] as [number, number, number] } : {}),
        ...(m.claimed ? { claimed: true } : {}),
        ...(m.badDraft ? { bad: true } : {}),
      })),
      ...(draftStr && draftStr.length <= 200000 ? { draft: coachDraft } : {}),
    });
  };
  const progressDeb = useRef(makeDebouncer(400, () => progressWriteRef.current()));
  useEffect(() => {
    progressDeb.current.bump();
  }, [loaded, projectId, selectedId, coachInput, view, coachMsgs, coachDraft]);
  useEffect(() => {
    const flush = () => progressDeb.current.flushNow();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      progressDeb.current.flushNow();
    };
  }, []);

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

  // ---------- 拖拽排序（手动编写核心）：plan → 单事务落库（revision 不动） ----------

  /** 落点三态：行上/下缘 25% = before/after（插为兄弟），中段 50% = child（成为其子级） */
  function zoneOf(e: ReactDragEvent): DropZone {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientY - r.top) / Math.max(1, r.height);
    return rel < 0.25 ? "before" : rel > 0.75 ? "after" : "child";
  }

  async function applyPlan(dragId: string, targetId: string | null, zone: DropZone) {
    const res = moveNodePlan(nodes, dragId, targetId, zone);
    if (!res) return; // 悬空或原地无变化：静默
    if ("error" in res) {
      setError(res.error);
      return;
    }
    const t = nodes.find((n) => n.id === dragId);
    try {
      await repos.applyMovePlan(res.updates);
      await reload();
      setInfo(`已移动「${t?.title || dragId}」（换序=改叙事顺序：导出/试跑/剧场的幕序都会跟着变）。`);
    } catch (e) {
      setError(`移动失败：${errMsg(e)}`);
    }
  }

  // ---------- 工具栏：导出 Markdown ----------

  function exportMarkdown() {
    if (nodes.length === 0) {
      window.alert("大纲为空，没有可导出的内容。");
      return;
    }
    // downloadText：带 body 挂载的下载（Firefox 无此不触发）+ 统一 revoke，勿再手搓
    downloadText("outline.md", treeToMarkdown(nodes));
    setOpenExport(false);
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

  // ---------- 树渲染：flow.childrenOf 对本地数组递归 + 缩进 + 拖拽落点 ----------

  /** 落点视觉：before/after 画行缘插入线；child 整行描边高亮 */
  function tipStyle(id: string): CSSProperties {
    if (!tip || tip.id !== id) return {};
    if (tip.zone === "before") return { boxShadow: "inset 0 2px 0 0 var(--accent)" };
    if (tip.zone === "after") return { boxShadow: "inset 0 -2px 0 0 var(--accent)" };
    return { outline: "2px solid var(--accent)", background: "rgba(176, 124, 60, 0.08)" };
  }

  function renderTree(parentId: string | null, depth: number): ReactNode[] {
    return childrenOf(nodes, parentId).map((n) => (
      <div key={n.id}>
        <div
          className="row"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData("text/plain", n.id); // Firefox 必需 setData
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => setTip(null)}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "move";
            const z = zoneOf(e);
            if (tip?.id !== n.id || tip?.zone !== z) setTip({ id: n.id, zone: z });
          }}
          onDragLeave={(e) => {
            e.stopPropagation();
            setTip((t) => (t && t.id === n.id ? null : t));
          }}
          onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation();
            const dragId = e.dataTransfer.getData("text/plain");
            const z = zoneOf(e);
            setTip(null);
            if (dragId && dragId !== n.id) void applyPlan(dragId, n.id, z);
          }}
          style={{
            paddingLeft: depth * 18 + 6,
            paddingRight: 6,
            paddingTop: 4,
            paddingBottom: 4,
            cursor: "pointer",
            borderRadius: 6,
            background: selectedId === n.id ? "#efe6d8" : undefined,
            ...tipStyle(n.id),
          }}
          onClick={() => setSelectedId(n.id)}
        >
          <span title="拖动：改顺序或换父级（上/下缘=插为兄弟，中段=成为子级）" style={{ cursor: "grab", width: 16, textAlign: "center" }}>
            ⠿
          </span>
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
        {addMenu && addMenu.parentId === n.id ? renderAddForm(n, depth) : null}
        {renderTree(n.id, depth + 1)}
      </div>
    ));
  }

  // ---------- 节点编辑器的持久操作（保存/状态/删除） ----------

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

  // ---------- 渲染共用：世界书结果区（勾幕成书 / 草稿直通成书 共用 bookOut） ----------

  function renderBookResult(): ReactNode {
    if (!bookOut) return null;
    return (
      <div className="panel" style={{ marginTop: 8 }}>
        <div className="row">
          <strong style={{ fontSize: 13 }}>生成结果</strong>
          <span className="muted">
            {bookOut.lines.length} 条幕指令{bookOut.skippedDone > 0 ? `（已跳过演完 ${bookOut.skippedDone} 幕）` : ""}
          </span>
          <button onClick={() => downloadText(bookOut.fileName, bookOut.json)}>⬇ 下载 {bookOut.fileName}</button>
          <button onClick={() => void copyBook()}>复制 JSON</button>
        </div>
        <ul className="muted" style={{ fontSize: 12, margin: "6px 0" }}>
          {bookOut.lines.slice(0, 12).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
          {bookOut.lines.length > 12 && <li>…（共 {bookOut.lines.length} 条，全量见 JSON）</li>}
        </ul>
        <textarea readOnly rows={6} style={{ width: "100%", fontSize: 12 }} value={bookOut.json} />
      </div>
    );
  }

  // ---------- 主渲染 ----------

  const selected = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  const selectedPath = selected
    ? lineageOf(nodes, selected.id).slice(0, -1).map((n) => n.title).join(" › ")
    : "";
  // 编辑器「移动到…」候选：章→卷、幕→章；排除自身子树（防环兜底在 moveNodePlan 里还有第二道）
  const moveOptions = (() => {
    if (!selected || selected.level === "volume") return [];
    const want: OutlineLevel = selected.level === "chapter" ? "volume" : "chapter";
    const sub = new Set(subtreeIds(nodes, selected.id));
    return preorder(nodes)
      .filter((n) => n.level === want && !sub.has(n.id))
      .map((n) => ({ id: n.id, label: lineageOf(nodes, n.id).map((x) => x.title).join(" › ") }));
  })();

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

      {/* 顶层视图切换 */}
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={view === "manual" ? "tab active" : "tab"} onClick={() => setView("manual")}>
          ✍️ 手动编写
        </button>
        <button className={view === "coach" ? "tab active" : "tab"} onClick={() => setView("coach")}>
          💬 对话创作
        </button>
        {busy && (
          <span className="row" style={{ marginLeft: "auto" }}>
            <span className="muted">⏳ {busy}中…</span>
            <button onClick={stop}>⏹ 停止</button>
          </span>
        )}
      </div>

      {view === "manual" ? (
        <div style={twoCol}>
          {/* ================= 左列：工具条 + 树 + 导出面板 ================= */}
          <div>
            <div className="panel">
              <div className="row" style={{ flexWrap: "wrap" }}>
                <strong>大纲树</strong>
                <span className="muted">{loaded ? `${nodes.length} 个节点 · ⠿ 拖行排序/换父级` : "读取中…"}</span>
                <button onClick={() => openAddMenu(null)}>＋ 新卷</button>
                <span style={{ position: "relative" }}>
                  <button onClick={() => setOpenExport((o) => !o)} disabled={!loaded}>
                    ⬇ 导出 ▾
                  </button>
                  {openExport && (
                    <div
                      className="panel"
                      style={{ position: "absolute", right: 0, top: "100%", zIndex: 20, minWidth: 230, margin: 0 }}
                    >
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        <button onClick={exportMarkdown} disabled={nodes.length === 0}>
                          大纲 Markdown
                        </button>
                        <button
                          onClick={() => {
                            setBookPanelOpen((o) => !o);
                            setOpenExport(false);
                          }}
                          disabled={bookScenes.length === 0}
                        >
                          {bookPanelOpen ? "关闭" : "打开"}剧情世界书（勾幕成书）
                        </button>
                        <button
                          onClick={() => {
                            setOpenExport(false);
                            setView("coach");
                          }}
                          disabled={coachStats.s === 0}
                          title="切到对话创作视图，从当前草稿导出"
                        >
                          从对话草稿导出世界书
                        </button>
                      </div>
                    </div>
                  )}
                </span>
              </div>
            </div>

            <div className="panel">
              {addMenu && addMenu.parentId === null ? renderAddForm(null, 0) : null}
              {loaded && nodes.length === 0 && (
                <p className="muted">还没有节点：切到「💬 对话创作」聊出一个盘子，或「＋ 新卷」手动搭骨架。</p>
              )}
              {/* 空白投放区：把「卷」拖到这里 = 追加为根级新卷（非法投放由 moveNodePlan 拒绝） */}
              <div
                style={{ maxHeight: "60vh", overflowY: "auto", ...(tip?.id === null ? { outline: "2px dashed var(--accent)", outlineOffset: -2 } : {}) }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setTip({ id: null, zone: "child" });
                }}
                onDragLeave={() => setTip((t) => (t && t.id === null ? null : t))}
                onDrop={(e) => {
                  e.preventDefault();
                  const dragId = e.dataTransfer.getData("text/plain");
                  setTip(null);
                  if (dragId) void applyPlan(dragId, null, "child");
                }}
              >
                {renderTree(null, 0)}
              </div>
            </div>

            {/* ---------- 剧情世界书（ST）：v6 起经「⬇ 导出」菜单开关 ---------- */}
            {bookPanelOpen && (
              <div className="panel">
                <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
                  <strong>🥁 剧情世界书（ST）</strong>
                  <span className="muted">每幕一条导演指令 · 不绑角色（用 {"{{char}}"}/{"{{user}}"} 变量）</span>
                </div>
                {bookScenes.length === 0 ? (
                  <p className="muted">还没有「幕」节点：先搭建或聊出大纲，再回来成书。</p>
                ) : (
                  <>
                    <div className="row" style={{ marginBottom: 4, flexWrap: "wrap" }}>
                      <button onClick={() => setBookSel(new Set(bookScenes.map((n) => n.id)))}>全选</button>
                      <button onClick={() => setBookSel(new Set())}>清空</button>
                      <span className="muted">
                        已选 {bookScenes.filter((n) => bookSel.has(n.id)).length}/{bookScenes.length} 幕
                      </span>
                      <label className="muted" style={{ marginLeft: "auto", fontSize: 12 }}>
                        <input type="checkbox" checked={bookIncludeDone} onChange={(e) => setBookIncludeDone(e.target.checked)} /> 包含已演完的幕
                      </label>
                    </div>
                    <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 13 }}>
                      {bookScenes.map((n) => (
                        <label key={n.id} style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                          <input type="checkbox" checked={bookSel.has(n.id)} onChange={() => toggleBookScene(n.id)} />
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {lineageOf(nodes, n.id).map((x) => x.title).join(" › ")}
                          </span>
                          {isScenePlayed(n) && <span className="muted">已演完</span>}
                        </label>
                      ))}
                    </div>
                    <div className="row" style={{ marginTop: 8 }}>
                      <button className="primary" onClick={buildOutlineBook}>生成剧情世界书</button>
                    </div>
                    {renderBookResult()}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ================= 右列：节点编辑器 ================= */}
          {selected ? (
            <NodeEditor
              // revision 进 key：保存后重挂载，草稿态与库内同步
              key={`${selected.id}:${selected.revision}`}
              node={selected}
              characters={characters}
              busy={busy !== null}
              pathLabel={selectedPath}
              moveOptions={moveOptions}
              onSave={(patch) => saveNode(selected.id, patch)}
              onStatus={(to) => changeStatus(selected.id, to)}
              onDelete={() => deleteSubtree(selected)}
              onMove={(parentId) => applyPlan(selected.id, parentId, "child")}
            />
          ) : (
            <div className="panel">
              <p className="muted">{loaded ? "点击左侧节点进行编辑；⠿ 拖行柄可改顺序（上/下缘=插为兄弟，中段=成为子级）。" : "正在读取…"}</p>
            </div>
          )}
        </div>
      ) : (
        /* ================= 对话创作视图：左聊天右草稿预览 ================= */
        <div style={{ ...twoCol, gridTemplateColumns: "minmax(360px, 7fr) minmax(300px, 5fr)" }}>
          <div className="panel">
            <div className="row" style={{ marginBottom: 6, flexWrap: "wrap" }}>
              <strong>💬 对话创作</strong>
              <span className="muted">每轮一问，只谈整体大纲/走向/细纲题目；创作发生在右侧草稿预览里</span>
            </div>
            <div style={{ maxHeight: "56vh", overflowY: "auto" }}>
              {coachMsgs.length === 0 && (
                <p className="muted">
                  聊聊你想写什么——AI 每轮问一个关键问题，把答案长成右边的大纲草稿树。
                  每一轮它都必须真的动草稿，光说"已完成"会被当场戳穿。
                </p>
              )}
              {coachMsgs.map((m, i) => {
                // 该气泡对应的用户原文（往前找最近一条 user）——「重试本轮」用
                let prevUserText = "";
                for (let j = i - 1; j >= 0; j--) {
                  if (coachMsgs[j].role === "user") {
                    prevUserText = coachMsgs[j].content;
                    break;
                  }
                }
                const zeroDiff = m.diff ? isZeroDiff(m.diff) : false;
                const emptyPromise = m.role === "assistant" && m.claimed === true && zeroDiff;
                return (
                  <div
                    key={i}
                    style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start", marginBottom: 8 }}
                  >
                    <div
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
                      {m.role === "assistant" && m.diff && (
                        <div style={{ marginTop: 6, fontSize: 12 }}>
                          {zeroDiff ? (
                            <span className="muted">本轮草稿无变更</span>
                          ) : (
                            <span>
                              本轮草稿变化：
                              <span style={{ color: m.diff.volumes > 0 ? "#2e7d32" : m.diff.volumes < 0 ? "#c62828" : "var(--muted)" }}>
                                {m.diff.volumes > 0 ? `+${m.diff.volumes}` : m.diff.volumes}卷{" "}
                              </span>
                              <span style={{ color: m.diff.chapters > 0 ? "#2e7d32" : m.diff.chapters < 0 ? "#c62828" : "var(--muted)" }}>
                                {m.diff.chapters > 0 ? `+${m.diff.chapters}` : m.diff.chapters}章{" "}
                              </span>
                              <span style={{ color: m.diff.scenes > 0 ? "#2e7d32" : m.diff.scenes < 0 ? "#c62828" : "var(--muted)" }}>
                                {m.diff.scenes > 0 ? `+${m.diff.scenes}` : m.diff.scenes}幕
                              </span>
                            </span>
                          )}
                        </div>
                      )}
                      {m.role === "assistant" && m.badDraft && (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#8c2f22" }}>
                          本轮未返回有效草稿，界面未发生任何创作（草稿保留上一版）。
                        </div>
                      )}
                      {emptyPromise && (
                        <div style={{ ...warnBox, marginTop: 6, border: "1px solid #d97706" }}>
                          ⚠ AI 声称完成，但草稿<strong>没有任何变化</strong>——
                          <button
                            style={{ marginLeft: 6, padding: "1px 8px", fontSize: 12 }}
                            disabled={busy !== null || !prevUserText}
                            onClick={() => void sendCoach(prevUserText)}
                          >
                            重试本轮
                          </button>
                          或直接在下方纠正它。
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {busy && <div className="muted" style={{ fontSize: 12 }}>⏳ {busy}中…</div>}
            </div>
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
              {coachMsgs.length > 0 && !busy && (
                <button
                  onClick={() => {
                    if (!window.confirm("重新开始？将清空本项目的对话与草稿（大纲树已应用的节点不受影响）。")) return;
                    setCoachMsgs([]);
                    setCoachDraft(null);
                    setBookOut(null);
                  }}
                >
                  重新开始
                </button>
              )}
            </div>
            <p className="muted" style={{ fontSize: 12 }}>
              访谈只定盘子（节拍恒空）。盘子满意后点右侧「应用到大纲树」——弹窗列明细、确认才写入，可顺手为新建的幕生成节拍。
            </p>
          </div>

          {/* 右：草稿只读预览树 */}
          <div className="panel" style={{ position: "sticky", top: 8 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <strong>草稿预览</strong>
              {coachStats.s > 0 && (
                <span className="muted" style={{ marginLeft: "auto" }}>
                  {coachStats.v}卷 · {coachStats.c}章 · {coachStats.s}幕
                </span>
              )}
            </div>
            {coachStats.s === 0 && coachStats.v === 0 ? (
              <p className="muted">草稿还是空的——聊起来后这里会实时长出大纲树（📚卷 → 📖章 → 🎬幕）。</p>
            ) : (
              <div style={{ maxHeight: "48vh", overflowY: "auto", fontSize: 13 }}>
                {(Array.isArray(coachDraft?.volumes) ? coachDraft?.volumes : []).map((v, vi) => (
                  <div key={vi} style={{ marginBottom: 6 }}>
                    <div>
                      📚 {v?.title?.trim() || `第${vi + 1}卷`}
                      {v?.intent ? <span className="muted"> — {v.intent}</span> : null}
                    </div>
                    {(Array.isArray(v?.chapters) ? v.chapters : []).map((c, ci) => (
                      <div key={ci} style={{ paddingLeft: 18 }}>
                        <div>
                          📖 {c?.title?.trim() || `第${ci + 1}章`}
                          {c?.intent ? <span className="muted"> — {c.intent}</span> : null}
                        </div>
                        {(Array.isArray(c?.scenes) ? c.scenes : []).map((s, si) => (
                          <div key={si} style={{ paddingLeft: 18, color: "var(--muted)" }}>
                            🎬 {s?.title?.trim() || `第${si + 1}幕`}
                            {s?.intent ? <span> — {s.intent}</span> : null}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
              <button className="primary" onClick={() => setAppModal(true)} disabled={coachStats.s === 0}>
                ✅ 应用到大纲树…
              </button>
              <button onClick={exportDraftBook} disabled={coachStats.s === 0}>
                🥁 导出为世界书
              </button>
            </div>
            {renderBookResult()}
          </div>
        </div>
      )}

      {/* 「应用到大纲树」一步弹窗：列明细 + 可勾选顺手填节拍；ready 永不自动应用 */}
      {appModal && (
        <div
          onClick={() => setAppModal(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
        >
          <div className="panel" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: "92%", maxHeight: "72vh", overflowY: "auto" }}>
            <strong>应用到大纲树</strong>
            <p style={{ fontSize: 13 }}>
              将追加 <b>{coachStats.v}</b> 卷 / <b>{coachStats.c}</b> 章 / <b>{coachStats.s}</b> 幕（状态=草案，追加为新卷根节点，不动既有节点）。
            </p>
            <div className="muted" style={{ fontSize: 12, maxHeight: 160, overflowY: "auto" }}>
              {(Array.isArray(coachDraft?.volumes) ? coachDraft?.volumes : []).map((v, vi) => (
                <div key={vi}>📚 {v?.title?.trim() || `第${vi + 1}卷`}</div>
              ))}
            </div>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13, marginTop: 8 }}>
              <input type="checkbox" checked={fillOnApply} onChange={(e) => setFillOnApply(e.target.checked)} />
              应用后立即为这些新幕生成节拍（AI 串行，可中途停止，已写入保留）
            </label>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={() => void applyDraft(fillOnApply)}>确认应用</button>
              <button onClick={() => setAppModal(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
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
  /** 「移动到…」候选上级（已排除自身子树；空=不可移动，如卷） */
  moveOptions: { id: string; label: string }[];
  onSave: (patch: OutlineNodePatch) => Promise<void>;
  onStatus: (to: OutlineStatus) => Promise<void>;
  onDelete: () => Promise<void>;
  onMove: (parentId: string) => Promise<void>;
}

function NodeEditor({ node, characters, busy, pathLabel, moveOptions, onSave, onStatus, onDelete, onMove }: EditorProps) {
  const [title, setTitle] = useState(node.title);
  const [intent, setIntent] = useState(node.intent);
  const [location, setLocation] = useState(node.location ?? "");
  const [timepoint, setTimepoint] = useState(node.timepoint ?? "");
  const [cast, setCast] = useState<string[]>(node.cast);
  const [beatsText, setBeatsText] = useState(node.beats.map((b) => b.text).join("\n"));
  const [foreshadows, setForeshadows] = useState<ForeshadowLink[]>(() => node.foreshadows.map((f) => ({ ...f })));
  const [moveSel, setMoveSel] = useState(() => moveOptions[0]?.id ?? "");

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

      {/* v6：移动到…（改父级；同级排序用树行 ⠿ 拖拽。原生 DnD 不支持触屏，这里是键盘/精确修正兜底） */}
      {moveOptions.length > 0 && (
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            <span>移动到…（{LEVEL_NAMES[node.level]}改换上级；换序=改叙事顺序）</span>
            <select value={moveSel} onChange={(e) => setMoveSel(e.target.value)}>
              {moveOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button disabled={!moveSel || busy} onClick={() => moveSel && void onMove(moveSel)}>
            移到这里（末尾）
          </button>
        </div>
      )}

      <div style={{ ...fieldStack, marginTop: 8 }}>
        <span>出场人物 cast（来自本作品可用人物 = 自有 ∪「📦 资产」选用）</span>
        {characters.length === 0 ? (
          <span className="muted">可用人物为空：到顶层「👤 人物卡」页建卡，再到「📦 资产」页签选用。</span>
        ) : (
          <div className="row" style={{ flexWrap: "wrap", maxHeight: 120, overflowY: "auto" }}>
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
        {busy && <span className="muted">⏳ AI 进行中…可点顶部「停止」</span>}
        <button onClick={() => void removeSubtree()}>🗑 删除子树</button>
      </div>
    </div>
  );
}
