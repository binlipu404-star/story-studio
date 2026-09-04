// ============================================================
// story-studio — 人物卡管理页（CastPage）
// - 列表行：名称 + source / cardFormat 徽标 + greeting 首行预览；
//   展开 = 本地 draft 编辑（name + profile 五字段 + scenario + greeting），保存走 repos.updateCharacter。
// - 导入角色卡：多选 .png/.json → importCardBytes → parsedCardToCharacter → repos.addCharacter；
//   逐文件容错（红行列文件名+原因）。勾选「随卡导入世界书」（默认开）时，
//   卡内 character_book 以 repos.nextUid 为起点重新起号后 db.loreEntries.bulkAdd
//   （忽略卡内自带 uid/id，避免与现有词条撞主键导致整批失败）。
// - 导出卡：exportCardV2（rawCard roundtrip 由 st/card 负责）→ Blob 下载 `${name}.json`。
// - 新建人物卡：repos.addCharacter 建空白卡（source="manual"、cardFormat="internal"、name=「新人物」、
//   profile 五字段全空）→ 刷新列表 → 自动展开该卡编辑面板并聚焦姓名输入框（pendingFocusName 状态驱动）。
// ============================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { Character, RawLorebook } from "../core/types";
import { exportCardV2, importCardBytes, parsedCardToCharacter } from "../st/card";
import { toLoreEntries } from "../st/lorebook";
import * as repos from "../store/repos";
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

