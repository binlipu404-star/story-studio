// ============================================================
// 台账页（N1）：已发生事实的唯一事实源的家。
//   待确认队列（recap 提案汇入）逐条 确认/编辑/驳回 · 伏笔欠账视图 ·
//   已确认时间线（溯源看原文） · 驳回区（可恢复）。
// 快照/欠账的计算全部走 flow/snapshot 纯逻辑；本页只做展示与裁决。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LedgerRecord, LedgerType, OutlineNode, RPSession } from "../core/types";
import * as repos from "../store/repos";
import { LEDGER_TYPE_NAMES, LEDGER_TYPES, debtText, foreshadowDebt } from "../flow/snapshot";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const TYPE_ICONS: Record<LedgerType, string> = {
  event: "📌",
  item: "🗡",
  relation: "🔗",
  foreshadow: "🧵",
  worldstate: "🌍",
};

function day(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function LedgerPage({ projectId }: { projectId: string }) {
  const [recs, setRecs] = useState<LedgerRecord[]>([]);
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [filter, setFilter] = useState<LedgerType | "">("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [provView, setProvView] = useState<{ id: string; text: string } | null>(null);
  const sessionsCache = useRef<RPSession[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [lr, nd] = await Promise.all([repos.listLedger(projectId), repos.listNodes(projectId)]);
      setRecs(lr);
      setNodes(nd);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = filter ? recs.filter((r) => r.type === filter) : recs;
  const proposed = shown.filter((r) => r.status === "proposed");
  const confirmed = shown.filter((r) => r.status === "confirmed");
  const rejected = shown.filter((r) => r.status === "rejected");
  const allConfirmedCount = recs.filter((r) => r.status === "confirmed").length;

  const debts = useMemo(() => foreshadowDebt(nodes, recs), [nodes, recs]);
  const openDebts = debts.filter((d) => d.status === "planted" && !d.paidByLedger);

  const decide = async (id: string, decision: "confirmed" | "rejected") => {
    try {
      await repos.decide(id, decision);
      await refresh();
      setInfo(decision === "confirmed" ? "已确认：进入正典事实。" : "已驳回：不再参与快照与注入。");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const saveEdit = async (id: string) => {
    const content = editText.trim();
    if (!content) return;
    try {
      await repos.editLedger(id, { content });
      setEditingId(null);
      await refresh();
      setInfo("已修正。");
    } catch (e) {
      setError(errMsg(e));
    }
  };

  /** 溯源：懒加载会话缓存，展示目标消息及其前后各一条 */
  const showProvenance = async (r: LedgerRecord) => {
    if (!r.provenance) return;
    try {
      if (!sessionsCache.current) sessionsCache.current = await repos.listSessions(projectId);
      const sess = sessionsCache.current.find((s) => s.id === r.provenance?.sessionId);
      if (!sess) {
        setProvView({ id: r.id, text: "（源会话已删除，无法回看）" });
        return;
      }
      const idx = sess.messages.findIndex((m) => m.id === r.provenance?.msgId);
      if (idx < 0) {
        setProvView({ id: r.id, text: "（源消息不在此会话中：可能被分支或编辑替换）" });
        return;
      }
      const around = sess.messages.slice(Math.max(0, idx - 1), idx + 2);
      setProvView({
        id: r.id,
        text: around.map((m) => `${m.id === r.provenance?.msgId ? "▶" : " "} ${m.name || m.role}：${clip(m.content, 150)}`).join("\n"),
      });
    } catch (e) {
      setError(errMsg(e));
    }
  };

  // 时间线：已确认按日分组
  const timeline: [string, LedgerRecord[]][] = [];
  for (const r of confirmed) {
    const d = day(r.createdAt);
    const last = timeline[timeline.length - 1];
    if (last && last[0] === d) last[1].push(r);
    else timeline.push([d, [r]]);
  }

  const badge = (t: LedgerType) => `${TYPE_ICONS[t]}${LEDGER_TYPE_NAMES[t]}`;

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ flexWrap: "wrap" }}>
          <strong>📒 台账</strong>
          <span className="muted">
            {loaded ? `正典 ${allConfirmedCount} · 待确认 ${proposed.length} · 驳回 ${rejected.length}` : "读取中…"}
            {filter && `（筛选：${LEDGER_TYPE_NAMES[filter]}）`}
          </span>
        </div>
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <button className={filter === "" ? "tab active" : "tab"} onClick={() => setFilter("")}>
            全部
          </button>
          {LEDGER_TYPES.map((tp) => (
            <button key={tp} className={filter === tp ? "tab active" : "tab"} onClick={() => setFilter(tp)}>
              {TYPE_ICONS[tp]}
              {LEDGER_TYPE_NAMES[tp]}
            </button>
          ))}
        </div>
        {error && <p style={{ color: "#b3261e", fontSize: 13 }}>{error}</p>}
        {info && <p className="muted">{info}</p>}
      </div>

      {/* 待确认队列 */}
      <section className="panel">
        <h3>待确认提案（{proposed.length}）</h3>
        {proposed.length === 0 && (
          <p className="muted">
            空。在「ST 试跑」复盘里勾选台账提案并采纳后，会汇入这里等待最终裁决——确认才算正典事实。
          </p>
        )}
        {proposed.map((r) => (
          <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginTop: 6 }}>
            <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
              <span className="muted" style={{ whiteSpace: "nowrap" }}>
                {badge(r.type)}
              </span>
              {editingId === r.id ? (
                <div style={{ flex: 1 }}>
                  <textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} style={{ width: "100%" }} />
                  <div className="row" style={{ marginTop: 4 }}>
                    <button className="primary" onClick={() => void saveEdit(r.id)}>
                      保存
                    </button>
                    <button onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : (
                <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {r.content}
                  {r.actors.length > 0 && <span className="muted">（{r.actors.join("、")}）</span>}
                </span>
              )}
            </div>
            {editingId !== r.id && (
              <div className="row" style={{ marginTop: 6 }}>
                <button className="primary" onClick={() => void decide(r.id, "confirmed")}>
                  ✓ 确认
                </button>
                <button
                  onClick={() => {
                    setEditingId(r.id);
                    setEditText(r.content);
                  }}
                >
                  ✎ 编辑
                </button>
                <button onClick={() => void decide(r.id, "rejected")}>✗ 驳回</button>
                {r.provenance && (
                  <button onClick={() => void showProvenance(r)} className="muted">
                    溯源
                  </button>
                )}
              </div>
            )}
            {provView?.id === r.id && (
              <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg)", padding: 8, borderRadius: 6, fontSize: 12, marginTop: 6 }}>
                {provView.text}
              </pre>
            )}
          </div>
        ))}
      </section>

      {/* 伏笔欠账 */}
      <section className="panel">
        <h3>伏笔欠账（{openDebts.length}）</h3>
        {debts.length === 0 && <p className="muted">大纲里的伏笔表为空：在幕编辑器「伏笔」区埋设后，这里会盯住每一笔未收的账。</p>}
        {debts.length > 0 && openDebts.length === 0 && <p className="muted">全部伏笔都已回收或放弃，没有欠账。</p>}
        {openDebts.map((d) => (
          <div key={`${d.nodeId}:${d.linkId}`} className="row" style={{ gap: 8, padding: "4px 0", flexWrap: "wrap" }}>
            <span style={{ color: "#b3261e" }}>欠</span>
            <span style={{ flex: 1, minWidth: 200 }}>{d.setup}</span>
            <span className="muted">
              埋于「{d.nodeTitle}」{d.payoffTitle ? ` · 拟收「${d.payoffTitle}」` : " · 未定回收点"}
            </span>
          </div>
        ))}
        {debts.some((d) => d.paidByLedger) && (
          <details style={{ marginTop: 6 }}>
            <summary className="muted">已收（{debts.filter((d) => d.paidByLedger).length}）</summary>
            {debts
              .filter((d) => d.paidByLedger)
              .map((d) => (
                <div key={`${d.nodeId}:${d.linkId}`} className="muted" style={{ fontSize: 12, padding: "2px 0" }}>
                  ✓ {d.setup}
                  {d.matched ? ` ← ${clip(d.matched, 60)}` : ""}
                </div>
              ))}
          </details>
        )}
        {openDebts.length > 0 && (
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--bg)", padding: 8, borderRadius: 6, fontSize: 11, marginTop: 8 }}>
            {debtText(debts).slice(0, 400)}
            {debtText(debts).length > 400 ? "…" : ""}
          </pre>
        )}
      </section>

      {/* 已确认时间线 */}
      <section className="panel">
        <h3>正典时间线（{confirmed.length}）</h3>
        {confirmed.length === 0 && <p className="muted">还没有已确认事实。</p>}
        {timeline.map(([d, list]) => (
          <div key={d}>
            <div className="muted" style={{ margin: "8px 0 2px", fontWeight: 600 }}>
              {d}
            </div>
            {list.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8, padding: "3px 0", flexWrap: "wrap" }}>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>
                  {badge(r.type)}
                </span>
                <span style={{ flex: 1, minWidth: 200, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{r.content}</span>
                {r.provenance && (
                  <button className="muted" onClick={() => void showProvenance(r)}>
                    原文
                  </button>
                )}
                <button
                  className="muted"
                  onClick={() => {
                    setEditingId(r.id);
                    setEditText(r.content);
                  }}
                >
                  ✎
                </button>
                {provView?.id === r.id && (
                  <pre style={{ width: "100%", whiteSpace: "pre-wrap", background: "var(--bg)", padding: 8, borderRadius: 6, fontSize: 12 }}>
                    {provView.text}
                  </pre>
                )}
              </div>
            ))}
            {list.map((r) =>
              editingId === r.id ? (
                <div key={`e${r.id}`} style={{ marginTop: 4 }}>
                  <textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} style={{ width: "100%" }} />
                  <div className="row" style={{ marginTop: 4 }}>
                    <button className="primary" onClick={() => void saveEdit(r.id)}>
                      保存
                    </button>
                    <button onClick={() => setEditingId(null)}>取消</button>
                  </div>
                </div>
              ) : null,
            )}
          </div>
        ))}
      </section>

      {/* 驳回区 */}
      {rejected.length > 0 && (
        <section className="panel">
          <details>
            <summary className="muted">已驳回（{rejected.length}）——append-only：只标记，不删除</summary>
            {rejected.map((r) => (
              <div key={r.id} className="row" style={{ gap: 8, padding: "3px 0", flexWrap: "wrap" }}>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>
                  {badge(r.type)}
                </span>
                <span className="muted" style={{ flex: 1, minWidth: 200, textDecoration: "line-through" }}>
                  {r.content}
                </span>
                <button className="muted" onClick={() => void decide(r.id, "confirmed")}>
                  恢复
                </button>
              </div>
            ))}
          </details>
        </section>
      )}
    </div>
  );
}
