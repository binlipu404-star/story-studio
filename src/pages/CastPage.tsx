// ============================================================
// story-studio — 人物卡全局库页（CastPage，v4 顶层菜单）
// v4：人物卡是**全局资产库**，与 RP 剧场同级；作品侧在「作品工作台 → 📦 资产」里
// 勾选选用（Project.castIds），本页不再接受 projectId prop。
// - 列表行：名称 + source / cardFormat 徽标 + 主场徽标 + 被 N 作品用 + greeting 首行预览；
//   行上有 名称/主场 过滤（规模化：100+ 卡时可用）。
// - 规模化：行抽成 memo 组件（编辑草稿只重渲编辑行），名称 ellipsis 三件套防溢出。
// - 导入角色卡：多选 .png/.json → importCardBytes → parsedCardToCharacter → repos.addCharacter
//   （主场=全局 ''）；逐文件容错（红行列文件名+原因，至多展示 10 条）。
//   勾选「随卡导入世界书」（默认开）时，卡内 character_book 以 repos.nextUid 为起点
//   重新起号后落全局词条库（主场 ''，忽略卡内自带 uid/id，防撞主键）。
// - 导出卡：exportCardV2（rawCard roundtrip 由 st/card 负责）→ Blob 下载 `${name}.json`。
// - 新建：repos.addCharacter('', …) 建全局空白卡 → 自动展开编辑并聚焦姓名（pendingFocusName）。
// - 删除：confirm 名称截断 20 字 + 提示被 N 个作品选用（全局删除会同时从各作品选用列表摘除）。
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
import type { Character, Project, RawLorebook } from "../core/types";
import { exportCardV2, importCardBytes, parsedCardToCharacter } from "../st/card";
import { toLoreEntries } from "../st/lorebook";
import * as repos from "../store/repos";
import { db } from "../store/db";
import { downloadJson, errMsg } from "../core/uiUtils";
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

/** confirm/徽标里的名字截断（审计 P1：长名弹窗不可读） */
function shortName(name: string, n = 20): string {
  const t = name.trim() || "（未命名）";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** greeting 首行预览：第一条非空行 */
function firstLine(text: string | undefined): string {
  if (!text) return "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

/** 下载文件名兜底：剔除路径非法字符 */
function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, "_").trim();
  return cleaned || "character";
}

const SOURCE_TITLES: Record<string, string> = {
  "st-import": "来源：ST 导入",
  manual: "来源：手动创建",
  ai: "来源：AI 生成",
};

function Badge({ text, title }: { text: string; title?: string }) {
  return (
    <span style={BADGE_STYLE} title={title}>
      {text}
    </span>
  );
}

// ---------- 编辑草稿 ----------

interface CharDraft {
  name: string;
  appearance: string;
  personality: string;
  background: string;
  speechStyle: string;
  exampleLinesText: string; // exampleLines 一行一条
  scenario: string;
  greeting: string;
}

function draftFromChar(c: Character): CharDraft {
  return {
    name: c.name,
    appearance: c.profile.appearance,
    personality: c.profile.personality,
    background: c.profile.background,
    speechStyle: c.profile.speechStyle,
    exampleLinesText: c.profile.exampleLines.join("\n"),
    scenario: c.scenario ?? "",
    greeting: c.greeting ?? "",
  };
}

// ============================================================
// 列表行（memo：编辑草稿每击键只重渲编辑行，非编辑行 props 不变即跳过）
// ============================================================

interface CastRowProps {
  c: Character;
  editing: boolean;
  draft: CharDraft | null;
  homeLabel: string; // 主场作品名（'' = 全局）
  usedBy: number; // 用到该卡的作品数（自有+选用）
  nameInputRef?: React.RefObject<HTMLInputElement>; // 仅编辑行传入
  onToggle: (c: Character) => void;
  onDraftField: (patch: Partial<CharDraft>) => void;
  onSave: () => void;
  onReset: (c: Character) => void;
  onExport: (c: Character) => void;
  onRemove: (c: Character) => void;
}