export function CastPage({ projectId }: { projectId: string }) {
  const [characters, setCharacters] = useState<Character[]>([]);
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
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null); // 同时刻至多一个展开面板，单 ref 足够

  const refresh = useCallback(async () => {
    try {
      setCharacters(await repos.listCharacters(projectId));
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

  // v3.1-② 进度记忆：展开编辑中的人物卡，数据就绪（loaded）后恢复一次。
  // 校验保存的 id 仍在现有列表里（防已删卡）；draft 由库内现值重建，不存草稿大对象。
  const selRestoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!loaded || selRestoredFor.current === projectId) return;
    selRestoredFor.current = projectId;
    const saved = loadProgress<{ editingId?: string }>("cast", projectId);
    if (!saved?.editingId) return;
    const c = characters.find((x) => x.id === saved.editingId);
    if (!c) return;
    setEditingId(c.id);
    setDraft(draftFromChar(c));
  }, [loaded, characters, projectId]);
  useEffect(() => {
    if (!loaded || selRestoredFor.current !== projectId) return;
    saveProgress("cast", projectId, { editingId });
  }, [loaded, projectId, editingId]);

  // 新建人物卡后：等编辑面板挂载、nameInputRef 就绪，聚焦姓名输入框一次。
  useEffect(() => {
    if (!pendingFocusName || editingId === null || draft === null) return;
    const el = nameInputRef.current;
    if (el) {
      el.focus();
      setPendingFocusName(false);
    }
  }, [pendingFocusName, editingId, draft]);

  const setDraftField = (patch: Partial<CharDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const toggleEdit = (c: Character) => {
    if (editingId === c.id) {
      setEditingId(null);
      setDraft(null);
      return;
    }
    setEditingId(c.id);
    setDraft(draftFromChar(c));
  };

  /** 新建空白人物卡：建卡 → 刷新列表 → 展开该卡编辑 → 聚焦姓名输入框。 */
  const createBlank = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const ch = await repos.addCharacter(projectId, {
        name: "新人物",
        profile: { appearance: "", personality: "", background: "", speechStyle: "", exampleLines: [] },
        state: "",
        source: "manual",
        cardFormat: "internal",
      });
      await refresh();
      setEditingId(ch.id);
      setDraft(draftFromChar(ch));
      setPendingFocusName(true);
      setFlash(`已新建「${ch.name || "未命名"}」，填好后点「保存」。`);
    } catch (err) {
      setFlash(`新建人物卡失败：${errMsg(err)}`);
    } finally {
      setCreating(false);
    }
  };

  const saveDraft = async () => {
    if (!editingId || !draft) return;
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
    setFlash(`已保存「${draft.name.trim() || "未命名"}」`);
  };

  const exportOne = (c: Character) => {
    downloadJson(`${safeFileName(c.name)}.json`, exportCardV2(c));
  };

  const removeOne = async (c: Character) => {
    if (!window.confirm(`删除人物「${c.name || "（未命名）"}」？此操作不可恢复。`)) return;
    await repos.removeCharacter(c.id);
    if (editingId === c.id) {
      setEditingId(null);
      setDraft(null);
    }
    await refresh();
  };

  /** 卡内嵌书落库：统一从 nextUid 起号（忽略卡内自带 uid/id），返回新增条数 */
  const addEmbeddedBook = async (book: RawLorebook): Promise<number> => {
    const start = await repos.nextUid(projectId);
    const renumbered: RawLorebook = {
      ...book,
      entries: book.entries.map((e) => ({ ...e, uid: undefined })),
    };
    const rows = toLoreEntries(renumbered, projectId, start);
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
        const ch = parsedCardToCharacter(parsed, projectId);
        await repos.addCharacter(projectId, {
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
        {flash && <p className="muted">{flash}</p>}
        {importErrors.map((msg) => (
          <p key={msg} style={{ color: "#b42318", fontSize: 13, margin: "4px 0" }}>
            导入失败 — {msg}
          </p>
        ))}
      </section>

      {loadError && <p className="panel">人物列表加载失败：{loadError}</p>}

      {!loadError && loaded && characters.length === 0 && (
        <p className="panel muted">
          还没有人物卡。可点上方「＋ 新建人物卡」手动创建一张空白卡，或导入 SillyTavern 导出的 .png /
          .json 角色卡；也可以到「大纲工作台」里让 AI 生成人物（占位文案：功能即将上线）。
        </p>
      )}

      {characters.map((c) => {
        const editing = editingId === c.id && draft !== null;
        const preview = firstLine(c.greeting);
        return (
          <div className="panel" key={c.id}>
            <div className="row">
              <button onClick={() => toggleEdit(c)}>{editing ? "收起" : "展开编辑"}</button>
              <strong>{c.name || <span className="muted">（未命名）</span>}</strong>
              <Badge text={c.source} title={SOURCE_TITLES[c.source] ?? c.source} />
              <Badge text={c.cardFormat} title="卡格式" />
              <span
                className="muted"
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={c.greeting ?? ""}
              >
                {preview || "（无开场白）"}
              </span>
              <button onClick={() => exportOne(c)}>导出卡</button>
              <button onClick={() => void removeOne(c)}>删除</button>
            </div>

            {editing && draft && (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <label className="field">
                  <span>name（角色名）</span>
                  <input
                    ref={nameInputRef}
                    value={draft.name}
                    onChange={(e) => setDraftField({ name: e.target.value })}
                    placeholder="角色名"
                  />
                </label>
                <div className="grid2">
                  <label className="field">
                    <span>外貌 appearance</span>
                    <textarea
                      rows={3}
                      value={draft.appearance}
                      onChange={(e) => setDraftField({ appearance: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>性格 personality</span>
                    <textarea
                      rows={3}
                      value={draft.personality}
                      onChange={(e) => setDraftField({ personality: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>背景 background</span>
                    <textarea
                      rows={3}
                      value={draft.background}
                      onChange={(e) => setDraftField({ background: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>说话风格 speechStyle</span>
                    <textarea
                      rows={3}
                      value={draft.speechStyle}
                      onChange={(e) => setDraftField({ speechStyle: e.target.value })}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>对话示例 exampleLines（一行一条）</span>
                  <textarea
                    rows={4}
                    value={draft.exampleLinesText}
                    onChange={(e) => setDraftField({ exampleLinesText: e.target.value })}
                    placeholder={"一行一条，例如：\n我从不食言。"}
                  />
                </label>
                <label className="field">
                  <span>scenario（场景设定）</span>
                  <textarea
                    rows={2}
                    value={draft.scenario}
                    onChange={(e) => setDraftField({ scenario: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>greeting（开场白 first_mes）</span>
                  <textarea
                    rows={3}
                    value={draft.greeting}
                    onChange={(e) => setDraftField({ greeting: e.target.value })}
                  />
                </label>
                <div className="row">
                  <button className="primary" onClick={() => void saveDraft()}>
                    保存
                  </button>
                  <button onClick={() => setDraft(draftFromChar(c))}>重置</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
