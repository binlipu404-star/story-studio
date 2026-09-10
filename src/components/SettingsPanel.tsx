import { useState } from "react";
import type { AppConfig, ModelEndpoint } from "../core/types";
import { loadAppConfig, saveAppConfig } from "../ai/config";
import {
  applyPreset,
  loadPresets,
  matchesConfig,
  overwritePreset,
  removePreset,
  savePresets,
  upsertPreset,
  type AiPreset,
} from "../ai/presets";
import { chat, type ChatRole } from "../ai/client";
import { clearAllProgress } from "../flow/progress";
import { clearPrefs } from "../flow/prefs";
import { errMsg } from "../core/uiUtils";

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

/** 数字输入 → number | undefined（空串/坏值回落 undefined，即“跟随默认”） */
function parseNum(raw: string): number | undefined {
  if (raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** 保存前去首尾空白（粘贴常带换行/空格）；Key 里混进网址单独警示（401 的头号成因） */
function sanitizeCfg(c: AppConfig): AppConfig {
  const clean = (ep: ModelEndpoint): ModelEndpoint => ({
    ...ep,
    baseURL: ep.baseURL.trim(),
    apiKey: ep.apiKey.trim(),
  });
  return { ...c, writer: clean(c.writer), analyzer: clean(c.analyzer) };
}
function looksLikeUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

export function SettingsPanel() {
  const [cfg, setCfg] = useState<AppConfig>(() => loadAppConfig());
  const [msg, setMsg] = useState("");
  const [progressMsg, setProgressMsg] = useState("");
  const [tests, setTests] = useState<Record<ChatRole, TestState>>({
    writer: IDLE_TEST,
    analyzer: IDLE_TEST,
  });
  // 预设（v6.2）：多套 URL/模型/Key 命名快照，选一条 = 整体覆盖生效配置。
  const [presets, setPresets] = useState<AiPreset[]>(() => loadPresets());
  const [presetSel, setPresetSel] = useState("");
  const [presetName, setPresetName] = useState("");

  function patchEndpoint(role: ChatRole, patch: Partial<ModelEndpoint>) {
    setCfg((c) => ({ ...c, [role]: { ...c[role], ...patch } }));
  }

  // ---------- 预设操作（v6.2）：桶写失败一律上抛给 msg，不静默吞 ----------

  /** 存为预设：用当前界面值（先 sanitize），同名=覆盖内容；成功后选中它 */
  function presetSave() {
    try {
      const snap = sanitizeCfg(cfg);
      const next = upsertPreset(presets, presetName, snap);
      savePresets(next);
      setPresets(next);
      const hit = next.find((p) => p.name === presetName.trim());
      if (hit) setPresetSel(hit.id);
      setPresetName("");
      setMsg(`已存为预设「${hit?.name ?? presetName.trim()}」`);
    } catch (e) {
      setMsg(`预设保存失败：${errMsg(e)}`);
    }
  }

  /** 用当前生效配置盖掉选中预设的内容（名字不动） */
  function presetOverwrite() {
    if (!presetSel) return;
    try {
      const next = overwritePreset(presets, presetSel, sanitizeCfg(cfg));
      savePresets(next);
      setPresets(next);
      setMsg("已用当前设置覆盖该预设");
    } catch (e) {
      setMsg(`预设覆盖失败：${errMsg(e)}`);
    }
  }

  /** 应用预设：整体覆盖生效配置（创作+分析两槽一起换），界面立即同步 */
  function presetApply() {
    const hit = presets.find((p) => p.id === presetSel);
    if (!hit) return;
    try {
      setCfg(applyPreset(hit));
      setMsg(`已启用预设「${hit.name}」（两槽位整体切换，立即生效）`);
    } catch (e) {
      setMsg(`预设应用失败：${errMsg(e)}`);
    }
  }

  function presetDelete() {
    const hit = presets.find((p) => p.id === presetSel);
    if (!hit) return;
    if (!window.confirm(`删除预设「${hit.name}」？`)) return;
    try {
      const next = removePreset(presets, presetSel);
      savePresets(next);
      setPresets(next);
      setPresetSel("");
      setMsg("已删除该预设");
    } catch (e) {
      setMsg(`预设删除失败：${errMsg(e)}`);
    }
  }

  function updateTest(role: ChatRole, patch: Partial<TestState>) {
    setTests((t) => ({ ...t, [role]: { ...t[role], ...patch } }));
  }

  function save() {
    try {
      const next = sanitizeCfg(cfg);
      setCfg(next);
      saveAppConfig(next);
      setMsg("已保存");
    } catch (e) {
      setMsg(`保存失败：${errMsg(e)}`);
    }
  }

  async function runTest(role: ChatRole) {
    // chat() 读的是 localStorage 里已保存的配置；先把界面上当前输入落盘，
    // 避免「填了但还没点保存 → 报未配置模型名」。
    try {
      const next = sanitizeCfg(cfg);
      setCfg(next);
      saveAppConfig(next);
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

      {/* ---------- 预设：多套 URL/模型/Key 命名快照，选一条整体切换 ---------- */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>预设 <span className="muted">（多套端点配置一键切换：URL + 模型 + Key，创作/分析两槽一起存、一起换）</span></h3>
        <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            选用预设
            <select value={presetSel} onChange={(e) => setPresetSel(e.target.value)}>
              <option value="">— 不使用 —</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {matchesConfig(p, cfg) ? "（使用中）" : ""}
                  {` · ${p.cfg.writer.model || "未填模型"}`}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={!presetSel} onClick={presetApply}>
            ▶ 启用
          </button>
          <button disabled={!presetSel} onClick={presetOverwrite} title="把下方当前的 URL/模型/Key 写回这条预设（名字不变）">
            ⤓ 用当前设置覆盖
          </button>
          <button disabled={!presetSel} onClick={presetDelete}>
            🗑 删除
          </button>
        </div>
        <div className="row" style={{ marginTop: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 1, minWidth: 220 }}>
            把当前设置存为新预设
            <input
              value={presetName}
              placeholder="如：DeepSeek 官方 / sub2api 代理 / GLM"
              onChange={(e) => setPresetName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && presetName.trim()) presetSave();
              }}
            />
          </label>
          <button onClick={presetSave} disabled={!presetName.trim()}>
            ＋ 存为预设
          </button>
          <span className="muted" style={{ fontSize: 12 }}>同名=覆盖该预设内容。Key 只存本浏览器。</span>
        </div>
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
                {/^sk-/i.test(ep.baseURL.trim()) && (
                  <span style={{ color: "#b3261e", fontSize: 12 }}>
                    这里贴的像是密钥：baseURL 应填网址（如 https://api.deepseek.com，或本地代理 /llm/v1）。
                  </span>
                )}
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
                {looksLikeUrl(ep.apiKey.trim()) && (
                  <span style={{ color: "#b3261e", fontSize: 12 }}>
                    这里贴的是网址：API Key 应只填密钥（sk-…）。网关把收到的内容当密钥校验，
                    回显的 "****.com" 就是这串网址的尾巴——这就是 401 的全部原因。
                  </span>
                )}
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
          进度记忆＝各页面自动记的现场（选中项、草稿、最后打开的剧组等）。平时自动记，这里一键清除。
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
