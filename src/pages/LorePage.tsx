// ============================================================
// story-studio — 世界书管理页（LorePage）
// - 参数面板：project.lorebook（scanDepth/tokenBudget/recursiveScanning）→ repos.updateProject。
// - 词条表：按 order 升序；折叠头 = comment + keys 徽标 + constant/order/enabled 小徽；
//   展开 = keys/secondaryKeys 逗号文本、五个复选、order、content → repos.updateLoreEntry；
//   上下移动 = 与相邻行交换 order；删除确认；「新增词条」repos.addLoreEntry；
//   整本批量 = 全部启用/禁用（db.loreEntries.where(projectId).modify({enabled})）、
//   删除整本（count 后进 confirm，再 where(projectId).delete() 一次清空）。
// - 导入世界书 .json → normalizeLorebook(auto)（ST 全局 world info 与卡内 character_book 均可）
//   → 条数预览 confirm → 以 repos.nextUid 为起点重新起号（忽略文件自带 uid，防撞主键）
//   → toLoreEntries → db.loreEntries.bulkAdd；失败红行。
// - 导出：ST 全局 worldbook.json（enabled 的全部）/ 卡内嵌 lorebook.json（全部词条 + 项目参数）。
// - 匹配调试台：多行「谁：说了什么」→ matchLore → before/after、deep 分组、dropped、
//   usedTokens/tokenBudget 进度条、buildLoreInjection 结果（可复制）。
// ============================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { LorebookSettings, LoreEntry, Project, RawLorebook } from "../core/types";
import {
  buildLoreInjection,
  matchLore,
  type MatchResult,
  type MatchedEntry,
} from "../st/matcher";
import {
  exportEmbeddedBook,
  exportLorebookGlobal,
  normalizeLorebook,
  toLoreEntries,
} from "../st/lorebook";
import { estimateTokens } from "../ai/tokenizer";
import * as repos from "../store/repos";
import { db } from "../store/db";

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
};

/** 统一 Blob 下载小工具：createObjectURL → a.click → revoke */
function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
          <span>{entryLabel(m.entry)}</span>
          <span className="muted">
            约 {estimateTokens(m.entry.content)} tokens · order {m.entry.order} · pos{" "}
            {m.entry.position === "after_char" ? "after" : "before"}
          </span>
        </div>
      ))}
    </div>
  );
}

// ============================================================

