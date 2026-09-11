// ============================================================
// story-studio M2 — 构思访谈页
// 左·构思档案：分组字段 + 状态徽章 + 完成度进度条 + 行内编辑（stale 传导提示）
// 右·访谈聊天：流式对话 → extractJson 解析提案卡 → 勾选采纳后 merge 落库
// 约定：数据读写只经 store/repos 门面；状态机复用 flow/interview 纯函数；
//       每次落库前把「保存前快照」压入 bible.revisions（裁剪到最近 20 条）。
// ============================================================
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { BibleField, BibleFieldStatus, BibleRevision, ChatMessage, Character, LoreEntry, Persona, Project } from "../core/types";
import * as repos from "../store/repos";
import { bookSelState, toggleBookIds } from "../flow/library";
import { errMsg, isAbort } from "../core/uiUtils";
import { bibleProgress, firstFocus, mergeBibleUpdates } from "../flow/interview.js";
import {
  characterBriefBlock,
  interviewMaterialsBlock,
  interviewSystemPrompt,
  personaPromptBlock,
  type InterviewTurn,
} from "../ai/prompts";
import { chat } from "../ai/client";
import { extractJson } from "../ai/json";
import { loadProgress, makeDebouncer, saveProgress } from "../flow/progress";
import { claimsCompletion } from "../core/claims";

const MSG_LIMIT = 100; // 聊天记录 localStorage 上限
const REV_LIMIT = 20; // revisions 裁剪上限
const DRAFT_TEXT_MAX = 4000; // 进度记忆单段草稿上限（超大文本不入 localStorage）

// ---------- 页面本地类型 ----------

interface ProposalItem {
  key: string; // 字段键（valid=false 表示档案里不存在，采纳时会被 merge 忽略）
  value: string; // 建议值
  note: string; // AI 的更新理由
  status: "rough" | "confirmed"; // 可 radio 切换，默认 rough
  checked: boolean; // 勾选采纳
  valid: boolean;
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string; // user：输入原文；assistant：气泡正文（reply 或解析失败时的原文）
  round?: number; // assistant：访谈轮次（1 起，用于 revisions note）
  proposals?: ProposalItem[]; // assistant：本轮提案卡
  adopted?: boolean; // assistant：提案已采纳落库（卡片锁定）
}

// ---------- 展示常量 ----------

const STATUS_LABEL: Record<BibleFieldStatus, string> = {
  empty: "空缺",
  rough: "粗略",
  confirmed: "已确认",
  stale: "待复查",
};

const STATUS_STYLE: Record<BibleFieldStatus, CSSProperties> = {
  empty: { color: "var(--muted)", border: "1px solid var(--line)" },
  rough: { color: "var(--accent)", border: "1px solid var(--accent)" },
  confirmed: { color: "#2e7d32", border: "1px solid #2e7d32" },
  stale: { color: "#fff", background: "#d97706", border: "1px solid #d97706", fontWeight: 600 },
};

const badgeBase: CSSProperties = { fontSize: 12, lineHeight: "18px", borderRadius: 999, padding: "0 8px" };

// ---------- 工具函数 ----------

/** 按首次出现序分组（不依赖数组相邻性） */
function groupFields(fields: BibleField[]): { name: string; fields: BibleField[] }[] {
  const map = new Map<string, BibleField[]>();
  for (const f of fields) {
    const arr = map.get(f.group);
    if (arr) arr.push(f);
    else map.set(f.group, [f]);
  }
  return [...map.entries()].map(([name, fs]) => ({ name, fields: fs }));
}

// ---------- localStorage 读写（宽容解析，坏数据直接丢） ----------

function parseProposals(raw: unknown): ProposalItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProposalItem[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.value !== "string") continue;
    out.push({
      key: o.key,
      value: o.value,
      note: typeof o.note === "string" ? o.note : "",
      status: o.status === "confirmed" ? "confirmed" : "rough",
      checked: o.checked !== false,
      valid: o.valid === true,
    });
  }
  return out.length ? out : undefined;
}

function loadMessages(key: string): ChatMsg[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const out: ChatMsg[] = [];
    for (const item of data) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if ((o.role !== "user" && o.role !== "assistant") || typeof o.content !== "string") continue;
      const msg: ChatMsg = { role: o.role, content: o.content };
      if (typeof o.round === "number" && Number.isFinite(o.round)) msg.round = o.round;
      const proposals = o.role === "assistant" ? parseProposals(o.proposals) : undefined;
      if (proposals) msg.proposals = proposals;
      if (o.adopted === true) msg.adopted = true;
      out.push(msg);
    }
    return out.slice(-MSG_LIMIT);
  } catch {
    return [];
  }
}

