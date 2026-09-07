// ============================================================
// story-studio — 世界书全局库页（LorePage，v5 整本书管理）
// v5：世界书以「整本书」为管理单元（LoreBook 存 db.meta；词条仍是 loreEntries 表行，靠 bookId 归属）：
//   - 导入 .json → 一整本书（书名/扫描参数入库，词条统一重新起号并打上书 id，不再拆散成散装词条）；
//   - 书卡列表：整本启用/停用总开关、改名、按书导出（ST 全局格式 / 卡内嵌格式）、删除整本；
//   - 展开书 → 书内逐条编辑（keys/内容/order/开关），视图内批量启用/禁用/删除；
//   - 作品侧只按整本选用（作品工作台 → 📦 资产），本页不再逐条选用；
//   - 首开自动迁移：旧散装词条归入「旧版词条」一书（repos.ensureLegacyBookMigration 幂等）；
//   - 匹配调试台：临时参数对「启用中书籍的全部词条」跑一次 matchLore——参数不落库，
//     每个作品实际使用的参数在「作品工作台 → 📦 资产 → 世界书参数」里设置。
// ============================================================
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { LoreBook, LorebookSettings, LoreEntry, Project } from "../core/types";
import {
  buildLoreInjection,
  matchLore,
  type MatchResult,
  type MatchedEntry,
} from "../st/matcher";
import { exportEmbeddedBook, exportLorebookGlobal, normalizeLorebook } from "../st/lorebook";
import { estimateTokens } from "../ai/tokenizer";
import * as repos from "../store/repos";
import { downloadJson, errMsg } from "../core/uiUtils";
import { db } from "../store/db";
import { loadProgress, saveProgress } from "../flow/progress";

// ---------- 小工具 ----------

const BADGE_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid var(--line)",
  background: "var(--bg)",
  color: "var(--muted)",
  whiteSpace: "nowrap",
  maxWidth: 160,
  overflow: "hidden",
  textOverflow: "ellipsis",
  display: "inline-block",
  verticalAlign: "middle",
};

const ELLIPSIS_STYLE: CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** 全局页进度桶键（不再是 projectId） */
const GLOBAL_SCOPE = "global";

/** confirm/展示用的名字截断（审计 P1） */
function shortText(t: string, n = 24): string {
  const s = t.trim() || "（未命名）";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 下载文件名消毒：替换 Windows/macOS 不允许的路径字符 */
function fileSafe(name: string): string {
  const s = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return s || "lorebook";
}

/** 逗号分隔文本 → 触发词数组（半角/全角逗号均可；trim + 去空） */
function parseKeys(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,，]/)) {
    const p = part.trim();
    if (p) out.push(p);
  }
  return out;
}

/** 调试台 history 行解析：半角/全角冒号都切「名：内容」；无冒号整行算内容 */
function parseHistoryLines(text: string): { name: string; content: string }[] {
  const out: { name: string; content: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.search(/[:：]/);
    if (idx < 0) out.push({ name: "", content: line });
    else out.push({ name: line.slice(0, idx).trim(), content: line.slice(idx + 1).trim() });
  }
  return out;
}

function entryLabel(e: LoreEntry): string {
  return e.comment || `词条 #${e.uid}`;
}

function Badge({ text, title }: { text: string; title?: string }) {
  return (
    <span style={BADGE_STYLE} title={title}>
      {text}
    </span>
  );
}

// ---------- 编辑草稿 ----------

interface LoreDraft {
  keysText: string;
  secondaryKeysText: string;
  content: string;
  order: number;
  selective: boolean;
  caseSensitive: boolean;
  matchWholeWord: boolean;
  constant: boolean;
  enabled: boolean;
}

function draftFromEntry(e: LoreEntry): LoreDraft {
  return {
    keysText: e.keys.join(", "),
    secondaryKeysText: e.secondaryKeys.join(", "),
    content: e.content,
    order: e.order,
    selective: e.selective,
    caseSensitive: e.caseSensitive,
    matchWholeWord: e.matchWholeWord,
    constant: e.constant,
    enabled: e.enabled,
  };
}

// ---------- 匹配结果列表（before/after/deep 复用） ----------

