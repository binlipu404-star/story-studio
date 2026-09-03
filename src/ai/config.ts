import type { AppConfig, ModelEndpoint } from "../core/types";

/** localStorage 持久化键 */
const STORAGE_KEY = "story-studio.config";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_USER_NAME = "旅行者";

/** 每次调用返回全新的默认配置对象，避免调用方改坏共享引用 */
function freshDefaults(): AppConfig {
  return {
    writer: { baseURL: DEFAULT_BASE_URL, model: "", apiKey: "" },
    analyzer: { baseURL: DEFAULT_BASE_URL, model: "", apiKey: "" },
    userName: DEFAULT_USER_NAME,
  };
}

/** 默认配置（只读参考；需要可变副本请用 loadAppConfig() 或自行展开） */
export const DEFAULT_APP_CONFIG: AppConfig = freshDefaults();

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** 宽容地把任意 unknown 规整成 ModelEndpoint（坏字段逐次回落到默认值） */
function toEndpoint(v: unknown): ModelEndpoint {
  const src = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const ep: ModelEndpoint = {
    baseURL: str(src.baseURL, DEFAULT_BASE_URL) || DEFAULT_BASE_URL,
    model: str(src.model, ""),
    apiKey: str(src.apiKey, ""),
  };
  const temperature = optNum(src.temperature);
  if (temperature !== undefined) ep.temperature = temperature;
  const maxTokens = optNum(src.maxTokens);
  if (maxTokens !== undefined) ep.maxTokens = maxTokens;
  return ep;
}

/** 读取应用配置：localStorage 缺失 / 坏 JSON / 字段残缺时逐层回落到默认值 */
export function loadAppConfig(): AppConfig {
  const defaults = freshDefaults();
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return defaults; // 隐私模式等场景 localStorage 不可用
  }
  if (!raw) return defaults;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults; // 坏 JSON 回默认
  }
  const src = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
    string,
    unknown
  >;
  const cfg: AppConfig = {
    writer: toEndpoint(src.writer),
    analyzer: toEndpoint(src.analyzer),
    userName: str(src.userName, DEFAULT_USER_NAME) || DEFAULT_USER_NAME,
  };
  return cfg;
}

/** 保存应用配置（写失败时抛错，由 UI 决定如何提示） */
export function saveAppConfig(cfg: AppConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}