// ============================================================
// 页面
// ============================================================

export function InterviewPage({ projectId }: { projectId: string }) {
  const storageKey = `story-studio.interview.${projectId}`;

  // ---- 左栏：构思档案 ----
  const [project, setProject] = useState<Project | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // 行内编辑草稿 key→文本
  const [staleNotes, setStaleNotes] = useState<Record<string, string[]>>({}); // 保存行 key→本轮 stale 的下游 key
  const [bibleError, setBibleError] = useState<string | null>(null);

  // ---- 右栏：访谈 ----
  const [messages, setMessages] = useState<ChatMsg[]>(() => loadMessages(storageKey));
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ---- v3.2 辅助选材：勾选的人物卡/世界书词条/用户人设（id 数组，升序存储） ----
  const [allChars, setAllChars] = useState<Character[]>([]);
  const [allLore, setAllLore] = useState<LoreEntry[]>([]);
  const [allBooks, setAllBooks] = useState<{ id: string; name: string }[]>([]); // v8-D3 世界书整本勾选用
  const [allPersonas, setAllPersonas] = useState<Persona[]>([]);
  const [matsError, setMatsError] = useState<string | null>(null);
  // 勾选集合按 id 升序存（顺序=注入顺序，与点选先后无关 → 提示词字节稳定，缓存可命中）
  const [sel, setSel] = useState<{ chars: string[]; lore: string[]; personas: string[] }>({
    chars: [],
    lore: [],
    personas: [],
  });

  const abortRef = useRef<AbortController | null>(null);
  const toastTimer = useRef<number | null>(null);
  const prevStorageKey = useRef(storageKey);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 载入项目（切换 projectId 时重新载入并清草稿）
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const p = await repos.getProject(projectId);
        if (!alive) return;
        setProject(p ?? null);
        setLoadError(p ? null : "未找到项目（可能已被删除）");
        setDrafts({});
        setStaleNotes({});
      } catch (e) {
        if (alive) setLoadError(errMsg(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  // v3.2 辅助选材：候选清单（人物卡/世界书随作品走，人设是全局库）。
  // 切作品时先清空旧候选，避免串项目的勾选残留。
  useEffect(() => {
    let alive = true;
    setAllChars([]);
    setAllLore([]);
    setAllBooks([]);
    setMatsError(null);
    void (async () => {
      try {
        const [chars, lore, personas, books] = await Promise.all([
          repos.listCharacters(projectId),
          repos.listLoreEntries(projectId),
          repos.listPersonas(),
          repos.listLoreBooks(),
        ]);
        if (!alive) return;
        setAllChars(chars);
        setAllLore(lore);
        setAllPersonas(personas);
        setAllBooks(books.map((b) => ({ id: b.id, name: b.name || "（未命名书）" })));
      } catch (e) {
        if (alive) setMatsError(errMsg(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectId]);

  // projectId 切换：中止在途请求，改读本项目的聊天记录
  useEffect(() => {
    if (prevStorageKey.current === storageKey) return;
    prevStorageKey.current = storageKey;
    abortRef.current?.abort();
    setStreaming(false);
    setMessages(loadMessages(storageKey));
    setChatError(null);
  }, [storageKey]);

  // 聊天记录持久化（上限 100 条；配额满只影响历史回看，不阻断操作）
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(messages.slice(-MSG_LIMIT)));
    } catch {
      /* 忽略 quota 异常 */
    }
  }, [storageKey, messages]);

  // ---- v3.1-② 进度记忆：未提交草稿（访谈输入框 + 行内字段编辑）数据就绪后恢复一次 ----
  // 就绪信号 = 已载入的 project 正是当前 projectId（切项目时旧 project 不满足，天然防串项目）。
  const dataReady = project !== null && project.id === projectId;
  const draftRestoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!dataReady || draftRestoredFor.current === projectId) return;
    draftRestoredFor.current = projectId;
    const saved = loadProgress<{
      inputDraft?: string;
      drafts?: Record<string, string>;
      sel?: Partial<{ chars: string[]; lore: string[]; personas: string[] }>;
    }>("interview", projectId);
    if (!saved) return;
    if (typeof saved.inputDraft === "string" && saved.inputDraft) {
      setInput(saved.inputDraft.slice(0, DRAFT_TEXT_MAX));
    }
    // v3.2 选材勾选恢复：原样收下 id（候选此刻可能还没加载完），真正的裁剪发生在
    // 派生计算里——只认候选中仍存在的 id，已删素材自然脱落，不报错。
    const s = saved.sel;
    if (s && typeof s === "object") {
      const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
      setSel({ chars: ids(s.chars), lore: ids(s.lore), personas: ids(s.personas) });
    }
    // 行内草稿逐个校验字段仍存在（防已删字段），空串不入
    const fieldKeys = new Set((project.bible.fields ?? []).map((f) => f.key));
    const drafts: Record<string, string> = {};
    if (saved.drafts && typeof saved.drafts === "object") {
      for (const [k, v] of Object.entries(saved.drafts)) {
        if (typeof v === "string" && v && fieldKeys.has(k)) drafts[k] = v.slice(0, DRAFT_TEXT_MAX);
      }
    }
    if (Object.keys(drafts).length > 0) setDrafts(drafts);
  }, [dataReady, projectId, project]);
  // 进度持久化：访谈输入每击键触发整个草稿回写，改为 400ms 防抖；
  // 卸载/关页前 flushNow 兜底，不丢最后一笔。
  const progressWriteRef = useRef<() => void>(() => {});
  progressWriteRef.current = () => {
    if (!dataReady || draftRestoredFor.current !== projectId) return;
    const slim: Record<string, string> = {};
    for (const [k, v] of Object.entries(drafts)) {
      if (v && v.trim()) slim[k] = v.slice(0, DRAFT_TEXT_MAX);
    }
    saveProgress("interview", projectId, {
      inputDraft: input.slice(0, DRAFT_TEXT_MAX),
      drafts: slim,
      sel,
    });
  };
  const progressDeb = useRef(makeDebouncer(400, () => progressWriteRef.current()));
  useEffect(() => {
    progressDeb.current.bump();
  }, [dataReady, projectId, input, drafts, sel]);
  useEffect(() => {
    const flush = () => progressDeb.current.flushNow();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      progressDeb.current.flushNow();
    };
  }, []);

  // 卸载：清 toast 定时器 + 中止在途流
  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
      abortRef.current?.abort();
    },
    [],
  );

  // 新消息滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // ---- 派生数据 ----
  const fields = project?.bible.fields ?? [];
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const labelOf = (k: string): string => byKey.get(k)?.label ?? k;
  const progress = Math.round(bibleProgress(fields) * 100);

  // ---- v3.2 选材勾选 → 注入块 ----
  // 顺序契约：一律按 id 升序（与点选先后无关）。勾选集合不变 ⇒ 块字节不变 ⇒
  // 该 system 消息在整段对话前缀里的位置稳定，供应商前缀缓存持续命中。
  const toggleSel = (kind: keyof typeof sel, id: string) =>
    setSel((s) => {
      const has = s[kind].includes(id);
      return { ...s, [kind]: has ? s[kind].filter((x) => x !== id) : [...s[kind], id] };
    });
  const materialsBlock = interviewMaterialsBlock({
    characters: allChars
      .filter((c) => sel.chars.includes(c.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((c) => ({ id: c.id, name: c.name, block: characterBriefBlock(c) })),
    lore: allLore
      .filter((e) => sel.lore.includes(e.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((e) => ({ id: e.id, comment: e.comment, content: e.content })),
    personas: allPersonas
      .filter((p) => sel.personas.includes(p.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((p) => ({ id: p.id, name: p.name, block: personaPromptBlock(p) })),
  });
  const selCount = sel.chars.length + sel.lore.length + sel.personas.length;
  // 规模化（v4 全局库 500+ 词条）：勾选态改 Set 查找；列内搜索过滤；<details> 收起不渲染条目。
  const selSets = useMemo(
    () => ({ chars: new Set(sel.chars), lore: new Set(sel.lore), personas: new Set(sel.personas) }),
    [sel],
  );
  const [matsOpen, setMatsOpen] = useState(false);
  const [matsQ, setMatsQ] = useState(""); // 三列共用一个过滤词（够用且省三个 state）
  const matsFilter = (label: string) => !matsQ || label.toLowerCase().includes(matsQ.toLowerCase());
  // v8-D3 世界书列按书分组：书名取书本体（散装/无书归「（未归册）」），书序=候选里首见序
  const loreGroups = useMemo(() => {
    const byBook = new Map<string, LoreEntry[]>();
    for (const e of allLore) {
      const bid = e.bookId ?? "";
      const list = byBook.get(bid) ?? [];
      list.push(e);
      byBook.set(bid, list);
    }
    const nameOf = new Map(allBooks.map((b) => [b.id, b.name]));
    return [...byBook.entries()].map(([bid, entries]) => ({
      bookId: bid || "__none__",
      name: (bid && nameOf.get(bid)) || "（未归册）",
      entries,
      entryIds: entries.map((e) => e.id),
    }));
  }, [allLore, allBooks]);
  const selBookCount = (ids: string[], set: Set<string>) => ids.reduce((n, id) => n + (set.has(id) ? 1 : 0), 0);

  // firstFocus = 当前问题焦点行；若「最近一轮未采纳的提案」已覆盖它，则高亮让位给提案卡
  const focus = firstFocus(fields);
  const lastOpenTurn = [...messages]
    .reverse()
    .find((m) => m.role === "assistant" && (m.proposals?.length ?? 0) > 0 && !m.adopted);
  const focusKey = focus && !lastOpenTurn?.proposals?.some((p) => p.key === focus.key) ? focus.key : null;

  // ---- 通用提示 ----
  const showToast = (text: string) => {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    setToast(text);
    toastTimer.current = window.setTimeout(() => setToast(null), 5000);
  };

  /** 落库 bible：把保存前快照压入 revisions（裁剪最近 20 条）并刷新页面状态 */
  const persistBible = async (
    snapshot: BibleField[],
    nextFields: BibleField[],
    note: string,
  ): Promise<void> => {
    if (!project) return;
    const rev: BibleRevision = { at: Date.now(), note, fields: snapshot };
    const updated = await repos.updateProject(project.id, {
      bible: { fields: nextFields, revisions: [rev, ...project.bible.revisions].slice(0, REV_LIMIT) },
    });
    if (updated) setProject(updated);
  };

  // ---- 左栏：手动编辑保存 ----
  const saveField = async (f: BibleField) => {
    if (!project) return;
    const raw = drafts[f.key];
    if (raw === undefined) return;
    const value = raw.trim();
    if (!value || value === f.value) return;
    try {
      const snapshot = project.bible.fields;
      const merged = mergeBibleUpdates(snapshot, [{ key: f.key, value, status: "confirmed" }]);
      await persistBible(snapshot, merged.fields, `手动编辑·${f.label}`);
      setDrafts((d) => {
        const n = { ...d };
        delete n[f.key];
        return n;
      });
      setStaleNotes((m) => {
        const n = { ...m };
        if (merged.staleKeys.length) n[f.key] = merged.staleKeys;
        else delete n[f.key];
        return n;
      });
      setBibleError(null);
    } catch (e) {
      setBibleError(`保存「${f.label}」失败：${errMsg(e)}`);
    }
  };

  // ---- 右栏：发送 ----
  /** textArg：气泡「重发上一条」传入该气泡对应的用户原文；省略=取输入框当前内容 */
  const send = async (textArg?: string) => {
    const text = (textArg ?? input).trim();
    if (!text || streaming || !project) return;
    const fieldsNow = project.bible.fields;
    const round = messages.filter((m) => m.role === "assistant").length + 1;
    const apiMessages: ChatMessage[] = [
      { role: "system", content: interviewSystemPrompt(fieldsNow) },
      // v3.2 选材块：钉成独立 system 条（不进聊天记录，每轮现拼）。
      // 勾选集不变 ⇒ 字节不变 ⇒ 该条及其前缀可被供应商缓存；字段表在上一条里，
      // 采纳提案本来就会作废缓存——选材的增删只多作废这一条之后的部分。
      ...(materialsBlock ? [{ role: "system" as const, content: materialsBlock }] : []),
      ...messages.map((m): ChatMessage => ({ role: m.role, content: m.content })),
      { role: "user", content: text },
    ];

    setMessages((ms) => [...ms, { role: "user", content: text }, { role: "assistant", content: "", round }]);
    setInput("");
    setChatError(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;

    /** 只修补最后一条 assistant 气泡（流式增量 / 收尾替换） */
    const patchLast = (patch: (m: ChatMsg) => ChatMsg) =>
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        if (!last || last.role !== "assistant") return ms;
        const next = [...ms];
        next[next.length - 1] = patch(last);
        return next;
      });
    /** 收尾时若末条 assistant 气泡为空（abort/出错前没吐字），直接移除空气泡 */
    const dropEmptyLast = () =>
      setMessages((ms) => {
        const last = ms[ms.length - 1];
        return last && last.role === "assistant" && !last.content ? ms.slice(0, -1) : ms;
      });

    try {
      const res = await chat(apiMessages, {
        role: "writer",
        signal: controller.signal,
        onDelta: (d) => patchLast((m) => ({ ...m, content: m.content + d })),
      });

      // 解析访谈 JSON：成功 → reply 作正文 + 提案卡；失败 → 原文整体作正文
      let bubble = res.content;
      let proposals: ProposalItem[] | undefined;
      try {
        const parsed: unknown = extractJson<InterviewTurn>(res.content);
        if (parsed && typeof parsed === "object") {
          const turn = parsed as Partial<InterviewTurn>;
          if (typeof turn.reply === "string" && Array.isArray(turn.updates)) {
            bubble = turn.reply.trim() ? turn.reply : res.content;
            const list: ProposalItem[] = [];
            for (const rawU of turn.updates as unknown[]) {
              if (!rawU || typeof rawU !== "object") continue;
              const u = rawU as Partial<InterviewTurn["updates"][number]>;
              const key = typeof u.key === "string" ? u.key.trim() : "";
              const value = typeof u.value === "string" ? u.value : "";
              if (!key || !value.trim()) continue;
              list.push({
                key,
                value,
                note: typeof u.note === "string" ? u.note : "",
                status: u.status === "confirmed" ? "confirmed" : "rough",
                checked: true,
                valid: fieldsNow.some((f) => f.key === key),
              });
            }
            proposals = list.length ? list : undefined;
          }
        }
      } catch {
        /* extractJson 失败：保留流式原文作气泡正文，无提案卡 */
      }
      patchLast((m) => (proposals ? { ...m, content: bubble, proposals } : { ...m, content: bubble }));
    } catch (e) {
      if (!isAbort(e)) setChatError(errMsg(e)); // AbortError=用户点「停止」，静默
      dropEmptyLast();
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  // ---- 右栏：提案卡交互 ----
  const updateProposal = (msgIdx: number, pIdx: number, patch: Partial<ProposalItem>) =>
    setMessages((ms) =>
      ms.map((m, i) =>
        i === msgIdx
          ? {
              ...m,
              proposals: (m.proposals ?? []).map((p, j) => (j === pIdx ? { ...p, ...patch } : p)),
            }
          : m,
      ),
    );

  const adoptProposals = async (msgIdx: number) => {
    if (!project) return;
    const msg = messages[msgIdx];
    if (!msg || msg.adopted) return;
    const chosen = (msg.proposals ?? []).filter((p) => p.checked && p.valid);
    if (!chosen.length) return;
    try {
      const snapshot = project.bible.fields;
      const merged = mergeBibleUpdates(
        snapshot,
        chosen.map((p) => ({ key: p.key, value: p.value, status: p.status })),
      );
      await persistBible(snapshot, merged.fields, `访谈·第${msg.round ?? "?"}轮`);
      setMessages((ms) => ms.map((m, i) => (i === msgIdx ? { ...m, adopted: true } : m)));
      const parts: string[] = [
        merged.changedKeys.length
          ? `已采纳 ${merged.changedKeys.length} 处改动：${merged.changedKeys.map(labelOf).join("、")}`
          : "无实际改动（值与状态均相同）",
      ];
      if (merged.staleKeys.length) parts.push(`已标记待复查：${merged.staleKeys.map(labelOf).join("、")}`);
      if (merged.ignored.length) parts.push(`已忽略：${merged.ignored.join("、")}`);
      showToast(parts.join("；"));
    } catch (e) {
      setChatError(`采纳落库失败：${errMsg(e)}`);
    }
  };

  const resetSession = () => {
    if (messages.length && !window.confirm("开始新会话？将清空本项目的聊天记录与未采纳提案。")) return;
    abortRef.current?.abort();
    setMessages([]);
    setChatError(null);
  };

  // ============================================================
  // 渲染
  // ============================================================

  const assistantBubble: CSSProperties = {
    maxWidth: "92%",
    borderRadius: 10,
    border: "1px solid var(--line)",
    background: "#fff",
    padding: "8px 12px",
    whiteSpace: "pre-wrap",
  };
  const userBubble: CSSProperties = { ...assistantBubble, background: "var(--bg)" };

  return (
    <div>
      {toast && (
        <div className="panel" style={{ borderColor: "#2e7d32", color: "#2e7d32", fontSize: 13 }}>
          {toast}
        </div>
      )}

      <div className="grid2">
        {/* ---------- 左·构思档案 ---------- */}
        <section className="panel">
          <h3 style={{ margin: "0 0 10px" }}>构思档案</h3>
          {loadError && <p className="muted">{loadError}</p>}
          {!project && !loadError && <p className="muted">正在读取构思档案…</p>}

          {project && (
            <>
              {/* 完成度进度条 */}
              <div className="row" style={{ marginBottom: 10 }}>
                <div style={{ flex: 1, height: 8, background: "var(--line)", borderRadius: 4 }}>
                  <div
                    style={{
                      height: 8,
                      width: `${progress}%`,
                      background: "var(--accent)",
                      borderRadius: 4,
                    }}
                  />
                </div>
                <span className="muted">完成度 {progress}%</span>
              </div>
              {bibleError && <p style={{ color: "#c62828", fontSize: 13 }}>{bibleError}</p>}

              {groupFields(fields).map((g) => (
                <div key={g.name} style={{ marginTop: 12 }}>
                  <h4 style={{ margin: "0 0 6px" }}>{g.name}</h4>
                  {g.fields.map((f) => {
                    const draft = drafts[f.key] ?? f.value;
                    // 只提示「至今仍 stale」的下游，字段被复查确认后提示自动消失
                    const noteKeys = (staleNotes[f.key] ?? []).filter((k) => byKey.get(k)?.status === "stale");
                    return (
                      <div
                        key={f.key}
                        className="panel"
                        style={
                          f.key === focusKey
                            ? { background: "rgba(217, 119, 6, 0.07)", borderLeft: "3px solid #d97706" }
                            : undefined
                        }
                      >
                        <div className="row">
                          <strong>{f.label}</strong>
                          <span className="muted">{f.key}</span>
                          <span style={{ ...badgeBase, ...STATUS_STYLE[f.status] }}>{STATUS_LABEL[f.status]}</span>
                          {f.key === focusKey && (
                            <span style={{ ...badgeBase, background: "var(--accent)", color: "#fff" }}>当前问题焦点</span>
                          )}
                        </div>
                        <textarea
                          value={draft}
                          rows={3}
                          style={{ width: "100%", marginTop: 6 }}
                          onChange={(e) => setDrafts((d) => ({ ...d, [f.key]: e.target.value }))}
                        />
                        <div className="row" style={{ marginTop: 4 }}>
                          <button
                            className="primary"
                            disabled={streaming || !draft.trim() || draft.trim() === f.value}
                            onClick={() => void saveField(f)}
                          >
                            保存
                          </button>
                          {f.deps.length > 0 && <span className="muted">依赖：{f.deps.join("、")}</span>}
                        </div>
                        {noteKeys.length > 0 && (
                          <div style={{ color: "#b45309", fontSize: 13, marginTop: 4 }}>
                            已标记待复查：{noteKeys.map(labelOf).join("、")}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </section>

        {/* ---------- 右·访谈 ---------- */}
        <section className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h3 style={{ margin: 0 }}>构思访谈</h3>
            <div className="row">
              {streaming && <button onClick={() => abortRef.current?.abort()}>停止</button>}
              <button onClick={resetSession}>新会话</button>
            </div>
          </div>

          {/* ---------- v3.2 辅助选材：勾选已有素材辅助 AI 理解与构思 ---------- */}
          <details style={{ marginTop: 8 }} open={matsOpen} onToggle={(e) => setMatsOpen(e.currentTarget.open)}>
            <summary className="muted" style={{ fontSize: 13, cursor: "pointer" }}>
              辅助选材：已选 {selCount} 项（人物卡 {sel.chars.length} · 世界书 {sel.lore.length} · 人设 {sel.personas.length}）
              {selCount > 0 && " —— 每轮随对话注入给 AI"}
            </summary>
            {matsOpen && (
              <>
                {matsError && <div style={{ color: "#c62828", fontSize: 12, marginTop: 4 }}>素材清单载入失败：{matsError}</div>}
                <input
                  value={matsQ}
                  onChange={(e) => setMatsQ(e.target.value)}
                  placeholder="在下列三列里搜索过滤…"
                  style={{ marginTop: 8, minWidth: 0, maxWidth: 280, fontSize: 13 }}
                />
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginTop: 8, fontSize: 13 }}>
                  {[
                    { kind: "chars" as const, title: "人物卡", empty: "人物库为空", items: allChars.map((c): { id: string; label: string; hint?: string } => ({ id: c.id, label: c.name || "（未命名）" })) },
                    { kind: "personas" as const, title: "用户人设", empty: "人设库为空", items: allPersonas.map((p): { id: string; label: string; hint?: string } => ({ id: p.id, label: p.name || "（未命名）" })) },
                  ].map((col) => {
                    const items = col.items.filter((it) => matsFilter(it.label));
                    return (
                      <div key={col.kind} style={{ minWidth: 0 }}>
                        <strong style={{ fontSize: 12 }}>{col.title}</strong>
                        {col.items.length === 0 ? (
                          <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>{col.empty}</p>
                        ) : items.length === 0 ? (
                          <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>无匹配（{matsQ}）</p>
                        ) : (
                          <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 4 }}>
                            {items.map((it) => (
                              <label key={it.id} style={{ display: "block", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                <input
                                  type="checkbox"
                                  checked={selSets[col.kind].has(it.id)}
                                  disabled={streaming}
                                  onChange={() => toggleSel(col.kind, it.id)}
                                />{" "}
                                {it.label}
                                {"hint" in it && it.hint ? <span className="muted"> · {it.hint}</span> : null}
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {/* v8-D3 世界书列：按整本勾选（书头三态全选），词条仍可散勾 */}
                  <div style={{ minWidth: 0 }}>
                    <strong style={{ fontSize: 12 }}>世界书词条</strong>
                    {allLore.length === 0 ? (
                      <p className="muted" style={{ fontSize: 12, margin: "4px 0" }}>世界书为空</p>
                    ) : (
                      <div style={{ maxHeight: 180, overflowY: "auto", marginTop: 4 }}>
                        {loreGroups.map((g) => {
                          const st = bookSelState(g.entryIds, selSets.lore);
                          const shown = g.entries.filter((e) => matsFilter(g.name) || matsFilter(e.comment || "（未命名）"));
                          if (shown.length === 0) return null;
                          return (
                            <div key={g.bookId} style={{ marginBottom: 4 }}>
                              <label style={{ display: "block", cursor: "pointer", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title="整本勾选/取消">
                                <input
                                  type="checkbox"
                                  ref={(cb) => { if (cb) cb.indeterminate = st === "some"; }}
                                  checked={st === "all"}
                                  disabled={streaming}
                                  onChange={(e) => setSel((s) => ({ ...s, lore: toggleBookIds(s.lore, g.entryIds, e.target.checked) }))}
                                />{" "}
                                📖 {g.name}
                                <span className="muted"> ({selBookCount(g.entryIds, selSets.lore)}/{g.entryIds.length})</span>
                              </label>
                              <div style={{ paddingLeft: 14 }}>
                                {shown.map((e) => (
                                  <label key={e.id} style={{ display: "block", cursor: "pointer", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    <input type="checkbox" checked={selSets.lore.has(e.id)} disabled={streaming} onChange={() => toggleSel("lore", e.id)} />{" "}
                                    {e.comment || "（未命名）"}
                                    <span className="muted"> · {e.constant ? "常驻" : e.keys.slice(0, 3).join("/")}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              勾选后作为独立系统段注入（标注为参考素材，与构思冲突时 AI 会先跟你确认）。改动勾选会重发系统段，可能重算供应商前缀缓存——建议一批勾好再聊。
            </p>
          </details>

          <div ref={scrollRef} style={{ maxHeight: 520, overflowY: "auto", marginTop: 10 }}>
            {messages.length === 0 && (
              <p className="muted">
                聊聊你想写的故事吧——我会按「空缺 &gt; 粗略 &gt; 待复查」的优先级，陪你把左边档案一项项填起来。
              </p>
            )}
            {messages.map((m, i) => {
              const chosenCount = (m.proposals ?? []).filter((p) => p.checked && p.valid).length;
              const isLastStreaming = streaming && i === messages.length - 1;
              // v6 反「只说不做」：宣称完成 × 无提案 = 空口白话，当场戳穿（历史气泡同样生效）
              const hasProposals = (m.proposals?.length ?? 0) > 0;
              const claimed = m.role === "assistant" && !isLastStreaming && claimsCompletion(m.content);
              const emptyPromise = claimed && !hasProposals;
              const looksLikeRawJson = m.content.trim().startsWith("{") && m.content.includes('"updates"');
              // 该气泡对应的用户原文（往前找最近一条 user）——「重发上一条」用
              let prevUserText = "";
              for (let j = i - 1; j >= 0; j--) {
                if (messages[j].role === "user") {
                  prevUserText = messages[j].content;
                  break;
                }
              }
              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: m.role === "user" ? "flex-end" : "flex-start",
                    marginBottom: 8,
                  }}
                >
                  <div style={m.role === "user" ? userBubble : assistantBubble}>
                    {m.content || (isLastStreaming ? <span className="muted">思考中…</span> : null)}
                    {emptyPromise && (
                      <div
                        style={{
                          marginTop: 8,
                          padding: "6px 10px",
                          borderRadius: 8,
                          border: "1px solid #d97706",
                          background: "rgba(217, 119, 6, 0.08)",
                          fontSize: 13,
                          color: "#b45309",
                        }}
                      >
                        ⚠ AI 声称完成，但本轮<strong>没有任何字段提案</strong>——档案未发生创作。
                        <button
                          style={{ marginLeft: 8, padding: "2px 10px", fontSize: 12 }}
                          disabled={streaming || !prevUserText}
                          onClick={() => void send(prevUserText)}
                        >
                          重发上一条
                        </button>
                      </div>
                    )}
                    {claimed && !hasProposals && looksLikeRawJson && (
                      <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                        （本轮 JSON 解析失败，未形成提案；可点上方「重发上一条」或直接纠正它）
                      </div>
                    )}
                    {m.role === "assistant" && m.proposals && m.proposals.length > 0 && (
                      <div style={{ marginTop: 8, borderTop: "1px dashed var(--line)", paddingTop: 8 }}>
                        <div className="row">
                          <strong style={{ fontSize: 13 }}>提案更新（{m.proposals.length} 条）</strong>
                          <span className="muted" style={{ fontSize: 12 }}>勾选并「采纳」后才真正写入档案</span>
                          {m.adopted && <span className="muted">已采纳落库</span>}
                        </div>
                        {m.proposals.map((p, j) => (
                          <div key={`${p.key}-${j}`} className="panel" style={{ marginTop: 6, marginBottom: 0 }}>
                            <div className="row">
                              <input
                                type="checkbox"
                                checked={p.checked}
                                disabled={!!m.adopted || !p.valid}
                                onChange={(e) => updateProposal(i, j, { checked: e.target.checked })}
                              />
                              <strong>{labelOf(p.key)}</strong>
                              <span className="muted">{p.key}</span>
                              {!p.valid && <span style={{ color: "#c62828", fontSize: 12 }}>未知字段，将被忽略</span>}
                            </div>
                            <div className="muted" style={{ marginTop: 4 }}>
                              现值：{byKey.get(p.key)?.value || "（空）"}
                            </div>
                            <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>建议：{p.value}</div>
                            {p.note && (
                              <div className="muted" style={{ marginTop: 2 }}>
                                理由：{p.note}
                              </div>
                            )}
                            <div className="row" style={{ marginTop: 4 }}>
                              <label className="muted" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <input
                                  type="radio"
                                  name={`pstatus-${i}-${j}`}
                                  checked={p.status === "rough"}
                                  disabled={!!m.adopted}
                                  onChange={() => updateProposal(i, j, { status: "rough" })}
                                />
                                粗略
                              </label>
                              <label className="muted" style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                <input
                                  type="radio"
                                  name={`pstatus-${i}-${j}`}
                                  checked={p.status === "confirmed"}
                                  disabled={!!m.adopted}
                                  onChange={() => updateProposal(i, j, { status: "confirmed" })}
                                />
                                已确认
                              </label>
                            </div>
                          </div>
                        ))}
                        <div className="row" style={{ marginTop: 8 }}>
                          <button
                            className="primary"
                            disabled={!!m.adopted || chosenCount === 0 || streaming}
                            onClick={() => void adoptProposals(i)}
                          >
                            {m.adopted ? "已采纳" : `采纳选中的 ${chosenCount} 条`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {chatError && <p style={{ color: "#c62828", fontSize: 13 }}>出错：{chatError}</p>}

          <textarea
            value={input}
            rows={3}
            style={{ width: "100%", marginTop: 8 }}
            placeholder="聊聊你的故事、灵感或回答上一个问题…（Ctrl+Enter 发送）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void send();
            }}
          />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="primary" disabled={streaming || !input.trim() || !project} onClick={() => void send()}>
              {streaming ? "发送中…" : "发送"}
            </button>
            {streaming && <span className="muted">正在生成回复…</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
