// ============================================================
// story-studio — 用户画像管理页（PersonasPage）
// 画像是全局数据（跨作品）：表示「玩家自己在故事里的形象」（{{user}}），故本页不接受 projectId。
// - 列表行：⭐（默认画像）+ 名称 + source 徽标 + 描述前 40 字摘要 + 更新时间；
//   操作：编辑（行内展开）/ 设为默认（当前默认行禁用）/ 删除（confirm）。
// - 新建：repos.addPersona({ name: "我的形象" }) → 刷新列表 → 自动展开该条编辑器并聚焦名称输入框
//   （pendingFocusName 状态驱动 useEffect，不用 autoFocus）。
// - 导入 ST 画像：多选 .json/.png → file.arrayBuffer() → importPersonaBytes（一个文件可返回多条种子，
//   ST 画像导出文件是一条对多条）→ 每条 repos.addPersona({..., source:"st-import", rawCard: seed.raw })；
//   某批 seed 中若有 isDefault=true，落库后对该批第一条调 setDefaultPersona。重名不去重，照常导入。
// - 编辑器：名称 + 画像正文/外貌/性格/备注四个 textarea；保存前统一 trim，名称为空报错。
//   编辑区下方只读 <pre> 实时预览 personaPromptBlock 注入文本（按当前草稿值）。
// ============================================================
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import type { Persona } from "../core/types";
import { personaPromptBlock } from "../ai/prompts";
import { importPersonaBytes } from "../st/persona";
import * as repos from "../store/repos";
import { errMsg, formatTime } from "../core/uiUtils";
import { loadProgress, saveProgress } from "../flow/progress";

// ---------- 小工具 ----------

const BADGE_STYLE: CSSProperties = {
  fontSize: 12,
  lineHeight: "18px",
  padding: "0 6px",
  borderRadius: 6,
  border: "1px solid var(--line)",
  color: "var(--muted)",
  whiteSpace: "nowrap",
};

