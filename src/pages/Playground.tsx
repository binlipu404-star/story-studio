import { useEffect, useRef, useState } from "react";
import type { ChatMessage } from "../core/types";
import { chat, type ChatRole } from "../ai/client";
import { extractJson } from "../ai/json";
import { estimateTokens } from "../ai/tokenizer";
import { errMsg, isAbort } from "../core/uiUtils";

export function Playground() {
  const [system, setSystem] = useState("你是一个有帮助的写作助手。");
  const [user, setUser] = useState("");
  const [role, setRole] = useState<ChatRole>("writer");
  const [jsonMode, setJsonMode] = useState(false);
  const [running, setRunning] = useState(false);

  const [output, setOutput] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [prettyJson, setPrettyJson] = useState("");
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const preRef = useRef<HTMLPreElement>(null);

  // 切页即卸载：在飞请求随之中止（不留后台悄悄烧 token 的流）
  useEffect(() => () => controllerRef.current?.abort(), []);

  // 发送前的提示词估算（system + user 正文，不含回复与协议开销）
  const promptTokens = estimateTokens(system) + estimateTokens(user);

  // 流式输出自动滚底
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  function stop() {
    controllerRef.current?.abort();
  }

  async function send() {
    if (running) return;
    if (!user.trim() && !system.trim()) {
      setError("请输入 user 内容");
      return;
    }

    const messages: ChatMessage[] = [];
    if (system.trim()) messages.push({ role: "system", content: system });
    messages.push({ role: "user", content: user });

    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    setRunning(true);
    setOutput("");
    setReasoning("");
    setPrettyJson("");
    setError("");
    setElapsed(0);

    const t0 = Date.now();
    try {
      // JSON 模式同样走流式：原始输出进输出区，收完后本地解析出 pretty JSON。
      const out = await chat(messages, {
        role,
        json: jsonMode,
        signal: ctrl.signal,
        onDelta: (d) => setOutput((prev) => prev + d),
      });
      if (out.reasoning) setReasoning(out.reasoning);
      if (jsonMode) {
        try {
          setPrettyJson(JSON.stringify(extractJson(out.content), null, 2));
        } catch (e) {
          setError(`JSON 解析失败：${errMsg(e)}`);
        }
      }
      setOutput(out.content);
      setElapsed(Date.now() - t0);
    } catch (e) {
      if (isAbort(e)) setError("已停止");
      else setError(errMsg(e));
      setElapsed(Date.now() - t0);
    } finally {
      setRunning(false);
      controllerRef.current = null;
    }
  }

  return (
    <div>
      <div className="panel">
        <div className="row" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          <label className="field" style={{ gap: 2 }}>
            模型角色
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as ChatRole)}
            >
              <option value="writer">创作模型（writer）</option>
              <option value="analyzer">分析模型（analyzer）</option>
            </select>
          </label>
          <label
            className="field"
            style={{
              gap: 4,
              flexDirection: "row",
              alignItems: "center",
              alignSelf: "end",
            }}
          >
            <input
              type="checkbox"
              checked={jsonMode}
              onChange={(e) => setJsonMode(e.target.checked)}
            />
            JSON 模式
          </label>
          <span className="muted" style={{ alignSelf: "end" }}>
            估算提示词 ≈ {promptTokens} tokens
          </span>
        </div>

        <label className="field">
          system
          <textarea
            rows={4}
            value={system}
            onChange={(e) => setSystem(e.target.value)}
          />
        </label>
        <label className="field" style={{ marginTop: 8 }}>
          user
          <textarea
            rows={6}
            value={user}
            placeholder="输入测试消息…"
            onChange={(e) => setUser(e.target.value)}
          />
        </label>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" disabled={running} onClick={() => void send()}>
            {running ? "生成中…" : "发送"}
          </button>
          <button disabled={!running} onClick={stop}>
            停止
          </button>
          {elapsed > 0 && (
            <span className="muted">耗时 {(elapsed / 1000).toFixed(2)}s</span>
          )}
        </div>
        {error && (
          <div style={{ color: "#b3261e", marginTop: 8, fontSize: 13 }}>{error}</div>
        )}
      </div>

      {reasoning && (
        <div className="panel">
          <details>
            <summary className="muted">
              推理过程（reasoning_content，{reasoning.length} 字）
            </summary>
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                background: "var(--bg)",
                padding: 12,
                borderRadius: 8,
                maxHeight: 300,
                overflowY: "auto",
              }}
            >
              {reasoning}
            </pre>
          </details>
        </div>
      )}

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>
          输出 {running && <span className="muted">（流式中…）</span>}
        </h3>
        <pre
          ref={preRef}
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "var(--bg)",
            padding: 12,
            borderRadius: 8,
            minHeight: 160,
            maxHeight: 480,
            overflowY: "auto",
            margin: 0,
          }}
        >
          {output || "（尚无输出）"}
        </pre>
      </div>

      {jsonMode && prettyJson && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>解析后的 JSON</h3>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--bg)",
              padding: 12,
              borderRadius: 8,
              maxHeight: 400,
              overflowY: "auto",
              margin: 0,
            }}
          >
            {prettyJson}
          </pre>
        </div>
      )}
    </div>
  );
}
