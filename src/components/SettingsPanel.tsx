import { useEffect, useRef, useState } from "react";
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
import { errMsg, downloadText } from "../core/uiUtils";
import { getProxyPort, isTauri, toProxyUrl } from "../tauriBridge";
import { db } from "../store/db";
import {
  TABLE_NAMES,
  dumpAll,
  dumpToJson,
  parseDumpJson,
  restoreDump,
  type TableMap,
} from "../flow/transfer";

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
  // 全库转储/恢复（v7-A3 迁移桥）：浏览器↔桌面壳之间搬书稿的唯一官方通道
  const [transferMsg, setTransferMsg] = useState("");
  const [transferBusy, setTransferBusy] = useState(false);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  // 桌面壳（v7-A2）：isTauri 才显桌面面板；代理端口经 proxy_port 命令取（0=未就绪）
  const [inShell, setInShell] = useState(false);
  const [proxyPort, setProxyPort] = useState(0);
  useEffect(() => {
    if (!isTauri()) return;
    setInShell(true);
    void getProxyPort().then(setProxyPort);
  }, []);

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

  /** 壳内一键：把两槽位的 baseURL 转成本地代理前缀形态（CORS 根治） */
  async function fillProxyUrls() {
    const port = await getProxyPort();
    if (!port) {
      setMsg("本地代理未就绪（proxy_port=0），请先重启应用");
      return;
    }
    setCfg((c) => ({
      ...c,
      writer: { ...c.writer, baseURL: toProxyUrl(c.writer.baseURL, port) },
      analyzer: { ...c.analyzer, baseURL: toProxyUrl(c.analyzer.baseURL, port) },
    }));
    setMsg(`已填入本地代理前缀（:${port}）——点「保存设置」生效`);
  }

  // ---------- 自动更新（v7-B1，仅壳内）：动态 invoke，走壳内 updater_update 命令（支持 update-mirror.txt 镜像覆盖） ----------
  const [updMsg, setUpdMsg] = useState("");
  const [updBusy, setUpdBusy] = useState(false);

  // ---------- 网页程序松绑（v7.2-D1，仅壳内）：用户区 dist 可自由导入/编辑 ----------
  interface WebappStatus {
    user_dir: string;
    factory_dir: string;
    user_active: boolean;
    factory_present: boolean;
    user_entries: string[];
  }
  const [webapp, setWebapp] = useState<WebappStatus | null>(null);
  const [webappMsg, setWebappMsg] = useState("");
  async function reloadWebapp() {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      setWebapp(await invoke<WebappStatus>("webapp_status"));
    } catch {
      /* 老版壳没有这个命令：整块不显示即可 */
    }
  }
  useEffect(() => {
    if (inShell) void reloadWebapp();
  }, [inShell]);

  async function webappInvoke(cmd: "webapp_open_folder" | "webapp_reset") {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      if (cmd === "webapp_reset") {
        if (!window.confirm("恢复出厂 = 删除用户区的全部自定义网页文件，界面立即回到随包版本。\n（不动任何书稿数据）确定？")) return;
        await invoke(cmd);
        await reloadWebapp();
        setWebappMsg("已恢复出厂：用户区已清空。如当前页面仍是旧版，重启应用即可。");
      } else {
        const dir = await invoke<string>(cmd);
        await reloadWebapp();
        setWebappMsg(`已在资源管理器打开：${dir}`);
      }
    } catch (e) {
      setWebappMsg(`操作失败：${errMsg(e)}`);
    }
  }

  async function checkUpdate() {
    setUpdBusy(true);
    setUpdMsg("检查中…");
    try {
      const { invoke, Channel } = await import("@tauri-apps/api/core");
      const ch = new Channel<number>();
      ch.onmessage = (got) => setUpdMsg(`下载新版本：已收 ${(got / 1024 / 1024).toFixed(1)} MB…`);
      const info = await invoke<{ version: string; body: string | null } | null>("updater_update", {
        onProgress: ch,
      });
      if (!info) {
        setUpdMsg("已是最新版本");
        return;
      }
      setUpdMsg(`新版本 ${info.version} 安装完成，正在重启…`);
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (e) {
      // 静默失败哲学：GitHub 抽风/镜像未同步都不该堵死用户，如实报一句即可
      setUpdMsg(`更新失败（不影响使用，可稍后再试）：${errMsg(e)}`);
    } finally {
      setUpdBusy(false);
    }
  }

  // ---------- 全库转储 / 恢复（v7-A3）：db 表句柄即 TableLike（结构满足） ----------

  const tableMap = db as unknown as TableMap;

  async function exportDump() {
    setTransferBusy(true);
    setTransferMsg("");
    try {
      const dump = await dumpAll(tableMap, db.verno);
      const text = dumpToJson(dump);
      const stamp = new Date().toISOString().slice(0, 10);
      downloadText(`story-studio-全库转储-${stamp}.json`, text);
      const v = countsSummary(dump.tables);
      setTransferMsg(`已导出全库转储（${v}，${(text.length / 1024).toFixed(0)} KB）——文件在浏览器下载目录。`);
    } catch (e) {
      setTransferMsg(`导出失败：${errMsg(e)}`);
    } finally {
      setTransferBusy(false);
    }
  }

  /** 展示串：非空表的「表名×行数」清单（全空就是空库）；行数与计数两种来源都吃 */
  function countsSummary(src: Record<string, unknown[] | number>): string {
    const parts = TABLE_NAMES.map((n) => {
      const v = src[n];
      const c = Array.isArray(v) ? v.length : typeof v === "number" ? v : 0;
      return c > 0 ? `${n}×${c}` : "";
    }).filter(Boolean);
    return parts.length ? parts.join(" ") : "空库";
  }

  async function importDump(file: File) {
    setTransferBusy(true);
    setTransferMsg("");
    try {
      const parsed = parseDumpJson(await file.text());
      // 先展示对账再确认：让用户看清"要灌进来什么"再落库
      const rowsMsg = (() => {
        const t = (parsed as { tables?: Record<string, unknown[]> })?.tables;
        return t ? countsSummary(t) : "?";
      })();
      const replace = window.confirm(
        `导入转储：${rowsMsg}\n\n「确定」= 整库替换（本机现有数据先清空，完全回到转储时刻）；\n「取消」= 合并导入（同 id 覆盖、其余保留）。`,
      );
      const r = await restoreDump(tableMap, parsed, { mode: replace ? "replace" : "merge", currentSchemaVersion: db.verno });
      setTransferMsg(
        `导入完成（${replace ? "整库替换" : "合并"}）：${countsSummary(r.counts)}，共 ${r.total} 行。${r.schemaWarning ? `⚠ ${r.schemaWarning}` : ""}${
          r.unknownTables.length ? `（忽略了本版本不认识的表：${r.unknownTables.join("、")}）` : ""
        } 刷新各页即见。`,
      );
    } catch (e) {
      setTransferMsg(`导入失败：${errMsg(e)}`);
    } finally {
      setTransferBusy(false);
      if (importFileRef.current) importFileRef.current.value = "";
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

      {/* ---------- 桌面壳（仅桌面版显示）：本地代理一键接入 ---------- */}
      {inShell && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>🖥 桌面版</h3>
          <div className="row" style={{ alignItems: "center", flexWrap: "wrap" }}>
            <span className="muted">
              本地代理：
              {proxyPort > 0 ? (
                <code>http://127.0.0.1:{proxyPort}/proxy/&lt;scheme&gt;/&lt;host&gt;/…</code>
              ) : (
                "未就绪"
              )}
              （绕开浏览器跨域限制，任意 OpenAI 兼容网关直通）
            </span>
            <button className="primary" disabled={proxyPort === 0} onClick={() => void fillProxyUrls()}>
              一键把下方 baseURL 改为走本地代理
            </button>
            <button disabled={updBusy} onClick={() => void checkUpdate()}>
              {updBusy ? "更新中…" : "🔄 检查更新"}
            </button>
          </div>
          {updMsg && <p className="muted" style={{ margin: "6px 0 0", fontSize: 13 }}>{updMsg}</p>}
          {webapp && (
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px dashed var(--border, #444)" }}>
              <div className="muted" style={{ fontSize: 13 }}>
                网页程序（可自定义界面）：
                {webapp.user_active ? (
                  <b>用户区生效中</b>
                ) : webapp.factory_present ? (
                  "随包版运行中"
                ) : (
                  "内嵌版运行中（升级到有松包的新版后此处可管理）"
                )}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4, wordBreak: "break-all" }}>
                把 Story Studio 的 dist 构建产物整个放进下面的文件夹即可接管界面（重启应用生效）；删掉=恢复出厂。书稿数据与它无关。
                <br />📂 {webapp.user_dir}
                {webapp.user_active && webapp.user_entries.length > 0 && (
                  <>
                    <br />
                    用户区现有：{webapp.user_entries.slice(0, 8).join("、")}
                    {webapp.user_entries.length > 8 ? "…" : ""}
                  </>
                )}
              </div>
              <div className="row" style={{ marginTop: 6, flexWrap: "wrap" }}>
                <button onClick={() => void webappInvoke("webapp_open_folder")}>📂 打开网页程序文件夹</button>
                {webapp.user_active && (
                  <button onClick={() => void webappInvoke("webapp_reset")} title="删除用户区全部自定义文件，回到随包版本">
                    ♻ 恢复出厂
                  </button>
                )}
                <button onClick={() => void reloadWebapp()} title="放入文件后点这里看有没有被认到">
                  🔄 刷新状态
                </button>
              </div>
              {webappMsg && <p className="muted" style={{ margin: "6px 0 0", fontSize: 12 }}>{webappMsg}</p>}
            </div>
          )}
        </div>
      )}

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

        {/* ---------- 全库转储 / 恢复（v7-A3 迁移桥） ---------- */}
        <h3 style={{ marginBottom: 4 }}>全库转储（备份 / 迁移）</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          一本不落导出全部数据（作品/大纲/人物卡/世界书/画像/台账/剧场会话）。
          换浏览器、或迁移到桌面版时：在这里导出 → 到对面「导入」。导入按 id 幂等：合并=同条覆盖，整库替换=先清空。
        </p>
        <div className="row" style={{ marginTop: 4, alignItems: "center", flexWrap: "wrap" }}>
          <button disabled={transferBusy} onClick={() => void exportDump()}>
            {transferBusy ? "处理中…" : "📦 导出全部数据(.json)"}
          </button>
          <button disabled={transferBusy} onClick={() => importFileRef.current?.click()}>
            📥 导入转储文件
          </button>
          <input
            ref={importFileRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importDump(f);
            }}
          />
        </div>
        {transferMsg && (
          <p style={{ fontSize: 13, color: transferMsg.includes("失败") ? "#b3261e" : "var(--accent)" }}>{transferMsg}</p>
        )}

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
