// ============================================================
// story-studio — 作品侧「📦 资产」面板（v5）
// 人物卡/世界书是全局库（顶层菜单维护）；本面板是**作品级选用**视图：
//   - 自有资产（projectId=本作品的人物卡）恒可见、勾选框禁用（取消须去全局库改主场/删除）；
//   - 人物卡逐张勾选 → repos.selectCharacter 写 Project.castIds；
//   - v5：世界书按**整本**勾选 → repos.selectLoreBook 写 Project.loreBookIds（多本按勾选顺序拼接注入）；
//   - 规模化：搜索过滤 + Set 查找 + memo 行 + 滚动容器限高（500+ 可用）；
//   - 世界书参数（Project.lorebook，作品级）从旧世界书页迁移至此编辑。
// ============================================================
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { Character, LoreBook, LoreEntry, LorebookSettings, Project } from "../core/types";
import * as repos from "../store/repos";
import { errMsg } from "../core/uiUtils";

const ELLIPSIS_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

function shortLabel(t: string, n = 30): string {
  const s = t.trim() || "（未命名）";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- 勾选行（memo） ----------

const PickRow = memo(function PickRow(p: {
  id: string;
  label: string;
  own: boolean;
  selected: boolean;
  badge?: string;
  onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <label
      className="row"
      style={{ gap: 6, fontSize: 13, padding: "2px 0", opacity: p.own ? 0.7 : 1 }}
      title={p.own ? "本作品自有资产：恒可用，无需选用" : p.label}
    >
      <input
        type="checkbox"
        checked={p.own || p.selected}
        disabled={p.own}
        onChange={(e) => p.onToggle(p.id, e.target.checked)}
      />
      <span style={ELLIPSIS_STYLE}>{p.label}</span>
      {p.own ? (
        <span className="muted" style={{ flexShrink: 0 }}>自有</span>
      ) : (
        p.badge && <span className="muted" style={{ flexShrink: 0 }}>{p.badge}</span>
      )}
    </label>
  );
});

// ---------- 一个人物卡/词条的勾选列 ----------

function PickColumn(p: {
  title: string;
  empty: string;
  rows: { id: string; label: string; own: boolean; badge?: string }[];
  selectedSet: Set<string>;
  onToggle: (id: string, on: boolean) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return p.rows;
    return p.rows.filter((r) => r.label.toLowerCase().includes(needle));
  }, [p.rows, q]);
  const selCount = p.rows.reduce((n, r) => (r.own || p.selectedSet.has(r.id) ? n + 1 : n), 0);
  return (
    <div style={{ minWidth: 0, display: "grid", gap: 6 }}>
      <div className="row" style={{ gap: 8 }}>
        <strong style={{ flexShrink: 0 }}>{p.title}</strong>
        <span className="muted" style={{ flexShrink: 0 }}>
          可用 {selCount} / 共 {p.rows.length}
        </span>
      </div>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="搜索过滤…"
        style={{ minWidth: 0 }}
      />
      <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, padding: "6px 10px" }}>
        {p.rows.length === 0 && <div className="muted" style={{ fontSize: 13 }}>{p.empty}</div>}
        {p.rows.length > 0 && filtered.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>无匹配（{q}）</div>
        )}
        {filtered.map((r) => (
          <PickRow
            key={r.id}
            id={r.id}
            label={r.label}
            own={r.own}
            badge={r.badge}
            selected={p.selectedSet.has(r.id)}
            onToggle={p.onToggle}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================

export function ProjectAssetsPanel({ project, onProjectChanged }: { project: Project; onProjectChanged: (p: Project) => void }) {
  const [allChars, setAllChars] = useState<Character[]>([]);
  const [allBooks, setAllBooks] = useState<LoreBook[]>([]);
  const [allLore, setAllLore] = useState<LoreEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // 世界书参数草稿（作品级，Project.lorebook）
  const [params, setParams] = useState<{ scanDepth: string; tokenBudget: string; recursive: boolean }>({
    scanDepth: String(project.lorebook.scanDepth),
    tokenBudget: String(project.lorebook.tokenBudget),
    recursive: project.lorebook.recursiveScanning,
  });
  useEffect(() => {
    setParams({
      scanDepth: String(project.lorebook.scanDepth),
      tokenBudget: String(project.lorebook.tokenBudget),
      recursive: project.lorebook.recursiveScanning,
    });
  }, [project]);

  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const [chars, books, lore] = await Promise.all([
          repos.listAllCharacters(),
          repos.listLoreBooks(),
          repos.listAllLoreEntries(),
        ]);
        if (!dead) {
          setAllChars(chars);
          setAllBooks(books);
          setAllLore(lore);
          setError(null);
        }
      } catch (e) {
        if (!dead) setError(errMsg(e));
      }
    })();
    return () => {
      dead = true;
    };
  }, [project.id]);

  const castRows = useMemo(
    () =>
      allChars.map((c) => ({
        id: c.id,
        label: shortLabel(c.name, 40),
        own: c.projectId === project.id,
      })),
    [allChars, project.id],
  );
  // v5：世界书按「整本」选用。行 = 书；badge 显示 该书共 N 条 / 启用 M 条。
  const loreRows = useMemo(() => {
    const byBook = new Map<string, { total: number; enabled: number }>();
    for (const e of allLore) {
      const b = e.bookId ? byBook.get(e.bookId) : undefined;
      if (!e.bookId) continue;
      if (!b) byBook.set(e.bookId, { total: 1, enabled: e.enabled ? 1 : 0 });
      else {
        b.total += 1;
        if (e.enabled) b.enabled += 1;
      }
    }
    return allBooks.map((bk) => {
      const stat = byBook.get(bk.id) ?? { total: 0, enabled: 0 };
      return {
        id: bk.id,
        label: shortLabel(bk.name, 40),
        own: false, // 书是全局资产，恒属全局库；作品只做选用
        badge: `${stat.total} 条 / 启用 ${stat.enabled}`,
      };
    });
  }, [allBooks, allLore]);
  const castSet = useMemo(() => new Set(project.castIds ?? []), [project.castIds]);
  // v5：选用集合 = 书 id 列表
  const loreSet = useMemo(() => new Set(project.loreBookIds ?? []), [project.loreBookIds]);

  const reloadProject = useCallback(async () => {
    // 选用门面写库后回读校准（不动本地 project state 的所有者语义，单一事实源在 ProjectsPage）
    const updated = await repos.getProject(project.id);
    if (updated) onProjectChanged(updated);
  }, [project.id, onProjectChanged]);

  const onCastToggle = useCallback(
    (id: string, on: boolean) => {
      void (async () => {
        try {
          await repos.selectCharacter(project.id, id, on);
          await reloadProject();
          setMsg(on ? "已选用该人物卡" : "已取消选用（全局库里的卡本身不会被删）");
        } catch (e) {
          setError(errMsg(e));
        }
      })();
    },
    [project.id, reloadProject],
  );
  const onLoreToggle = useCallback(
    (id: string, on: boolean) => {
      void (async () => {
        try {
          await repos.selectLoreBook(project.id, id, on);
          await reloadProject();
          setMsg(on ? "已选用该世界书" : "已取消选用（全局库里的书本身不会被删）");
        } catch (e) {
          setError(errMsg(e));
        }
      })();
    },
    [project.id, reloadProject],
  );

  const saveParams = async () => {
    const sd = Math.floor(Number(params.scanDepth));
    const tb = Math.floor(Number(params.tokenBudget));
    const lorebook: LorebookSettings = {
      scanDepth: Number.isFinite(sd) && sd >= 1 ? sd : 1,
      tokenBudget: Number.isFinite(tb) && tb >= 0 ? tb : 0,
      recursiveScanning: params.recursive,
    };
    try {
      const updated = await repos.updateProject(project.id, { lorebook });
      if (updated) onProjectChanged(updated);
      setMsg("世界书参数已保存");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <section className="panel">
        <h3 style={{ marginTop: 0 }}>世界书参数（本作品）</h3>
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
              checked={params.recursive}
              onChange={(e) => setParams((p) => ({ ...p, recursive: e.target.checked }))}
            />
            recursiveScanning 递归扫描
          </label>
          <button className="primary" onClick={() => void saveParams()}>
            保存参数
          </button>
        </div>
      </section>

      <section className="panel">
        <p className="muted" style={{ marginTop: 0 }}>
          人物卡与世界书在顶层「👤 人物卡 / 📚 世界书」全局库里维护；这里选择本作品**选用**哪些。
          世界书按**整本**选用（多本按勾选顺序注入），人物卡逐张选用。自有资产恒可用，无需勾选。
        </p>
        {error && <p style={{ color: "#c62828", fontSize: 13 }}>{error}</p>}
        {msg && <p className="muted">{msg}</p>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          <PickColumn
            title="👤 人物卡"
            empty="全局卡库为空：去顶层「人物卡」页新建或导入"
            rows={castRows}
            selectedSet={castSet}
            onToggle={onCastToggle}
          />
          <PickColumn
            title="📚 世界书（整本选用）"
            empty="全局书库为空：去顶层「世界书」页导入一本世界书"
            rows={loreRows}
            selectedSet={loreSet}
            onToggle={onLoreToggle}
          />
        </div>
      </section>
    </div>
  );
}
