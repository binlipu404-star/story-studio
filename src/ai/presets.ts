// ============================================================
// AI 端点「预设」（v6.2）：多套 URL/模型/Key 组合的命名快照，一键切换。
//
// 纯函数与 localStorage 薄壳分层：*Preset 纯函数无 IO、进逻辑测试白名单；
// loadPresets/savePresets 只在浏览器调用（Node 测试环境无 localStorage）。
// 预设存完整 AppConfig 快照（创作+分析两槽位），应用=整体覆盖当前配置。
// ============================================================
import type { AppConfig, ModelEndpoint } from "../core/types";
import { loadAppConfig, saveAppConfig, toEndpoint } from "./config.js";

const STORAGE_KEY = "story-studio.presets";

export interface AiPreset {
  id: string;
  name: string;
  cfg: AppConfig;
}

function uidLocal(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 非安全上下文回落 */
  }
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 宽容解析预设桶（坏 JSON/坏条目逐条丢弃，永不抛错）；上限 50 条防爆桶 */
export function parsePresets(raw: string | null): AiPreset[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: AiPreset[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.id !== "string" || !rec.id || typeof rec.name !== "string" || !rec.name.trim()) continue;
    const src = rec.cfg && typeof rec.cfg === "object" ? (rec.cfg as Record<string, unknown>) : {};
    out.push({
      id: rec.id,
      name: rec.name.trim().slice(0, 60),
      cfg: { writer: toEndpoint(src.writer), analyzer: toEndpoint(src.analyzer) },
    });
    if (out.length >= 50) break;
  }
  return out;
}

/** 同名替换、新名追加（name 先 trim；空名拒绝返回原列表） */
export function upsertPreset(list: AiPreset[], name: string, cfg: AppConfig, id?: string): AiPreset[] {
  const n = name.trim();
  if (!n) return list;
  if (id) {
    return list.map((p) => (p.id === id ? { ...p, name: n, cfg } : p));
  }
  const same = list.findIndex((p) => p.name === n);
  const item: AiPreset = { id: uidLocal(), name: n, cfg };
  if (same >= 0) {
    const out = [...list];
    out[same] = { ...out[same], cfg }; // 同名=覆盖内容，保留 id/位置
    return out;
  }
  return [...list, item];
}

export function removePreset(list: AiPreset[], id: string): AiPreset[] {
  return list.filter((p) => p.id !== id);
}

/** 用当前生效配置盖掉某预设的内容（名字不动）；id 不存在原样返回 */
export function overwritePreset(list: AiPreset[], id: string, cfg: AppConfig): AiPreset[] {
  return list.map((p) => (p.id === id ? { ...p, cfg } : p));
}

/** 当前配置是否与某预设内容一致（下拉框标「（使用中）」） */
export function matchesConfig(preset: AiPreset, cfg: AppConfig): boolean {
  const epEq = (a: ModelEndpoint, b: ModelEndpoint) =>
    a.baseURL === b.baseURL && a.model === b.model && a.apiKey === b.apiKey &&
    (a.temperature ?? null) === (b.temperature ?? null) && (a.maxTokens ?? null) === (b.maxTokens ?? null);
  return epEq(preset.cfg.writer, cfg.writer) && epEq(preset.cfg.analyzer, cfg.analyzer);
}

// ---------- localStorage 薄壳（仅浏览器调用；写失败上抛由 UI 提示） ----------

export function loadPresets(): AiPreset[] {
  try {
    return parsePresets(localStorage.getItem(STORAGE_KEY));
  } catch {
    return []; // 隐私模式等场景 localStorage 不可用
  }
}

export function savePresets(list: AiPreset[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** 应用预设 = 整体覆盖生效配置（走 config 的门面，调用方随后刷新自身状态） */
export function applyPreset(preset: AiPreset): AppConfig {
  const cfg: AppConfig = {
    writer: { ...preset.cfg.writer },
    analyzer: { ...preset.cfg.analyzer },
  };
  saveAppConfig(cfg);
  return cfg;
}

/** 当前生效配置的深副本（存预设/对比用；防调用方改坏共享引用） */
export function snapshotConfig(): AppConfig {
  const cfg = loadAppConfig();
  return { writer: { ...cfg.writer }, analyzer: { ...cfg.analyzer } };
}