const CastRow = memo(function CastRow(p: CastRowProps) {
  const { c, editing, draft } = p;
  const preview = firstLine(c.greeting);
  return (
    <div className="panel">
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button onClick={() => p.onToggle(c)}>{editing ? "收起" : "展开编辑"}</button>
        <span style={ELLIPSIS_STYLE} title={c.name}>
          <strong>{shortName(c.name, 40)}</strong>
        </span>
        <Badge text={c.source} title={SOURCE_TITLES[c.source] ?? c.source} />
        <Badge text={c.cardFormat} title="卡格式" />
        <Badge text={`主场·${p.homeLabel}`} title="资产的主场作品；删除资产会影响所有选用它的作品" />
        {p.usedBy >= 2 && <Badge text={`被 ${p.usedBy} 作品用`} title="自有该卡的作品 + 选用它的作品" />}
        <span className="muted" style={{ ...ELLIPSIS_STYLE, flex: "1 1 120px" }} title={preview.slice(0, 100)}>
          {preview || "（无开场白）"}
        </span>
        <span style={{ marginLeft: "auto" }} className="row">
          <button onClick={() => p.onExport(c)}>导出卡</button>
          <button onClick={() => void p.onRemove(c)}>删除</button>
        </span>
      </div>

      {editing && draft && (
        <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
          <label className="field">
            <span>name（角色名）</span>
            <input
              ref={p.nameInputRef}
              value={draft.name}
              onChange={(e) => p.onDraftField({ name: e.target.value })}
              placeholder="角色名"
            />
          </label>
          <div className="grid2">
            <label className="field">
              <span>外貌 appearance</span>
              <textarea
                rows={3}
                value={draft.appearance}
                onChange={(e) => p.onDraftField({ appearance: e.target.value })}
              />
            </label>
            <label className="field">
              <span>性格 personality</span>
              <textarea
                rows={3}
                value={draft.personality}
                onChange={(e) => p.onDraftField({ personality: e.target.value })}
              />
            </label>
            <label className="field">
              <span>背景 background</span>
              <textarea
                rows={3}
                value={draft.background}
                onChange={(e) => p.onDraftField({ background: e.target.value })}
              />
            </label>
            <label className="field">
              <span>说话风格 speechStyle</span>
              <textarea
                rows={3}
                value={draft.speechStyle}
                onChange={(e) => p.onDraftField({ speechStyle: e.target.value })}
              />
            </label>
          </div>
          <label className="field">
            <span>对话示例 exampleLines（一行一条）</span>
            <textarea
              rows={4}
              value={draft.exampleLinesText}
              onChange={(e) => p.onDraftField({ exampleLinesText: e.target.value })}
              placeholder={"一行一条，例如：\n我从不食言。"}
            />
          </label>
          <label className="field">
            <span>scenario（场景设定）</span>
            <textarea
              rows={2}
              value={draft.scenario}
              onChange={(e) => p.onDraftField({ scenario: e.target.value })}
            />
          </label>
          <label className="field">
            <span>greeting（开场白 first_mes）</span>
            <textarea
              rows={3}
              value={draft.greeting}
              onChange={(e) => p.onDraftField({ greeting: e.target.value })}
            />
          </label>
          <div className="row">
            <button className="primary" onClick={() => void p.onSave()}>
              保存
            </button>
            <button onClick={() => p.onReset(c)}>重置</button>
          </div>
        </div>
      )}
    </div>
  );
});

// ============================================================

const GLOBAL_SCOPE = "global"; // 本页进度桶键（不再是 projectId）