const PREVIEW_STYLE: CSSProperties = {
  margin: 0,
  padding: "10px 12px",
  border: "1px solid var(--line)",
  borderRadius: 8,
  background: "var(--panel)",
  color: "var(--muted)",
  fontSize: 13,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

const ELLIPSIS_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/** 描述摘要：压平空白后取前 n 字 */
function summarize(text: string, n = 40): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function Badge({ text, title }: { text: string; title?: string }) {
  return (
    <span style={BADGE_STYLE} title={title}>
      {text}
    </span>
  );
}

const SOURCE_LABELS: Record<Persona["source"], string> = {
  manual: "手动",
  "st-import": "ST 导入",
};

// ---------- 编辑草稿 ----------

interface PersonaDraft {
  name: string;
  description: string;
  appearance: string;
  personality: string;
  notes: string;
}

function draftFromPersona(p: Persona): PersonaDraft {
  return {
    name: p.name,
    description: p.description,
    appearance: p.appearance,
    personality: p.personality,
    notes: p.notes,
  };
}

// ============================================================

export function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PersonaDraft | null>(null);
  const [pendingFocusName, setPendingFocusName] = useState(false); // 新建后置 true，聚焦成功即复位
  const fileRef = useRef<HTMLInputElement | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null); // 同时刻至多一个展开编辑器，单 ref 足够

  const refresh = useCallback(async () => {
    try {
      setPersonas(await repos.listPersonas());
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // v3.1-② 进度记忆：展开编辑中的画像，数据就绪（loaded）后恢复一次。
  // 校验保存的 id 仍在现有列表里（防已删画像）；draft 由库内现值重建，不存草稿大对象。
  const selRestored = useRef(false);
  useEffect(() => {
    if (!loaded || selRestored.current) return;
    selRestored.current = true;
    const saved = loadProgress<{ editingId?: string }>("personas");
    if (!saved?.editingId) return;
    const p = personas.find((x) => x.id === saved.editingId);
    if (!p) return;
    setEditingId(p.id);
    setDraft(draftFromPersona(p));
  }, [loaded, personas]);
  useEffect(() => {
    if (!loaded || !selRestored.current) return;
    saveProgress("personas", undefined, { editingId });
  }, [loaded, editingId]);

  // 新建画像后：等编辑器挂载、nameInputRef 就绪，聚焦名称输入框一次。
  useEffect(() => {
    if (!pendingFocusName || editingId === null || draft === null) return;
    const el = nameInputRef.current;
    if (el) {
      el.focus();
      setPendingFocusName(false);
    }
  }, [pendingFocusName, editingId, draft]);

  const setDraftField = (patch: Partial<PersonaDraft>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const toggleEdit = (p: Persona) => {
    if (editingId === p.id) {
      setEditingId(null);
      setDraft(null);
      return;
    }
    setEditingId(p.id);
    setDraft(draftFromPersona(p));
  };

  /** 新建画像：落库 → 刷新列表 → 展开该条编辑器 → 聚焦名称输入框。 */
  const createOne = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const p = await repos.addPersona({ name: "我的形象" });
      await refresh();
      setEditingId(p.id);
      setDraft(draftFromPersona(p));
      setPendingFocusName(true);
      setMsg(`已新建「${p.name || "未命名"}」，填好后点「保存」。`);
      setErr(null);
    } catch (e) {
      setErr(`新建画像失败：${errMsg(e)}`);
    } finally {
      setCreating(false);
    }
  };

  const saveDraft = async () => {
    if (!editingId || !draft) return;
    const name = draft.name.trim();
    if (!name) {
      setErr("名称不能为空，请先填写画像名称再保存。");
      return;
    }
    try {
      await repos.updatePersona(editingId, {
        name,
        description: draft.description.trim(),
        appearance: draft.appearance.trim(),
        personality: draft.personality.trim(),
        notes: draft.notes.trim(),
      });
      await refresh();
      setMsg(`已保存「${name}」`);
      setErr(null);
    } catch (e) {
      setErr(`保存失败：${errMsg(e)}`);
    }
  };

  const makeDefault = async (p: Persona) => {
    try {
      await repos.setDefaultPersona(p.id);
      await refresh();
      setMsg(`已把「${p.name || "未命名"}」设为默认画像。`);
      setErr(null);
    } catch (e) {
      setErr(`设为默认失败：${errMsg(e)}`);
    }
  };

  const removeOne = async (p: Persona) => {
    if (!window.confirm(`确定删除画像「${p.name.trim() || "（未命名）"}」？`)) return;
    try {
      await repos.removePersona(p.id);
      if (editingId === p.id) {
        setEditingId(null);
        setDraft(null);
      }
      await refresh();
      setMsg(`已删除「${p.name || "未命名"}」。`);
      setErr(null);
    } catch (e) {
      setErr(`删除失败：${errMsg(e)}`);
    }
  };

  /** 导入 ST 画像导出文件 / 角色卡：逐文件容错，一个文件可落多条。 */
  const onImportFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允许连续两次选同一文件
    if (files.length === 0) return;
    setBusy(true);
    const errs: string[] = [];
    let fileOk = 0;
    let added = 0;
    for (const file of files) {
      try {
        const bytes = await file.arrayBuffer();
        const seeds = await importPersonaBytes(file.name, bytes);
        if (seeds.length === 0) throw new Error("文件里没有可识别的画像");
        let firstDefaultId: string | null = null;
        for (const seed of seeds) {
          const created = await repos.addPersona({
            name: seed.name,
            description: seed.description,
            appearance: seed.appearance,
            personality: seed.personality,
            notes: seed.notes,
            source: "st-import",
            rawCard: seed.raw,
          });
          if (seed.isDefault && firstDefaultId === null) firstDefaultId = created.id;
          added += 1;
        }
        if (firstDefaultId !== null) await repos.setDefaultPersona(firstDefaultId);
        fileOk += 1;
      } catch (e2) {
        errs.push(`${file.name}：${errMsg(e2)}`);
      }
    }
    setBusy(false);
    await refresh();
    const parts = [`已从 ${fileOk} / ${files.length} 个文件导入 ${added} 条画像`];
    if (errs.length > 0) parts.push(`失败 ${errs.length} 个文件`);
    setMsg(parts.join("；"));
    setErr(errs.length > 0 ? `导入失败 — ${errs.join("；")}` : null);
  };

  const previewBlock = draft
    ? personaPromptBlock({
        name: draft.name.trim(),
        description: draft.description.trim(),
        appearance: draft.appearance.trim(),
        personality: draft.personality.trim(),
        notes: draft.notes.trim(),
      })
    : "";

  return (
    <div>
      <section className="panel">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <button className="primary" disabled={creating} onClick={() => void createOne()}>
            {creating ? "创建中…" : "＋ 新建画像"}
          </button>
          <button className="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? "导入中…" : "📥 导入 ST 画像"}
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept=".json,.png"
            style={{ display: "none" }}
            onChange={(e) => void onImportFiles(e)}
          />
          <span className="muted">画像全局共享（跨作品），决定 {'{{user}}'} 在故事里的形象。</span>
          <button onClick={() => void refresh()}>刷新</button>
        </div>
        {msg && <p className="muted">{msg}</p>}
        {err && <p className="muted" style={{ color: "#b3261e" }}>{err}</p>}
      </section>

      {loaded && personas.length === 0 && (
        <p className="panel muted">
          还没有用户画像。点「＋ 新建画像」手动创建一个（这是你在故事里的形象 ——
          名字、身份背景、外貌、性格），或点「📥 导入 ST 画像」导入 SillyTavern 导出的画像文件
          personas_*.json；也可导入任意角色卡（.png / .json），卡上的名字与正文会被转成一条画像。
        </p>
      )}

      {personas.map((p) => {
        const editing = editingId === p.id && draft !== null;
        const summary = summarize(p.description);
        return (
          <div className="panel" key={p.id}>
            <div className="row">
              <button onClick={() => toggleEdit(p)}>{editing ? "收起" : "编辑"}</button>
              <strong>
                {p.isDefault && "⭐ "}
                {p.name || <span className="muted">（未命名）</span>}
              </strong>
              <Badge text={SOURCE_LABELS[p.source] ?? p.source} title={`来源：${p.source}`} />
              <span className="muted" style={ELLIPSIS_STYLE} title={p.description}>
                {summary || "（暂无画像正文）"}
              </span>
              <span className="muted">更新于 {formatTime(p.updatedAt)}</span>
              <button disabled={p.isDefault} onClick={() => void makeDefault(p)}>
                {p.isDefault ? "已是默认" : "设为默认"}
              </button>
              <button style={{ color: "#b3261e" }} onClick={() => void removeOne(p)}>
                删除
              </button>
            </div>

            {editing && draft && (
              <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
                <label className="field">
                  <span>名称（{'{{user}}'} 显示名）</span>
                  <input
                    ref={nameInputRef}
                    value={draft.name}
                    onChange={(e) => setDraftField({ name: e.target.value })}
                    placeholder="你在故事里的名字"
                  />
                </label>
                <label className="field">
                  <span>画像正文 description（身份 / 背景 / 与角色的关系）</span>
                  <textarea
                    rows={8}
                    value={draft.description}
                    onChange={(e) => setDraftField({ description: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span>外貌 appearance</span>
                  <textarea
                    rows={3}
                    value={draft.appearance}
                    onChange={(e) => setDraftField({ appearance: e.target.value })}
                    placeholder="可留空"
                  />
                </label>
                <label className="field">
                  <span>性格 personality</span>
                  <textarea
                    rows={3}
                    value={draft.personality}
                    onChange={(e) => setDraftField({ personality: e.target.value })}
                    placeholder="可留空"
                  />
                </label>
                <label className="field">
                  <span>备注 notes（禁忌 / 使用备注）</span>
                  <textarea
                    rows={3}
                    value={draft.notes}
                    onChange={(e) => setDraftField({ notes: e.target.value })}
                    placeholder="可留空"
                  />
                </label>
                <div className="row">
                  <button className="primary" onClick={() => void saveDraft()}>
                    保存
                  </button>
                  <button
                    onClick={() => {
                      setEditingId(null);
                      setDraft(null);
                    }}
                  >
                    取消
                  </button>
                </div>
                <label className="field">
                  <span>注入预览（prompt 片段，只读）</span>
                  <pre style={PREVIEW_STYLE}>{previewBlock || "（填名称/正文后这里会显示最终注入模型的形象文本）"}</pre>
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
