// ============================================================
// 站内试跑 RP 面板（M5）——不导出 SillyTavern，直接在本机按 ST 默认标准开聊。
// 展示层：只管回合状态机 + chat() 流式 + 世界书命中提示；提示词组装交给 flow/rp.ts。
// 「带回复盘」把当前回合交给父层，复用既有 复盘 → 改纲/纠偏/采纳 全流程。
// ============================================================
import { useCallback, useEffect, useRef, useState } from "react";
import { chat } from "../ai/client";
import { rpMessages, type RpSetup, type RpTurn } from "../flow/rp";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface RpRunnerProps {
  setup: RpSetup;
  charName: string;
  userName: string;
  /** 本幕标题（展示用） */
  sceneLabel: string;
  /** 开场 assistant 消息（= 试跑包 greeting，已含本场指导） */
  greeting: string;
  disabled?: boolean;
  /** 带这些对话去复盘 */
  onBringBack: (turns: RpTurn[]) => void;
}

export function RpRunner({ setup, charName, userName, sceneLabel, greeting, disabled, onBringBack }: RpRunnerProps) {
  const [turns, setTurns] = useState<RpTurn[]>([{ role: "char", name: charName, content: greeting }]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loreHits, setLoreHits] = useState<number | null>(null);
  const [showSys, setShowSys] = useState(false);
  const [sysPeek, setSysPeek] = useState("");

  const ctrlRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef(setup);
  useEffect(() => {
    setupRef.current = setup;
  }, [setup]);

  // 换幕 / 重开：greeting 变则回到开场白
  useEffect(() => {
    setTurns([{ role: "char", name: charName, content: greeting }]);
    setInput("");
    setError(null);
    setLoreHits(null);
  }, [greeting, charName]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, running]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  /** 以给定历史流式生成下一条 assistant 回复 */
  const streamAssistant = useCallback(async (history: RpTurn[]) => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    setError(null);
    setTurns([...history, { role: "char", name: charName, content: "" }]);
    try {
      const { messages, injected } = rpMessages(setupRef.current, history);
      setLoreHits(injected.length);
      setSysPeek(messages[0]?.content ?? "");
      const out = await chat(messages, {
        role: "writer",
        signal: ctrl.signal,
        onDelta: (d) =>
          setTurns((prev) => {
            const cp = prev.slice();
            const last = cp[cp.length - 1];
            cp[cp.length - 1] = { ...last, content: last.content + d };
            return cp;
          }),
      });
      setTurns((prev) => {
        const cp = prev.slice();
        const last = cp[cp.length - 1];
        cp[cp.length - 1] = { ...last, content: out.content || last.content };
        return cp;
      });
    } catch (e) {
      const aborted = (e as { name?: string })?.name === "AbortError";
      // 收尾：空占位则移除，否则保留已生成的半句（人工续写/删除）
      setTurns((prev) => {
        const cp = prev.slice();
        const last = cp[cp.length - 1];
        if (last.role === "char" && !last.content.trim()) cp.pop();
        return cp;
      });
      if (!aborted) setError(errMsg(e));
    } finally {
      setRunning(false);
      ctrlRef.current = null;
    }
  }, [charName]);

  const send = () => {
    const text = input.trim();
    if (!text || running) return;
    setInput("");
    void streamAssistant([...turns, { role: "user", name: userName, content: text }]);
  };

  const regenerate = () => {
    if (running) return;
    // 去掉末尾 assistant，重跑上一轮
    let h = turns.slice();
    if (h.length && h[h.length - 1].role === "char") h.pop();
    if (!h.length) return;
    void streamAssistant(h);
  };

  const stop = () => ctrlRef.current?.abort();

  const delLast = () => {
    if (running) return;
    setTurns((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev));
  };

  const restart = () => {
    ctrlRef.current?.abort();
    setTurns([{ role: "char", name: charName, content: greeting }]);
    setInput("");
    setError(null);
    setLoreHits(null);
  };

  const bringBack = () => {
    // 交给父层复盘：char↔user 逐条映射，丢弃空占位
    onBringBack(turns.filter((t) => t.content.trim()));
  };

  const userTurns = turns.filter((t) => t.role === "user").length;
  const canBringBack = userTurns >= 1 && !running;

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted">
          {sceneLabel}｜你扮演 <b>{userName}</b>，AI 扮演 <b>{charName}</b>（ST 默认标准·本机直连）
        </span>
        <span className="muted">
          {loreHits !== null && `上一回合命中世界书 ${loreHits} 条`}
        </span>
      </div>

      <div
        ref={scrollRef}
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          background: "var(--bg)",
          padding: 12,
          maxHeight: 460,
          overflowY: "auto",
          marginTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {turns.map((t, i) => (
          <TurnBubble key={i} turn={t} userName={userName} charName={charName} streaming={running && i === turns.length - 1 && t.role === "char"} />
        ))}
      </div>

      {error && <p style={{ color: "#b3261e", fontSize: 13 }}>{error}</p>}

      <label className="field" style={{ marginTop: 10 }}>
        <span>{`你的行动 / 台词（{{user}}＝${userName}）— Enter 发送，Shift+Enter 换行`}</span>
        <textarea
          rows={3}
          value={input}
          disabled={disabled || running}
          placeholder="描述 {{user}} 说的话或动作…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          style={{ width: "100%" }}
        />
      </label>

      <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <button className="primary" onClick={send} disabled={disabled || running || !input.trim()}>
          {running ? "生成中…" : "发送"}
        </button>
        <button onClick={stop} disabled={!running}>停止</button>
        <button onClick={regenerate} disabled={disabled || running}>重生成</button>
        <button onClick={delLast} disabled={disabled || running || turns.length <= 1}>删除末条</button>
        <button onClick={restart} disabled={running}>重新开始</button>
        <button onClick={() => setShowSys((v) => !v)} disabled={!sysPeek}>
          {showSys ? "隐藏提示词" : "查看提示词"}
        </button>
        <button className="primary" onClick={bringBack} disabled={disabled || !canBringBack}>
          🧭 带这些对话去复盘
        </button>
      </div>
      {!canBringBack && !running && (
        <p className="muted" style={{ fontSize: 12 }}>至少聊一轮（你一发言）即可「带回复盘」。</p>
      )}

      {showSys && (
        <details open style={{ marginTop: 8 }}>
          <summary className="muted">本轮 system 提示词（ST 默认标准组装结果）</summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--bg)",
              padding: 12,
              borderRadius: 8,
              maxHeight: 320,
              overflowY: "auto",
              fontSize: 12,
            }}
          >
            {sysPeek}
          </pre>
        </details>
      )}
    </div>
  );
}

function TurnBubble({ turn, userName, charName, streaming }: { turn: RpTurn; userName: string; charName: string; streaming: boolean }) {
  const isUser = turn.role === "user";
  return (
    <div style={{ alignSelf: isUser ? "flex-end" : "flex-start", maxWidth: "86%" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2, textAlign: isUser ? "right" : "left" }}>
        {isUser ? userName : charName}
      </div>
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid var(--line)",
          background: isUser ? "var(--accent)" : "var(--panel)",
          color: isUser ? "#fff" : undefined,
          minHeight: 20,
        }}
      >
        {turn.content || (streaming ? "…" : "（空）")}
        {streaming && turn.content ? "▍" : ""}
      </div>
    </div>
  );
}