export function LorePage({ projectId }: { projectId: string }) {
  const [project, setProject] = useState<Project | null>(null);
  const [entries, setEntries] = useState<LoreEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);

  // 参数面板草稿（文本承载 number，保存时解析并夹紧）
  const [params, setParams] = useState<{
    scanDepth: string;
    tokenBudget: string;
    recursiveScanning: boolean;
  }>({ scanDepth: "4", tokenBudget: "2048", recursiveScanning: true });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LoreDraft | null>(null);

  const [debugText, setDebugText] = useState("");
  const [result, setResult] = useState<MatchResult | null>(null);

  const bookFileRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, rows] = await Promise.all([
        repos.getProject(projectId),
        repos.listLoreEntries(projectId),
      ]);
      setProject(p ?? null);
      setEntries(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 项目（重）载入后同步参数草稿
  useEffect(() => {
    if (!project) return;
    setParams({
      scanDepth: String(project.lorebook.scanDepth),
      tokenBudget: String(project.lorebook.tokenBudget),
      recursiveScanning: project.lorebook.recursiveScanning,
    });
  }, [project]);

  const setDraftField = (patch: Partial<LoreDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  // ---------- 参数 ----------

  const saveParams = async () => {
    const sd = Math.floor(Number(params.scanDepth));
    const tb = Math.floor(Number(params.tokenBudget));
    const lorebook: LorebookSettings = {
      scanDepth: Number.isFinite(sd) && sd >= 1 ? sd : 1,
      tokenBudget: Number.isFinite(tb) && tb >= 0 ? tb : 0,
      recursiveScanning: params.recursiveScanning,
    };
    const updated = await repos.updateProject(projectId, { lorebook });
    if (updated) setProject(updated);
    setFlash("世界书参数已保存");
  };

  // ---------- 词条 CRUD ----------

  const toggleEdit = (e: LoreEntry) => {
    if (editingId === e.id) {
      setEditingId(null);
      setDraft(null);
      return;
    }
    setEditingId(e.id);
    setDraft(draftFromEntry(e));
  };

  const saveDraft = async () => {
    if (!editingId || !draft) return;
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
  };

  /** 与相邻行交换 order；order 相同（导入并列常见）时给移动方 ±1 制造先后 */
  const move = async (index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= entries.length) return;
    const a = entries[index];
    const b = entries[target];
    if (a.order !== b.order) {
      await repos.updateLoreEntry(a.id, { order: b.order });
      await repos.updateLoreEntry(b.id, { order: a.order });
    } else {
      await repos.updateLoreEntry(a.id, { order: a.order + dir });
    }
    setEditingId(null);
    setDraft(null);
    await refresh();
  };

  const addEntry = async () => {
    const e = await repos.addLoreEntry(projectId);
    await refresh();
    setEditingId(e.id);
    setDraft(draftFromEntry(e));
    setFlash("已新增空词条，直接编辑后保存");
  };

  const removeEntry = async (e: LoreEntry) => {
    if (!window.confirm(`删除词条「${entryLabel(e)}」？此操作不可恢复。`)) return;
    await repos.removeLoreEntry(e.id);
    if (editingId === e.id) {
      setEditingId(null);
      setDraft(null);
    }
    await refresh();
  };

  // ---------- 整本批量操作（直接走 db 门面，Dexie 集合原语一次事务，避免逐条写） ----------

  /** 全启用 / 全禁用：where(projectId).modify({enabled}) 返回实际改动条数 */
  const setAllEnabled = async (enabled: boolean) => {
    setBulkBusy(true);
    setBulkError(null);
    try {
      const changed = await db.loreEntries
        .where("projectId")
        .equals(projectId)
        .modify({ enabled });
      // 折叠中的草稿持有旧 enabled，保存会覆掉批量结果，先收起
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

  /** 删除整本：confirm 前先数好条数，delete() 一次清空本项目全部词条 */
  const removeAllEntries = async () => {
    setBulkError(null);
    const total = await db.loreEntries.where("projectId").equals(projectId).count();
    if (total === 0) {
      await refresh();
      return;
    }
    if (!window.confirm(`将删除本项目全部 ${total} 条词条，无法撤销，确定？`)) return;
    setBulkBusy(true);
    try {
      const removed = await db.loreEntries.where("projectId").equals(projectId).delete();
      setEditingId(null);
      setDraft(null);
      await refresh();
      setFlash(`已删除 ${removed} 条`);
    } catch (err) {
      setBulkError(`删除整本失败：${errMsg(err)}`);
    } finally {
      setBulkBusy(false);
    }
  };

  // ---------- 导入 / 导出 ----------

  const onImportBook = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    const errs: string[] = [];
    let added = 0;
    let start = 0;
    try {
      const text = await file.text();
      const book = normalizeLorebook(JSON.parse(text.replace(/^\uFEFF/, "")), "auto");
      if (book.entries.length === 0) {
        errs.push(`${file.name}：未解析出任何有效词条（entries 缺失或全为坏条目）`);
      } else if (
        !window.confirm(`「${file.name}」解析出 ${book.entries.length} 条词条，确认导入到当前世界书？`)
      ) {
        // 用户取消：不算错误
      } else {
        start = await repos.nextUid(projectId);
        // 忽略文件自带 uid：统一从 nextUid 起号，避免与现有词条撞主键（bulkAdd 整批失败）
        const renumbered: RawLorebook = {
          ...book,
          entries: book.entries.map((en) => ({ ...en, uid: undefined })),
        };
        const rows = toLoreEntries(renumbered, projectId, start);
        await db.loreEntries.bulkAdd(rows);
        added = rows.length;
      }
    } catch (err) {
      errs.push(`${file.name}：${errMsg(err)}`);
    }
    setBusy(false);
    setImportErrors(errs);
    if (added > 0) {
      await refresh();
      setFlash(`已导入 ${added} 条词条（uid 自 ${start} 起重新编号）`);
    }
  };

  const exportGlobal = () => {
    downloadJson("worldbook.json", exportLorebookGlobal(entries.filter((e) => e.enabled)));
  };

  const exportEmbedded = () => {
    if (!project) return;
    downloadJson("lorebook.json", exportEmbeddedBook(entries, project.lorebook));
  };

  // ---------- 匹配调试台 ----------

  const runMatch = () => {
    if (!project) return;
    const history = parseHistoryLines(debugText);
    setResult(matchLore(entries, project.lorebook, { history }, estimateTokens));
  };

  const copyInjection = () => {
    const text = result ? buildLoreInjection(result) : "";
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(text).then(
        () => setFlash("注入文本已复制到剪贴板"),
        () => window.prompt("自动复制失败，请手动复制：", text),
      );
    } else {
      window.prompt("自动复制失败，请手动复制：", text);
    }
  };

  // ---------- 渲染 ----------

  if (!loaded) return <div className="panel muted">正在读取本地库…</div>;
  if (loadError) return <div className="panel">世界书加载失败：{loadError}</div>;
  if (!project) return <div className="panel muted">未找到该作品。</div>;

  const budget = project.lorebook.tokenBudget;
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
      {/* 参数面板 */}
      <section className="panel">
        <h3>世界书参数</h3>
        <div className="row" style={{ flexWrap: "wrap" }}>
          <label className="field">
            <span>scanDepth 扫描深度（最近 N 条消息）</span>
            <input
              type="number"
              min={1}
              style={{ width: 110 }}
              value={params.scanDepth}
              onChange={(e) => setParams((p) => ({ ...p, scanDepth: e.target.value }))}
            />
          </label>
          <label className="field">
            <span>tokenBudget 注入总预算</span>
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
              checked={params.recursiveScanning}
              onChange={(e) => setParams((p) => ({ ...p, recursiveScanning: e.target.checked }))}
            />
            recursiveScanning 递归扫描
          </label>
          <button className="primary" onClick={() => void saveParams()}>
            保存参数
          </button>
        </div>
      </section>

      {/* 词条操作条 */}
      <section className="panel">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="primary" onClick={() => void addEntry()}>
            新增词条
          </button>
          <button disabled={busy} onClick={() => bookFileRef.current?.click()}>
            {busy ? "导入中…" : "导入世界书(.json)"}
          </button>
          <input
            ref={bookFileRef}
            type="file"
            accept=".json"
            style={{ display: "none" }}
            onChange={(e) => void onImportBook(e)}
          />
          <button onClick={exportGlobal} title="仅导出启用中的词条">
            导出 ST 全局世界书
          </button>
          <button onClick={exportEmbedded} title="全部词条 + 项目参数（character_book 形态）">
            导出卡内嵌世界书
          </button>
          <button
            disabled={entries.length === 0 || bulkBusy}
            onClick={() => void setAllEnabled(true)}
            title="将本项目全部词条 enabled=true（Dexie 批量 modify）"
          >
            全部启用
          </button>
          <button
            disabled={entries.length === 0 || bulkBusy}
            onClick={() => void setAllEnabled(false)}
            title="将本项目全部词条 enabled=false（Dexie 批量 modify）"
          >
            全部禁用
          </button>
          <button
            disabled={entries.length === 0 || bulkBusy}
            onClick={() => void removeAllEntries()}
            title="删除本项目全部词条（二次确认，无法撤销）"
            style={{ color: "#b3261e" }}
          >
            删除整本
          </button>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        {flash && <p className="muted">{flash}</p>}
        {bulkError && (
          <p style={{ color: "#b3261e", fontSize: 13, margin: "4px 0" }}>{bulkError}</p>
        )}
        {importErrors.map((msg) => (
          <p key={msg} style={{ color: "#b42318", fontSize: 13, margin: "4px 0" }}>
            导入失败 — {msg}
          </p>
        ))}
        {entries.length === 0 && importErrors.length === 0 && (
          <p className="muted">
            世界书还是空的：可「导入世界书(.json)」（ST 全局 world info 或卡内 character_book 均可），或「新增词条」手动创建。
          </p>
        )}
      </section>

      {/* 词条表 */}
      {entries.map((e, i) => {
        const editing = editingId === e.id && draft !== null;
        return (
          <div className="panel" key={e.id}>
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button onClick={() => toggleEdit(e)}>{editing ? "收起" : "编辑"}</button>
              <strong>{entryLabel(e)}</strong>
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
              <span style={{ flex: 1 }} />
              <button disabled={i === 0} onClick={() => void move(i, -1)} title="上移（交换 order）">
                ↑
              </button>
              <button
                disabled={i === entries.length - 1}
                onClick={() => void move(i, 1)}
                title="下移（交换 order）"
              >
                ↓
              </button>
              <button onClick={() => void removeEntry(e)}>删除</button>
            </div>

            {editing && draft && (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <div className="grid2">
                  <label className="field">
                    <span>keys 主键（逗号分隔）</span>
                    <input
                      value={draft.keysText}
                      onChange={(ev) => setDraftField({ keysText: ev.target.value })}
                      placeholder="触发词1, 触发词2"
                    />
                  </label>
                  <label className="field">
                    <span>secondaryKeys 副键（逗号分隔，配合 selective）</span>
                    <input
                      value={draft.secondaryKeysText}
                      onChange={(ev) => setDraftField({ secondaryKeysText: ev.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>content 内容</span>
                  <textarea
                    rows={5}
                    value={draft.content}
                    onChange={(ev) => setDraftField({ content: ev.target.value })}
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
                        onChange={(ev) => setDraftField({ [key]: ev.target.checked } as Partial<LoreDraft>)}
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
                        setDraftField({ order: Number.isFinite(n) ? n : 0 });
                      }}
                    />
                  </label>
                </div>
                <div className="row">
                  <button className="primary" onClick={() => void saveDraft()}>
                    保存词条
                  </button>
                  <button onClick={() => setDraft(draftFromEntry(e))}>重置</button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* 匹配调试台 */}
      <section className="panel">
        <h3>匹配调试台</h3>
        <p className="muted">
          每行一条消息，格式「谁：说了什么」（全角/半角冒号均可；无冒号整行视为内容）。
          按当前参数（scanDepth={project.lorebook.scanDepth}，tokenBudget={budget}
          {project.lorebook.recursiveScanning ? "，递归扫描开" : "，递归扫描关"}）对全部词条跑一次
          matchLore。概率骰使用 Math.random，重跑结果可能不同。
        </p>
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
          <span className="muted">共 {entries.length} 条词条参与匹配</span>
        </div>

        {result && (
          <div style={{ display: "grid", gap: 10, marginTop: 12 }}>
            {/* 预算进度条 */}
            <div className="row">
              <span className="muted">usedTokens / tokenBudget</span>
              <div
                style={{
                  flex: 1,
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
              <span className="muted">
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
      </section>
    </div>
  );
}