function MatchList({ title, items }: { title: string; items: MatchedEntry[] }) {
  return (
    <div>
      <div className="muted">{title}</div>
      {items.length === 0 && <div className="muted">（无）</div>}
      {items.map((m) => (
        <div className="row" key={m.entry.id} style={{ fontSize: 13, marginTop: 2 }}>
          <Badge text={m.via} title={`命中途径：${m.via}`} />
          <span style={{ ...ELLIPSIS_STYLE, flex: "0 1 auto" }} title={entryLabel(m.entry)}>
            {entryLabel(m.entry)}
          </span>
          <span className="muted" style={{ flexShrink: 0 }}>
            约 {estimateTokens(m.entry.content)} tokens · order {m.entry.order} · pos{" "}
            {m.entry.position === "after_char" ? "after" : "before"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// 词条行（memo：编辑草稿每击键只重渲编辑行）——v5：书内逐条编辑
// ============================================================

interface LoreRowProps {
  e: LoreEntry;
  index: number;
  count: number;
  editing: boolean;
  draft: LoreDraft | null;
  onToggle: (e: LoreEntry) => void;
  onDraftField: (patch: Partial<LoreDraft>) => void;
  onSave: () => void;
  onReset: (e: LoreEntry) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRemove: (e: LoreEntry) => void;
}

const LoreRow = memo(function LoreRow(p: LoreRowProps) {
  const { e, editing, draft } = p;
  return (
    <div className="panel">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button onClick={() => p.onToggle(e)}>{editing ? "收起" : "编辑"}</button>
        <span style={{ ...ELLIPSIS_STYLE, maxWidth: "45%" }} title={entryLabel(e)}>
          <strong>{shortText(entryLabel(e), 40)}</strong>
        </span>
        {e.keys.slice(0, 6).map((k) => (
          <Badge key={k} text={k} title="触发词" />
        ))}
        {e.keys.length > 6 && <span className="muted">+{e.keys.length - 6}</span>}
        {e.keys.length === 0 && !e.constant && (
          <span className="muted" title="既无触发词又非常开：普通匹配永不命中">
            （无触发词）
          </span>
        )}
        {e.constant && <Badge text="constant" title="蓝灯：始终注入" />}
        <Badge text={`order ${e.order}`} title="insertion_order，越小越先" />
        <Badge text={e.enabled ? "启用" : "停用"} title="enabled" />
        {!e.enabled && <Badge text="disabled" title="不参与匹配" />}
        <span className="row" style={{ marginLeft: "auto" }}>
          <button disabled={p.index === 0} onClick={() => p.onMove(p.index, -1)} title="上移（交换 order）">
            ↑
          </button>
          <button
            disabled={p.index === p.count - 1}
            onClick={() => p.onMove(p.index, 1)}
            title="下移（交换 order）"
          >
            ↓
          </button>
          <button onClick={() => p.onRemove(e)}>删除</button>
        </span>
      </div>

      {editing && draft && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <div className="grid2">
            <label className="field">
              <span>keys 主键（逗号分隔）</span>
              <input
                value={draft.keysText}
                onChange={(ev) => p.onDraftField({ keysText: ev.target.value })}
                placeholder="触发词1, 触发词2"
              />
            </label>
            <label className="field">
              <span>secondaryKeys 副键（逗号分隔，配合 selective）</span>
              <input
                value={draft.secondaryKeysText}
                onChange={(ev) => p.onDraftField({ secondaryKeysText: ev.target.value })}
                placeholder="副键（selective 时参与）"
              />
            </label>
          </div>
          <label className="field">
            <span>content 内容（{draft.content.length} 字）</span>
            <textarea
              rows={5}
              value={draft.content}
              onChange={(ev) => p.onDraftField({ content: ev.target.value })}
            />
          </label>
          <div className="row" style={{ flexWrap: "wrap", gap: 12 }}>
            {(
              [
                ["selective", "selective（副键参与）"],
                ["caseSensitive", "caseSensitive 区分大小写"],
                ["matchWholeWord", "matchWholeWord 整词"],
                ["constant", "constant 蓝灯常驻"],
                ["enabled", "enabled 启用"],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="row" style={{ gap: 4, fontSize: 13, color: "var(--muted)" }}>
                <input
                  type="checkbox"
                  checked={draft[key]}
                  onChange={(ev) => p.onDraftField({ [key]: ev.target.checked } as Partial<LoreDraft>)}
                />
                {label}
              </label>
            ))}
            <label className="field">
              <span>order</span>
              <input
                type="number"
                style={{ width: 90 }}
                value={draft.order}
                onChange={(ev) => {
                  const n = Math.floor(Number(ev.target.value));
                  p.onDraftField({ order: Number.isFinite(n) ? n : 0 });
                }}
              />
            </label>
          </div>
          <div className="row">
            <button className="primary" onClick={() => void p.onSave()}>
              保存词条
            </button>
            <button onClick={() => p.onReset(e)}>重置</button>
          </div>
        </div>
      )}
    </div>
  );
});

// ============================================================

export function LorePage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [books, setBooks] = useState<LoreBook[]>([]);
  const [entries, setEntries] = useState<LoreEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [q, setQ] = useState(""); // 书内词条名/触发词过滤
  const [onlyEnabled, setOnlyEnabled] = useState(false);

  // 调试台参数（本页临时草稿，不属于任何作品）
  const [params, setParams] = useState<{ scanDepth: string; tokenBudget: string; recursive: boolean }>({
    scanDepth: "4",
    tokenBudget: "2048",
    recursive: true,
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoreDraft | null>(null);

  const [debugText, setDebugText] = useState("");
  const [result, setResult] = useState<MatchResult | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null); // 剪贴板失败 → 只读 textarea

  const bookFileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [bs, rows, projs] = await Promise.all([
        repos.listLoreBooks(),
        repos.listAllLoreEntries(),
        repos.listProjects(),
      ]);
      setBooks(bs);
      setEntries(rows);
      setProjects(projs);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  // 首开先跑旧数据迁移（幂等）：散装词条归入「旧版词条」书，再进列表
  useEffect(() => {
    void (async () => {
      try {
        await repos.ensureLegacyBookMigration();
      } catch {
        // 迁移失败不阻断浏览：工具条上会出现「归入旧版词条」手动补救按钮
      }
      await refresh();
    })();
  }, [refresh]);

  // v3.1-② 进度记忆：展开的书 + 编辑中的词条 + 调试台文本草稿（全局页固定桶键）。
  const selRestoredFor = useRef(false);
  useEffect(() => {
    if (!loaded || selRestoredFor.current) return;
    selRestoredFor.current = true;
    const saved = loadProgress<{ openBookId?: string; editingId?: string; debugText?: string }>(
      "lore",
      GLOBAL_SCOPE,
    );
    if (!saved) return;
    if (saved.openBookId && books.some((b) => b.id === saved.openBookId)) {
      setOpenBookId(saved.openBookId);
    }
    if (saved.editingId) {
      const e = entries.find((x) => x.id === saved.editingId);
      if (e) {
        if (e.bookId && books.some((b) => b.id === e.bookId)) setOpenBookId(e.bookId);
        setEditingId(e.id);
        setDraft(draftFromEntry(e));
      }
    }
    if (typeof saved.debugText === "string" && saved.debugText) {
      setDebugText(saved.debugText.slice(0, 4000));
    }
  }, [loaded, entries, books]);
  useEffect(() => {
    if (!loaded || !selRestoredFor.current) return;
    saveProgress("lore", GLOBAL_SCOPE, {
      openBookId: openBookId ?? undefined,
      editingId: editingId ?? undefined,
      debugText: debugText.slice(0, 4000),
    });
  }, [loaded, openBookId, editingId, debugText]);

  // ---- 派生：书 → 词条（保持 repos 的 order/uid 稳定序）/ 书被选用数 / 展开视图 ----
  const entriesByBook = useMemo(() => {
    const m = new Map<string, LoreEntry[]>();
    for (const e of entries) {
      if (!e.bookId) continue;
      const arr = m.get(e.bookId);
      if (arr) arr.push(e);
      else m.set(e.bookId, [e]);
    }
    return m;
  }, [entries]);
  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books]);
  const bookUsedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of projects) {
      for (const id of p.loreBookIds ?? []) m.set(id, (m.get(id) ?? 0) + 1);
    }
    return m;
  }, [projects]);
  const orphanCount = useMemo(() => entries.filter((e) => !e.bookId).length, [entries]);

  const openBook = openBookId ? bookById.get(openBookId) ?? null : null;
  const openRows = useMemo(
    () => (openBook ? entriesByBook.get(openBook.id) ?? [] : []),
    [openBook, entriesByBook],
  );
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return openRows.filter(
      (e) =>
        (!onlyEnabled || e.enabled) &&
        (!needle ||
          entryLabel(e).toLowerCase().includes(needle) ||
          e.keys.some((k) => k.toLowerCase().includes(needle))),
    );
  }, [openRows, q, onlyEnabled]);

  // ---- 书级操作 ----

  const onAddBook = async () => {
    const name = window.prompt("新书名称", "我的世界书");
    if (name === null) return;
    try {
      const b = await repos.addLoreBook({ name: name.trim() || "未命名世界书" });
      await refresh();
      setOpenBookId(b.id);
      setFlash(`已新建空书《${shortText(b.name, 20)}》，展开后可「新增词条」`);
    } catch (err) {
      setBulkError(`新建世界书失败：${errMsg(err)}`);
    }
  };

  const onRenameBook = async (b: LoreBook) => {
    const name = window.prompt("世界书名称", b.name);
    if (name === null || !name.trim()) return;
    try {
      await repos.updateLoreBook(b.id, { name: name.trim() });
      await refresh();
    } catch (err) {
      setBulkError(`改名失败：${errMsg(err)}`);
    }
  };

  const onToggleBook = async (b: LoreBook) => {
    try {
      await repos.setLoreBookEnabled(b.id, !b.enabled);
      await refresh();
      setFlash(`《${shortText(b.name, 20)}》已${b.enabled ? "整本停用（其词条不再注入任何作品）" : "整本启用"}`);
    } catch (err) {
      setBulkError(`整本开关失败：${errMsg(err)}`);
    }
  };

  const onDeleteBook = async (b: LoreBook) => {
    const n = (entriesByBook.get(b.id) ?? []).length;
    const used = bookUsedBy.get(b.id) ?? 0;
    if (
      !window.confirm(
        `删除整本《${shortText(b.name, 30)}》？含 ${n} 条词条${
          used > 0 ? `，正被 ${used} 个作品选用（选用将自动解除）` : ""
        }。此操作不可恢复。`,
      )
    )
      return;
    try {
      await repos.deleteLoreBook(b.id);
      if (openBookId === b.id) {
        setOpenBookId(null);
        setEditingId(null);
        setDraft(null);
      }
      await refresh();
      setFlash(`已删除《${shortText(b.name, 20)}》及其 ${n} 条词条`);
    } catch (err) {
      setBulkError(`删除整本失败：${errMsg(err)}`);
    }
  };

  const onExportBook = (b: LoreBook) => {
    const rows = (entriesByBook.get(b.id) ?? []).filter((e) => e.enabled);
    downloadJson(`${fileSafe(b.name)}.json`, exportLorebookGlobal(rows));
  };

  const onExportBookEmbedded = (b: LoreBook) => {
    const rows = entriesByBook.get(b.id) ?? [];
    downloadJson(`${fileSafe(b.name)}·embedded.json`, exportEmbeddedBook(rows, b.settings));
  };

  const fixOrphans = async () => {
    try {
      const r = await repos.ensureLegacyBookMigration();
      await refresh();
      setFlash(
        r.merged > 0 ? `已把 ${r.merged} 条散装词条归入「${repos.LEGACY_BOOK_NAME}」` : "没有需要归并的散装词条",
      );
    } catch (err) {
      setBulkError(`归并失败：${errMsg(err)}`);
    }
  };

  // ---- 书内词条操作 ----

  const onDraftField = useCallback((patch: Partial<LoreDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d)), []);
  const onReset = useCallback((e: LoreEntry) => setDraft(draftFromEntry(e)), []);

  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const onToggle = useCallback((e: LoreEntry) => {
    if (editingIdRef.current === e.id) {
      setEditingId(null);
      setDraft(null);
      return;
    }
    setEditingId(e.id);
    setDraft(draftFromEntry(e));
  }, []);

  const saveDraft = async () => {
    if (!editingId || !draft) return;
    try {
      await repos.updateLoreEntry(editingId, {
        keys: parseKeys(draft.keysText),
        secondaryKeys: parseKeys(draft.secondaryKeysText),
        content: draft.content,
        order: draft.order,
        selective: draft.selective,
        caseSensitive: draft.caseSensitive,
        matchWholeWord: draft.matchWholeWord,
        constant: draft.constant,
        enabled: draft.enabled,
      });
      await refresh();
      setFlash("词条已保存");
    } catch (err) {
      setBulkError(`保存词条失败：${errMsg(err)}`);
    }
  };
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;
  const onSaveStable = useCallback(() => void saveRef.current(), []);

  /** 与相邻行交换 order（在**本书当前视图**内相邻即视为相邻）；order 相同时给移动方 ±1 制造先后 */
  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= visible.length) return;
    const a = visible[index];
    const b = visible[target];
    try {
      // 两写非原子：失败提示重试（半途只改了一条 order，刷新后可再点一次修回）
      if (a.order !== b.order) {
        await repos.updateLoreEntry(a.id, { order: b.order });
        await repos.updateLoreEntry(b.id, { order: a.order });
      } else {
        await repos.updateLoreEntry(a.id, { order: a.order + dir });
      }
      setEditingId(null);
      setDraft(null);
      await refresh();
    } catch (err) {
      setBulkError(`移动词条失败（顺序可能只改了一半，重试可修回）：${errMsg(err)}`);
    }
  };
  const moveRef = useRef(move);
  moveRef.current = move;
  const onMoveStable = useCallback((i: number, d: -1 | 1) => void moveRef.current(i, d), []);

  const addEntry = async () => {
    if (!openBook) return;
    try {
      const e = await repos.addLoreEntry("", { bookId: openBook.id });
      await refresh();
      setEditingId(e.id);
      setDraft(draftFromEntry(e));
      setFlash(`已在《${shortText(openBook.name, 20)}》新增空词条，直接编辑后保存`);
    } catch (err) {
      setBulkError(`新增词条失败：${errMsg(err)}`);
    }
  };

  const onRemove = async (e: LoreEntry) => {
    if (!window.confirm(`删除词条「${shortText(entryLabel(e))}」？此操作不可恢复。`)) return;
    try {
      const wasEditing = editingIdRef.current === e.id;
      await repos.removeLoreEntry(e.id);
      if (wasEditing) {
        setEditingId(null);
        setDraft(null);
      }
      await refresh();
    } catch (err) {
      setBulkError(`删除词条失败：${errMsg(err)}`);
    }
  };
  const removeRef = useRef(onRemove);
  removeRef.current = onRemove;
  const onRemoveStable = useCallback((e: LoreEntry) => void removeRef.current(e), []);

  // ---------- 批量操作（作用域 = 展开书籍的当前过滤视图） ----------

  const setViewEnabled = async (enabled: boolean) => {
    const ids = visible.map((e) => e.id);
    if (ids.length === 0 || !openBook) return;
    if (
      !window.confirm(
        `将${enabled ? "启用" : "禁用"}《${shortText(openBook.name, 20)}》当前视图的 ${ids.length} 条词条，确定？`,
      )
    )
      return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      const changed = await db.loreEntries.where("id").anyOf(ids).modify({ enabled });
      setEditingId(null);
      setDraft(null);
      await refresh();
      setFlash(`已${enabled ? "启用" : "禁用"} ${changed} 条`);
    } catch (err) {
      setBulkError(`批量${enabled ? "启用" : "禁用"}失败：${errMsg(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const removeView = async () => {
    const ids = visible.map((e) => e.id);
    if (ids.length === 0 || !openBook) return;
    if (
      !window.confirm(
        `将删除《${shortText(openBook.name, 20)}》当前视图的 ${ids.length} 条词条，无法撤销，确定？`,
      )
    )
      return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await repos.removeLoreEntries(ids);
      setEditingId(null);
      setDraft(null);
      await refresh();
      setFlash(`已删除 ${ids.length} 条`);
    } catch (err) {
      setBulkError(`删除失败：${errMsg(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  // ---------- 导入（一次导入 = 一整本书） ----------

  const onImportBook = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const errs: string[] = [];
    let imported: LoreBook | null = null;
    let entryCount = 0;
    try {
      const text = await file.text();
      const book = normalizeLorebook(JSON.parse(text.replace(/^\uFEFF/, "")), "auto");
      if (book.entries.length === 0) {
        errs.push(`${file.name}：未解析出任何有效词条（entries 缺失或全为坏条目）`);
      } else if (
        !window.confirm(
          `解析出《${shortText(book.name || file.name, 40)}》共 ${book.entries.length} 条词条。` +
            `将作为「一整本世界书」导入（不拆散；书内可逐条编辑；作品在「📦 资产」里整本选用），确认？`,
        )
      ) {
        // 用户取消：不算错误
      } else {
        // 忽略文件自带 uid：importLoreBook 内部统一从 nextUid 起号，避免撞车
        imported = await repos.importLoreBook(book);
        entryCount = book.entries.length;
      }
    } catch (err) {
      errs.push(`${file.name}：${errMsg(err)}`);
    }
    setBusy(false);
    setImportErrors(errs);
    if (imported) {
      await refresh();
      setOpenBookId(imported.id);
      setFlash(`已导入整本《${shortText(imported.name, 30)}》（${entryCount} 条词条，uid 重新编号）`);
    }
  };

  // ---------- 匹配调试台（本页临时参数） ----------

  const debugSettings: LorebookSettings = useMemo(() => {
    const sd = Math.floor(Number(params.scanDepth));
    const tb = Math.floor(Number(params.tokenBudget));
    return {
      scanDepth: Number.isFinite(sd) && sd >= 1 ? sd : 1,
      tokenBudget: Number.isFinite(tb) && tb >= 0 ? tb : 0,
      recursiveScanning: params.recursive,
    };
  }, [params]);

  /** 调试池 = 整本启用书籍的全部词条（整本停用的书整体不参与；书内停用词条由 matcher 自行跳过） */
  const debugPool = useMemo(
    () =>
      entries.filter((e) => {
        if (!e.bookId) return true; // 迁移兜底：无主词条照常参与
        return bookById.get(e.bookId)?.enabled ?? false;
      }),
    [entries, bookById],
  );

  const runMatch = () => {
    const history = parseHistoryLines(debugText);
    setResult(matchLore(debugPool, debugSettings, { history }, estimateTokens));
  };

  const copyInjection = () => {
    const text = result ? buildLoreInjection(result) : "";
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => setFlash("注入文本已复制到剪贴板"),
        () => setCopyFallback(text), // 审计 P1：长文本不再塞 window.prompt 单行框
      );
    } else {
      setCopyFallback(text);
    }
  };

  // ---------- 渲染 ----------

  if (!loaded) return <div className="panel muted">正在读取本地库…</div>;
  if (loadError) return <div className="panel">世界书加载失败：{loadError}</div>;

  const budget = debugSettings.tokenBudget;
  const injectText = result ? buildLoreInjection(result) : "";
  const usedPct = result
    ? budget > 0
      ? Math.min(100, (result.usedTokens / budget) * 100)
      : result.usedTokens > 0
        ? 100
        : 0
    : 0;

  return (
    <div>
      {/* 工具条 */}
      <section className="panel">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="primary" disabled={busy} onClick={() => bookFileRef.current?.click()}>
            {busy ? "导入中…" : "导入世界书(.json)"}
          </button>
          <input
            ref={bookFileRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => void onImportBook(e)}
          />
          <button onClick={() => void onAddBook()}>新建世界书</button>
          <button onClick={() => void refresh()}>刷新</button>
          <span className="muted">
            世界书 {books.length} 本 · 词条共 {entries.length} 条
          </span>
        </div>
        <p className="muted" style={{ margin: "8px 0 0" }}>
          世界书按「整本书」管理：导入 = 一整本（书内可逐条编辑，不拆散）；作品在「作品工作台 → 📦 资产」里
          **整本选用**（可选多本，按勾选顺序拼接注入）。
        </p>
        {orphanCount > 0 && (
          <p style={{ color: "#9a6b00", fontSize: 13, margin: "6px 0 0" }}>
            检测到 {orphanCount} 条未归书的散装词条。
            <button style={{ marginLeft: 8 }} onClick={() => void fixOrphans()}>
              归入「{repos.LEGACY_BOOK_NAME}」
            </button>
          </p>
        )}
        {flash && <p className="muted">{flash}</p>}
        {bulkError && <p style={{ color: "#b3261e", fontSize: 13, margin: "4px 0" }}>{bulkError}</p>}
        {importErrors.slice(0, 10).map((msg, i) => (
          <p key={`${i}-${msg}`} style={{ color: "#b42318", fontSize: 13, margin: "4px 0" }}>
            导入失败 — {msg}
          </p>
        ))}
        {importErrors.length > 10 && (
          <p className="muted" style={{ fontSize: 13, margin: "4px 0" }}>
            …还有 {importErrors.length - 10} 条失败信息未显示
          </p>
        )}
      </section>

      {/* 书卡列表 */}
      {books.length === 0 && importErrors.length === 0 && (
        <div className="panel muted">
          还没有世界书：点「导入世界书(.json)」把 ST 导出的 world info（或角色卡内嵌 character_book）
          作为一整本书导入；也可「新建世界书」从零开始。
        </div>
      )}
      {books.map((b) => {
        const rows = entriesByBook.get(b.id) ?? [];
        const enabledCount = rows.reduce((n, e) => n + (e.enabled ? 1 : 0), 0);
        const used = bookUsedBy.get(b.id) ?? 0;
        const open = openBookId === b.id;
        return (
          <section className="panel" key={b.id}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button onClick={() => setOpenBookId(open ? null : b.id)}>{open ? "收起" : "展开"}</button>
              <span style={{ ...ELLIPSIS_STYLE, maxWidth: "30%" }} title={b.name}>
                <strong>📚 {shortText(b.name, 30)}</strong>
              </span>
              <Badge text={`${rows.length} 条`} title="词条数" />
              <Badge text={`启用 ${enabledCount}`} title="启用中的词条数（还须整本启用才会注入）" />
              {used > 0 && (
                <Badge text={`被 ${used} 作品选用`} title="在作品「📦 资产」里整本选用本书的作品数" />
              )}
              <Badge
                text={`深度 ${b.settings.scanDepth} · 预算 ${b.settings.tokenBudget}`}
                title="导入时随书带来的参数（实际注入以作品侧「世界书参数」为准）"
              />
              {!b.settings.recursiveScanning && <Badge text="不递归" title="导入时随书带来的递归开关（实际注入以作品侧为准）" />}
              {!b.enabled && <Badge text="整本已停用" title="停用后这本书的所有词条都不注入任何作品" />}
              <span className="row" style={{ marginLeft: "auto" }}>
                <button onClick={() => void onToggleBook(b)}>{b.enabled ? "整本停用" : "整本启用"}</button>
                <button onClick={() => void onRenameBook(b)}>改名</button>
                <button onClick={() => onExportBook(b)} title="导出 ST 全局 world info 格式（本书启用词条）">
                  导出ST书
                </button>
                <button onClick={() => onExportBookEmbedded(b)} title="导出卡内嵌 character_book 格式（本书全部词条 + 书参数）">
                  导出卡内嵌
                </button>
                <button style={{ color: "#b3261e" }} onClick={() => void onDeleteBook(b)}>
                  删除整本
                </button>
              </span>
            </div>

            {open && (
              <>
                <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
                  <button className="primary" onClick={() => void addEntry()}>
                    ＋ 新增词条
                  </button>
                  <input
                    style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 360 }}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="本书内按词条名 / 触发词过滤…"
                  />
                  <label className="row" style={{ gap: 4, fontSize: 13, color: "var(--muted)" }}>
                    <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
                    只看启用
                  </label>
                  <span className="muted">
                    本书 {rows.length} 条，当前视图 {visible.length} 条
                  </span>
                </div>
                <div className="row" style={{ flexWrap: "wrap", marginTop: 6 }}>
                  <button disabled={visible.length === 0 || bulkBusy} onClick={() => void setViewEnabled(true)}>
                    视图内全部启用（{visible.length}）
                  </button>
                  <button disabled={visible.length === 0 || bulkBusy} onClick={() => void setViewEnabled(false)}>
                    视图内全部禁用
                  </button>
                  <button
                    disabled={visible.length === 0 || bulkBusy}
                    onClick={() => void removeView()}
                    style={{ color: "#b3261e" }}
                  >
                    删除视图内词条（{visible.length}）
                  </button>
                </div>
                {rows.length === 0 && (
                  <p className="muted">这本书还是空的：「＋ 新增词条」手工写，或重新导入一本。</p>
                )}
                {rows.length > 0 && visible.length === 0 && (
                  <p className="muted">本书当前过滤条件下没有匹配的词条。</p>
                )}
                <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
                  {visible.map((e, i) => (
                    <LoreRow
                      key={e.id}
                      e={e}
                      index={i}
                      count={visible.length}
                      editing={editingId === e.id && draft !== null}
                      draft={editingId === e.id ? draft : null}
                      onToggle={onToggle}
                      onDraftField={onDraftField}
                      onSave={onSaveStable}
                      onReset={onReset}
                      onMove={onMoveStable}
                      onRemove={onRemoveStable}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        );
      })}

      {/* 匹配调试台（临时参数，不属于任何作品） */}
      <section className="panel">
        <h3>匹配调试台</h3>
        <p className="muted">
          每行一条消息，格式「谁：说了什么」（全角/半角冒号均可；无冒号整行视为内容）。
          用下方**临时参数**对「整本启用书籍」的 {debugPool.length} 条词条跑一次 matchLore——参数不落库，
          每个作品实际使用的参数在「作品工作台 → 📦 资产 → 世界书参数」里设置。概率骰使用
          Math.random，重跑结果可能不同。
        </p>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="field">
            <span>scanDepth（最近 N 条）</span>
            <input
              type="number"
              min={1}
              style={{ width: 90 }}
              value={params.scanDepth}
              onChange={(e) => setParams((p) => ({ ...p, scanDepth: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>tokenBudget</span>
            <input
              type="number"
              min={0}
              style={{ width: 110 }}
              value={params.tokenBudget}
              onChange={(e) => setParams((p) => ({ ...p, tokenBudget: e.target.value }))}
            />
          </label>
          <label className="row" style={{ gap: 4, fontSize: 13, color: "var(--muted)" }}>
            <input
              type="checkbox"
              checked={params.recursive}
              onChange={(e) => setParams((p) => ({ ...p, recursive: e.target.checked }))}
            />
            recursiveScanning 递归扫描
          </label>
        </div>
        <label className="field">
          <span>对话历史（时间正序，最后一行最新）</span>
          <textarea
            rows={6}
            value={debugText}
            onChange={(e) => setDebugText(e.target.value)}
            placeholder={"示例：\n林九：今晚的月亮很红。\n你注意到碑上的字了吗？"}
          />
        </label>
        <div className="row">
          <button className="primary" onClick={runMatch}>
            运行匹配
          </button>
          <span className="muted">共 {debugPool.length} 条词条参与匹配</span>
        </div>

        {result && (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {/* 预算进度条 */}
            <div className="row">
              <span className="muted">usedTokens / tokenBudget</span>
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  height: 10,
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 5,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${usedPct}%`,
                    background: usedPct >= 100 ? "#b42318" : "var(--accent)",
                  }}
                />
              </div>
              <span className="muted" style={{ flexShrink: 0 }}>
                {result.usedTokens} / {budget}
              </span>
            </div>

            <MatchList title={`before_char（${result.before.length} 条）`} items={result.before} />
            <MatchList title={`after_char（${result.after.length} 条）`} items={result.after} />

            {result.deep.length > 0 && (
              <div style={{ display: "grid", gap: 6 }}>
                <div className="muted">deep 注入分组（depth 升序）</div>
                {result.deep.map((g) => (
                  <MatchList key={g.depth} title={`depth = ${g.depth}（${g.entries.length} 条）`} items={g.entries} />
                ))}
              </div>
            )}

            {result.dropped.length > 0 && (
              <div style={{ color: "#9a6b00", fontSize: 13 }}>
                超 token 预算被裁剪 {result.dropped.length} 条：
                {result.dropped.map((m) => (
                  <div key={m.entry.id}>
                    · {entryLabel(m.entry)}（约 {estimateTokens(m.entry.content)} tokens，via {m.via}）
                  </div>
                ))}
              </div>
            )}

            <label className="field">
              <span>buildLoreInjection 注入文本</span>
              <div className="row">
                <button onClick={copyInjection}>复制注入文本</button>
                <span className="muted">{injectText ? `约 ${estimateTokens(injectText)} tokens` : "（空）"}</span>
              </div>
              <pre
                style={{
                  margin: 0,
                  padding: 10,
                  background: "var(--bg)",
                  border: "1px solid var(--line)",
                  borderRadius: 8,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 13,
                  maxHeight: 320,
                  overflow: "auto",
                }}
              >
                {injectText || "（无注入内容）"}
              </pre>
            </label>
          </div>
        )}

        {copyFallback !== null && (
          <label className="field">
            <span>自动复制失败：以下为注入文本，请手动全选复制</span>
            <textarea
              readOnly
              rows={8}
              value={copyFallback}
              onFocus={(e) => e.currentTarget.select()}
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </label>
        )}
      </section>
    </div>
  );
}
