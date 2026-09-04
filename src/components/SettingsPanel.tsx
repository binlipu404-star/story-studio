import { useState } from "react";
import type { AppConfig, ModelEndpoint } from "../core/types";
import { loadAppConfig, saveAppConfig } from "../ai/config";
import { chat, type ChatRole } from "../ai/client";
import { clearAllProgress } from "../flow/progress";
import { clearPrefs } from "../flow/prefs";

interface TestState {
  running: boolean;
  ms: number;
  text: string;
  error: string;
}

const IDLE_TEST: TestState = { running: false, ms: 0, text: "", error: "" };

const ROLES: { role: ChatRole; label: string; hint: string }[] = [
  { role: "writer", label: "创作模型", hint: "RP 续写 / 大纲草稿" },
  { role: "analyzer", label: "分析模型", hint: "抽取 / 判断 / 整理" },
];

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 数字输入 → number | undefined（空串/坏值回落 undefined，即“跟随默认”） */
function parseNum(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function SettingsPanel() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadAppConfig());
  const [msg, setMsg] = useState("");
  const [progressMsg, setProgressMsg] = useState("");
  const [tests, setTests] = useState<Record<ChatRole, TestState>>({
    writer: IDLE_TEST,
    analyzer: IDLE_TEST,
  });

  function patchEndpoint(role: ChatRole, patch: Partial<ModelEndpoint>) {
    setCfg((c) => ({ ...c, [role]: { ...c[role], ...patch } }));
  }

  function updateTest(role: ChatRole, patch: Partial<TestState>) {
    setTests((t) => ({ ...t, [role]: { ...t[role], ...patch } }));
  }

  function save() {
    try {
      saveAppConfig(cfg);
      setMsg("已保存");
    } catch (e) {
      setMsg(`保存失败：${errMsg(e)}`);
    }
  }

  async function runTest(role: ChatRole) {
    // chat() 读的是 localStorage 里已保存的配置；先把界面上当前输入落盘，
    // 避免「填了但还没点保存 → 报未配置模型名」。
    try {
      saveAppConfig(cfg);
      setMsg("已保存");
    } catch (e) {
      updateTest(role, { running: false, error: `保存失败：${errMsg(e)}` });
      return;
    }
    updateTest(role, { running: true, ms: 0, text: "", error: "" });
    const t0 = Date.now();
    let acc = "";
    try {
      const out = await chat([{ role: "user", content: "只回复 OK" }], {
        role,
        maxTokens: 16,
        onDelta: (d) => {
          acc += d;
          updateTest(role, { text: acc, ms: Date.now() - t0 });
        },
      });
      updateTest(role, {
        running: false,
        ms: Date.now() - t0,
        text: out.content || acc,
      });
    } catch (e) {
      updateTest(role, { running: false, error: errMsg(e) });
    }
  }

  return (
    <div>
      <div className="panel row" style={{ position: "sticky", top: 0, zIndex: 2 }}>
        <button className="primary" onClick={save}>
          保存设置
        </button>
        <span className="muted">
          填好模型名与 Key 后点「保存设置」；点各面板的「测试」也会先自动保存再测试。
        </span>
        {msg && <span style={{ color: "var(--accent)" }}>{msg}</span>}
      </div>
      <div className="grid2" style={{ alignItems: "start" }}>
        {ROLES.map(({ role, label, hint }) => {
          const ep = cfg[role];
          const test = tests[role];
          return (
            <div className="panel" key={role}>
              <h3 style={{ marginTop: 0 }}>
                {label} <span className="muted">（{hint}）</span>
              </h3>
              <label className="field">
                baseURL
                <input
                  value={ep.baseURL}
                  placeholder="https://api.deepseek.com"
                  onChange={(e) => patchEndpoint(role, { baseURL: e.target.value })}
                />
              </label>
              <label className="field">
                模型
                <input
                  value={ep.model}
                  placeholder="如 deepseek-chat"
                  onChange={(e) => patchEndpoint(role, { model: e.target.value })}
                />
              </label>
              <label className="field">
                API Key
                <input
                  type="password"
                  value={ep.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => patchEndpoint(role, { apiKey: e.target.value })}
                />
              </label>
              <div className="grid2">
                <label className="field">
                  temperature
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={ep.temperature ?? ""}
                    placeholder="0.7"
                    onChange={(e) =>
                      patchEndpoint(role, { temperature: parseNum(e.target.value) })
                    }
                  />
                </label>
                <label className="field">
                  maxTokens
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={ep.maxTokens ?? ""}
                    placeholder="不限"
                    onChange={(e) =>
                      patchEndpoint(role, { maxTokens: parseNum(e.target.value) })
                    }
                  />
                </label>
              </div>

              <div className="row" style={{ marginTop: 10 }}>
                <button
                  className="primary"
                  disabled={test.running}
                  onClick={() => void runTest(role)}
                >
                  {test.running ? "测试中…" : "测试"}
                </button>
                {!test.running && test.ms > 0 && (
                  <span className="muted">耗时 {(test.ms / 1000).toFixed(2)}s</span>
                )}
                {!test.running && test.text && (
                  <span style={{ color: "var(--accent)" }}>{test.text}</span>
                )}
              </div>
              {test.error && (
                <div style={{ color: "#b3261e", marginTop: 8, fontSize: 13 }}>
                  {test.error}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>全局</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          用户名（{"{{user}}"}）不再全局设置：<b>用哪张画像（人设），用户名就是谁</b>；未选画像时回落「读者」。
        </p>
        <div className="row" style={{ marginTop: 8, alignItems: "center" }}>
          <button
            onClick={() => {
              const n = clearAllProgress();
              clearPrefs();
              setProgressMsg(`已清除 ${n} 条进度记忆（各页选中/草稿/楼层现场）与剧场偏好；下次进入各页从头开始。`);
            }}
          >
            清除进度记忆
          </button>
          {progressMsg && <span className="muted">{progressMsg}</span>}
        </div>
        <p className="muted" style={{ marginTop: 6, fontSize: 12 }}>
          进度记忆＝各页面自动记的现场（选中项、草稿、最后打开的房间等）。平时自动记，这里一键清除。
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={save}>
            保存
          </button>
          {msg && <span style={{ color: "var(--accent)" }}>{msg}</span>}
        </div>
        <p className="muted" style={{ marginTop: 10 }}>
          API Key 仅保存在本浏览器的 localStorage 中，由浏览器直连模型端点，不经过任何服务器。
        </p>
      </div>
    </div>
  );
}