export function CastPage() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [withBook, setWithBook] = useState(true); // 随卡导入世界书（默认勾选）
  const [flash, setFlash] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CharDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingFocusName, setPendingFocusName] = useState(false); // 新建后置 true，聚焦成功即复位
  const [q, setQ] = useState(""); // 名称过滤（规模化：100+ 卡）
  const [homeFilter, setHomeFilter] = useState<string>("*"); // '*'=全部 | ''=全局 | projectId
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null); // 同时刻至多一个展开面板，单 ref 足够

  const refresh = useCallback(async () => {
    try {
      const [chars, projs] = await Promise.all([repos.listAllCharacters(), repos.listProjects()]);
      setCharacters(chars);
      setProjects(projs);
      setLoadError(null);
    } catch (err) {
      setLoadError(errMsg(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // v3.1-② 进度记忆：展开编辑中的卡（全局页用固定桶键），数据就绪后恢复一次。
  const selRestoredFor = useRef(false);
  useEffect(() => {
    if (!loaded || selRestoredFor.current) return;
    selRestoredFor.current = true;
    const saved = loadProgress<{ editingId?: string }>("cast", GLOBAL_SCOPE);
    if (!saved?.editingId) return;
    const c = characters.find((x) => x.id === saved.editingId);
    if (!c) return;
    setEditingId(c.id);
    setDraft(draftFromChar(c));
  }, [loaded, characters]);
  useEffect(() => {
    if (!loaded || !selRestoredFor.current) return;
    saveProgress("cast", GLOBAL_SCOPE, { editingId });
  }, [loaded, editingId]);

  // 新建人物卡后：等编辑面板挂载、nameInputRef 就绪，聚焦姓名输入框一次。
  useEffect(() => {
    if (!pendingFocusName || editingId === null || draft === null) return;
    const el = nameInputRef.current;
    if (el) {
      el.focus();
      setPendingFocusName(false);
    }
  }, [pendingFocusName, editingId, draft]);

  // ---- 派生：主场名 / 被 N 作品用 / 过滤视图 ----
  const titleById = useMemo(() => new Map(projects.map((p) => [p.id, p.title])), [projects]);
  const usedByMap = useMemo(() => {
    const m = new Map<string, number>();
    const bump = (id: string) => m.set(id, (m.get(id) ?? 0) + 1);
    for (const p of projects) {
      for (const c of characters) if (c.projectId === p.id) bump(c.id);
      for (const id of p.castIds ?? []) bump(id);
    }
    return m;
  }, [projects, characters]);
  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return characters.filter(
      (c) =>
        (homeFilter === "*" || c.projectId === homeFilter) &&
        (!needle || c.name.toLowerCase().includes(needle)),
    );
  }, [characters, q, homeFilter]);

  // ---- 行回调（全部 useCallback 稳定，配合 CastRow memo 跳过非编辑行）----
  // memo 稳定引用：编辑态经 ref 读取，回调本体永不换新
  const editingIdRef = useRef(editingId);
  editingIdRef.current = editingId;
  const onToggle = useCallback((c: Character) => {
    if (editingIdRef.current === c.id) {
      setEditingId(null);
      setDraft(null);
      return;
    }
    setEditingId(c.id);
    setDraft(draftFromChar(c));
  }, []);
  const onDraftField = useCallback(
    (patch: Partial<CharDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d)),
    [],
  );
  const onReset = useCallback((c: Character) => setDraft(draftFromChar(c)), []);
  const onExport = useCallback((c: Character) => {
    downloadJson(`${safeFileName(c.name)}.json`, exportCardV2(c));
  }, []);

  /** 新建空白人物卡（主场=全局）：建卡 → 刷新列表 → 展开该卡编辑 → 聚焦姓名输入框。 */
  const createBlank = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const ch = await repos.addCharacter("", {
        name: "新人物",
        profile: { appearance: "", personality: "", background: "", speechStyle: "", exampleLines: [] },
        source: "manual",
        cardFormat: "internal",
      });
      await refresh();
      setEditingId(ch.id);
      setDraft(draftFromChar(ch));
      setPendingFocusName(true);
      setFlash(`已新建全局卡「${ch.name || "未命名"}」，在各作品的「📦 资产」页签里勾选后即可使用。`);
    } catch (err) {
      setFlash(`新建人物卡失败：${errMsg(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const saveDraft = async () => {
    if (!editingId || !draft) return;
    try {
      await repos.updateCharacter(editingId, {
        name: draft.name.trim(),
        profile: {
          appearance: draft.appearance,
          personality: draft.personality,
          background: draft.background,
          speechStyle: draft.speechStyle,
          exampleLines: draft.exampleLinesText
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
        },
        scenario: draft.scenario,
        greeting: draft.greeting,
      });
      await refresh();
      setFlash(`已保存「${shortName(draft.name)}」`);
    } catch (err) {
      setFlash(`保存失败：${errMsg(err)}`);
    }
  };
  // memo 稳定引用：saveDraft 经 ref 转接（editingIdRef 已在上方 onToggle 处声明）
  const saveDraftRef = useRef(saveDraft);
  saveDraftRef.current = saveDraft;
  const onSaveStable = useCallback(() => void saveDraftRef.current(), []);

  const onRemove = async (c: Character) => {
    const n = usedByMap.get(c.id) ?? 0;
    const hint = n >= 2 ? `它正被 ${n} 个作品使用，删除后各作品会自动解除引用。` : "";
    if (!window.confirm(`删除人物「${shortName(c.name)}」？${hint}此操作不可恢复。`)) return;
    try {
      const wasEditing = editingIdRef.current === c.id;
      await repos.removeCharacter(c.id);
      if (wasEditing) {
        setEditingId(null);
        setDraft(null);
      }
      await refresh();
    } catch (err) {
      setFlash(`删除失败：${errMsg(err)}`);
    }
  };
  const removeRef = useRef(onRemove);
  removeRef.current = onRemove;
  const onRemoveStable = useCallback((c: Character) => void removeRef.current(c), []);

  /** 卡内嵌书落全局词条库（主场 ''）：统一从 nextUid 起号（忽略卡内自带 uid/id），返回新增条数 */
  const addEmbeddedBook = async (book: RawLorebook): Promise<number> => {
    const start = await repos.nextUid();
    const renumbered: RawLorebook = {
      ...book,
      entries: book.entries.map((e) => ({ ...e, uid: undefined })),
    };
    const rows = toLoreEntries(renumbered, "", start);
    if (rows.length > 0) await db.loreEntries.bulkAdd(rows);
    return rows.length;
  };

  const onImportFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许连续两次选同一文件
    if (files.length === 0) return;
    setBusy(true);
    const errs: string[] = [];
    let ok = 0;
    let loreAdded = 0;
    let booksWith = 0;
    for (const file of files) {
      try {
        const buf = await file.arrayBuffer();
        const parsed = await importCardBytes(file.name, buf);
        const ch = parsedCardToCharacter(parsed, "");
        await repos.addCharacter("", {
          name: ch.name,
          profile: ch.profile,
          scenario: ch.scenario,
          greeting: ch.greeting,
          mesExample: ch.mesExample,
          source: "st-import",
          rawCard: parsed.raw,
          cardFormat: parsed.format,
        });
        const book = parsed.embeddedBook;
        if (withBook && book && book.entries.length > 0) {
          loreAdded += await addEmbeddedBook(book);
          booksWith += 1;
        }
        ok += 1;
      } catch (err) {
        errs.push(`${file.name}：${errMsg(err)}`);
      }
    }
    setBusy(false);
    setImportErrors(errs);
    if (ok > 0) await refresh();
    if (ok > 0 || errs.length > 0) {
      const parts = [`成功导入 ${ok} / ${files.length} 张角色卡`];
      if (booksWith > 0) parts.push(`随卡带入 ${booksWith} 本世界书共 ${loreAdded} 条词条`);
      if (errs.length > 0) parts.push(`失败 ${errs.length} 个（见下方红行）`);
      setFlash(parts.join("；"));
    }
  };

  return (
    <div>
      <section className="panel">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="primary" disabled={creating} onClick={() => void createBlank()}>
            {creating ? "创建中…" : "＋ 新建人物卡"}
          </button>
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "导入中…" : "导入角色卡"}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".png,.json"
            style={{ display: "none" }}
            onChange={(e) => void onImportFiles(e)}
          />
          <label className="row" style={{ gap: 4, fontSize: 13, color: "var(--muted)" }}>
            <input type="checkbox" checked={withBook} onChange={(e) => setWithBook(e.target.checked)} />
            随卡导入世界书（character_book）
          </label>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          <input
            style={{ flex: "1 1 200px", minWidth: 0, maxWidth: 360 }}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="按名称过滤…"
          />
          <select value={homeFilter} onChange={(e) => setHomeFilter(e.target.value)}>
            <option value="*">主场：全部（{characters.length}）</option>
            <option value="">主场：全局直建</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                主场：{shortName(p.title, 24)}
              </option>
            ))}
          </select>
          <span className="muted">
            全局卡库 {characters.length} 张，当前视图 {visible.length} 张
          </span>
        </div>
        {flash && <p className="muted">{flash}</p>}
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

      {loadError && <p className="panel">人物列表加载失败：{loadError}</p>}

      {!loadError && loaded && characters.length === 0 && (
        <p className="panel muted">
          全局卡库是空的。点上方「＋ 新建人物卡」手动创建一张空白卡，或导入 SillyTavern 导出的
          .png / .json 角色卡；建好后到各作品的「📦 资产」页签里勾选选用，作品才能用到它们。
        </p>
      )}
      {!loadError && loaded && characters.length > 0 && visible.length === 0 && (
        <p className="panel muted">当前过滤条件下没有匹配的人物卡。</p>
      )}

      {visible.map((c) => (
        <CastRow
          key={c.id}
          c={c}
          editing={editingId === c.id && draft !== null}
          draft={editingId === c.id ? draft : null}
          homeLabel={c.projectId ? titleById.get(c.projectId) ?? "（已删作品）" : "全局"}
          usedBy={usedByMap.get(c.id) ?? 0}
          nameInputRef={editingId === c.id ? nameInputRef : undefined}
          onToggle={onToggle}
          onDraftField={onDraftField}
          onSave={onSaveStable}
          onReset={onReset}
          onExport={onExport}
          onRemove={onRemoveStable}
        />
      ))}
    </div>
  );
}
