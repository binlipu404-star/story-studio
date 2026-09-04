// ============================================================
// 房间台账面板（v3.1-④）：台账从作品工作区迁入 RP 剧场，且每个房间独立。
//
// 三层结构：
//   1. 房间台账——roomId 绑定的本房间正典（场记直写 confirmed；编辑/删除都只动本房间）；
//   2. 作品级台账——ST 试跑复盘的提案在这里裁决（确认才进作品正典），已确认可一键
//      「引入本房间」（复制成房间行，源不动——房间正典始终优先）；
//   3. 伏笔欠账——用房间剧本副本视角算（snapshotDebt），主纲改了也看不到。
// 原作品页的「台账」页签由此取代删除。
// ============================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LedgerRecord, LedgerType, ScriptSnapshot } from "../core/types";
import * as repos from "../store/repos";
import { LEDGER_TYPE_NAMES, LEDGER_TYPES } from "../flow/snapshot";
import { snapshotDebt } from "../flow/script";

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

export function RoomLedgerPanel({
  projectId,
  roomId,
  snapshot,
  onChanged,
}: {
  projectId: string;
  roomId: string;
  snapshot: ScriptSnapshot | null; // 房间剧本副本（算伏笔欠账用；沙盒=null）
  onChanged: () => void; // 通知父层刷新注入用正典
}) {
  const [roomRows, setRoomRows] = useState<LedgerRecord[]>([]);
  const [projRows, setProjRows] = useState<LedgerRecord[]>([]);
  const [filter, setFilter] = useState<LedgerType | "">("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rr = roomId ? await repos.listLedger(projectId, undefined, roomId) : [];
      const pr = await repos.listLedger(projectId);
      setRoomRows(rr);
      setProjRows(pr.filter((r) => !r.roomId));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [projectId, roomId]);

  useEffect(() => {
    setInfo(null);
    setEditingId(null);
    void refresh();
  }, [refresh]);

  const pick = (list: LedgerRecord[]) => (filter ? list.filter((r) => r.type === filter) : list);
  const roomConfirmed = pick(roomRows.filter((r) => r.status === "confirmed"));
  const roomRejected = pick(roomRows.filter((r) => r.status === "rejected"));
  const projProposed = pick(projRows.filter((r) => r.status === "proposed"));
  const projConfirmed = pick(projRows.filter((r) => r.status === "confirmed"));

  const debts = useMemo(() => {
    if (!snapshot || snapshot.scenes.length === 0) return { open: [] as { sceneTitle: string; setup: string }[], paid: [] as { sceneTitle: string; setup: string }[] };
    const paidSetups = roomRows.filter((r) => r.type === "foreshadow" && r.status === "confirmed").map((r) => r.content);
    const all = snapshotDebt(snapshot, paidSetups);
    return { open: all.slice(0, 20), paid: [] as { sceneTitle: string; setup: string }[] };
  }, [snapshot, roomRows]);

  const mutate = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      await refresh();
      onChanged();
      setInfo(msg);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const saveEdit = async (id: string) => {
    const content = editText.trim();
    if (!content) return;
    await mutate(() => repos.editLedger(id, { content }), "已修正。");
  };

  /** 删除＝用户明确允许才发生（⑥：默认永不静默删对话/正典） */
  const removeRow = async (r: LedgerRecord) => {
    if (!window.confirm(`删除这条台账？\n「${r.content.slice(0, 60)}」\n删除后不可恢复（可先「驳回」软处理）。`)) return;
    await mutate(() => repos.deleteLedger(r.id), "已删除。");
  };

  const importToRoom = async (r: LedgerRecord) => {
    await mutate(async () => {
      const now = Date.now();
      await repos.addRoomCanon([
        { id: repos.uid(), projectId, roomId, type: r.type, content: r.content, actors: r.actors, status: "confirmed", createdAt: now },
      ]);
    }, `已引入本房间：${r.content.slice(0, 30)}…（作品级原件不动）`);
  };

  const badge = (t: LedgerType) => `${TYPE_ICONS[t] ?? "·"}${LEDGER_TYPE_NAMES[t] ?? t}`;

  const timeline: [string, LedgerRecord[]][] = [];
  for (const r of roomConfirmed) {
    const d = day(r.createdAt);
    const last = timeline[timeline.length - 1];
    if (last && last[0] === d) last[1].push(r);
    else timeline.push([d, [r]]);
  }

  const editor = (id: string) =>
    editingId === id ? (
      <div style={{ flex: 1 }}>
        <textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} style={{ width: "100%" }} />
        <div className="row" style={{ marginTop: 4 }}>
          <button className="primary" onClick={() => void saveEdit(id)}>保存</button>
          <button onClick={() => setEditingId(null)}>取消</button>
        </div>
      </div>
    ) : null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div className="panel">
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          <b>📒 台账</b>
          <span className="muted">房间 {roomConfirmed.length} · 作品正典 {projConfirmed.length} · 待裁决 {projProposed.length}</span>
        </div>
        <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
          <button className={filter === "" ? "tab active" : "tab"} onClick={() => setFilter("")}>全部</button>
          {LEDGER_TYPES.map((tp) => (
            <button key={tp} className={filter === tp ? "tab active" : "tab"} onClick={() => setFilter(tp)}>
              {TYPE_ICONS[tp]}
              {LEDGER_TYPE_NAMES[tp]}
            </button>
          ))}
        </div>
        {error && <p style={{ color: "#b3261e", fontSize: 12 }}>{error}</p>}
        {info && <p className="muted" style={{ fontSize: 12 }}>{info} <button style={{ fontSize: 10 }} onClick={() => setInfo(null)}>知道了</button></p>}
      </div>

      {/* 1. 房间台账（本房间独立正典；roomId="" 的无房间模式不显示） */}
      {roomId !== "" && (
      <section className="panel">
        <h3 style={{ margin: 0 }}>房间正典（只属于本房间）</h3>
        {roomConfirmed.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>空白。场记整理的已演事实写在这里——新房间不继承任何旧事实。</p>
        )}
        {timeline.map(([d, list]) => (
          <div key={d}>
            <div className="muted" style={{ margin: "6px 0 2px", fontWeight: 600, fontSize: 12 }}>{d}</div>
            {list.map((r) => (
              <div key={r.id} style={{ display: "flex", gap: 6, padding: "3px 0", alignItems: "flex-start" }}>
                <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{badge(r.type)}</span>
                {editor(r.id) ?? (
                  <span style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 12 }}>
                    {r.content}
                    {r.actors.length > 0 && <span className="muted">（{r.actors.join("、")}）</span>}
                  </span>
                )}
                {editingId !== r.id && (
                  <span style={{ whiteSpace: "nowrap" }}>
                    <button className="muted" style={{ fontSize: 11, padding: "0 4px" }} onClick={() => { setEditingId(r.id); setEditText(r.content); }}>✎</button>
                    <button className="muted" style={{ fontSize: 11, padding: "0 4px", color: "#b3261e" }} onClick={() => void removeRow(r)} title="彻底删除（需确认）">🗑</button>
                  </span>
                )}
              </div>
            ))}
          </div>
        ))}
        {roomRejected.length > 0 && (
          <details style={{ marginTop: 4 }}>
            <summary className="muted" style={{ fontSize: 12 }}>本房间已驳回（{roomRejected.length}）</summary>
            {roomRejected.map((r) => (
              <div key={r.id} className="row" style={{ gap: 6, padding: "2px 0" }}>
                <span className="muted" style={{ flex: 1, fontSize: 12, textDecoration: "line-through" }}>{r.content}</span>
                <button className="muted" style={{ fontSize: 11 }} onClick={() => void mutate(() => repos.decide(r.id, "confirmed"), "已恢复。")}>恢复</button>
              </div>
            ))}
          </details>
        )}
      </section>
      )}

      {/* 2. 作品级台账（提案裁决 + 引入桥） */}
      <section className="panel">
        <h3 style={{ margin: 0 }}>作品级台账（跨房间共享）</h3>
        <p className="muted" style={{ fontSize: 11, margin: "4px 0" }}>
          ST 试跑复盘的提案在这里裁决（确认才进作品正典）；房间正典永远优先，作品级只在配置条打开「借作品级台账」时标注注入。
        </p>
        {projProposed.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <b style={{ fontSize: 12 }}>待确认提案（{projProposed.length}）</b>
            {projProposed.map((r) => (
              <div key={r.id} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 6, marginTop: 4 }}>
                <div className="row" style={{ alignItems: "flex-start", gap: 6 }}>
                  <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{badge(r.type)}</span>
                  {editor(r.id) ?? <span style={{ flex: 1, fontSize: 12, whiteSpace: "pre-wrap" }}>{r.content}{r.actors.length > 0 && <span className="muted">（{r.actors.join("、")}）</span>}</span>}
                </div>
                {editingId !== r.id && (
                  <div className="row" style={{ marginTop: 4 }}>
                    <button className="primary" style={{ fontSize: 11 }} onClick={() => void mutate(() => repos.decide(r.id, "confirmed"), "已确认进作品正典。")}>✓ 确认</button>
                    <button style={{ fontSize: 11 }} onClick={() => { setEditingId(r.id); setEditText(r.content); }}>✎ 编辑</button>
                    <button style={{ fontSize: 11 }} onClick={() => void mutate(() => repos.decide(r.id, "rejected"), "已驳回。")}>✗ 驳回</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <details style={{ marginTop: 4 }}>
          <summary className="muted" style={{ fontSize: 12 }}>作品正典（{projConfirmed.length}）——可引入本房间</summary>
          {projConfirmed.length === 0 && <p className="muted" style={{ fontSize: 12 }}>作品级还没有已确认事实。</p>}
          {projConfirmed.slice(-40).reverse().map((r) => (
            <div key={r.id} className="row" style={{ gap: 6, padding: "2px 0" }}>
              <span className="muted" style={{ whiteSpace: "nowrap", fontSize: 12 }}>{badge(r.type)}</span>
              <span style={{ flex: 1, fontSize: 12 }}>{r.content}</span>
              {roomId !== "" && <button className="muted" style={{ fontSize: 11 }} onClick={() => void importToRoom(r)} title="复制进本房间正典（作品级原件不动）">引入</button>}
            </div>
          ))}
        </details>
      </section>

      {/* 3. 伏笔欠账（房间副本视角） */}
      {!snapshot || snapshot.scenes.length === 0 ? null : (
        <section className="panel">
          <h3 style={{ margin: 0 }}>伏笔欠账（副本视角 · {debts.open.length}）</h3>
          {debts.open.length === 0 && <p className="muted" style={{ fontSize: 12 }}>副本里的伏笔在房间正典中都找到了回收记录。</p>}
          {debts.open.map((d, i) => (
            <div key={`${d.sceneTitle}:${i}`} className="row" style={{ gap: 6, padding: "2px 0", fontSize: 12 }}>
              <span style={{ color: "#b3261e" }}>欠</span>
              <span style={{ flex: 1 }}>{d.setup}</span>
              <span className="muted">埋于「{d.sceneTitle}」</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
