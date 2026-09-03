// ============================================================
// 用户画像（Persona）兼容层：把外部来源宽容解析为画像种子。
// 支持三种来源：
//   A. ST「设置 ▸ 用户画像」导出文件：
//      { personas: {头像文件名: 名字}, persona_descriptions: {头像: {description,...}}, default_persona }
//   B. ST 角色卡（PNG tEXt / v1|v2|v3 JSON）：name→名字，正文按 profile 分字段带上；
//   C. 裸对象/数组：{name?, description?, appearance?, personality?, notes?}（多用于备份/手写）。
// 纯逻辑：仅运行时依赖同层 card.js；可进 Node 冒烟测试。
// ============================================================

import type { Character, Persona } from "../core/types";
import { importCardBytes, parseCardJsonText, parsedCardToCharacter } from "./card.js";

export interface ParsedPersonaSeed {
  name: string;
  description: string;
  appearance: string;
  personality: string;
  notes: string;
  isDefault: boolean;
  raw?: unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strf(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** 角色卡形态 → 画像种子：背景做正文；性格/外貌单列；scenario+说话风格进备注 */
export function characterToPersonaSeed(ch: Character, isDefault = false): ParsedPersonaSeed {
  const p = ch.profile;
  return {
    name: ch.name ?? "",
    description: p.background ?? "",
    appearance: p.appearance ?? "",
    personality: p.personality ?? "",
    notes: [ch.scenario, p.speechStyle].filter(Boolean).join("\n"),
    isDefault,
    raw: ch.rawCard,
  };
}

/** ST 画像导出文件形态 → 种子数组（default_persona 命中的那条 isDefault=true） */
function personaFileToSeeds(obj: Record<string, unknown>): ParsedPersonaSeed[] {
  const personas = obj.personas;
  if (!isRecord(personas)) return [];
  const descs = isRecord(obj.persona_descriptions) ? obj.persona_descriptions : {};
  const def = typeof obj.default_persona === "string" ? obj.default_persona : null;
  const seeds: ParsedPersonaSeed[] = [];
  for (const [avatarFile, nameVal] of Object.entries(personas)) {
    const entry = descs[avatarFile];
    const description = isRecord(entry) ? strf(entry.description) : typeof entry === "string" ? entry.trim() : "";
    const name =
      strf(nameVal) ||
      (typeof nameVal === "string" ? nameVal.trim() : "") ||
      avatarFile.replace(/\.[a-z0-9]+$/i, "");
    if (!name && !description) continue;
    seeds.push({
      name,
      description,
      appearance: "",
      personality: "",
      notes: "",
      isDefault: def !== null && def === avatarFile,
      raw: obj,
    });
  }
  return seeds;
}

/** 裸对象形态（画像备份/手写）→ 种子；完全空白返回 null */
function plainToSeed(obj: Record<string, unknown>): ParsedPersonaSeed | null {
  const name = strf(obj.name) || strf(obj.persona_name);
  const description = strf(obj.description) || strf(obj.persona_description);
  const appearance = strf(obj.appearance);
  const personality = strf(obj.personality);
  const notes = strf(obj.notes);
  if (!name && !description && !appearance && !personality) return null;
  return { name, description, appearance, personality, notes, isDefault: obj.isDefault === true, raw: obj };
}

/**
 * 画像 JSON 文本 → 种子数组。判定顺序：ST 画像导出文件 → 数组（逐条按 卡/裸对象 解析）→ 单对象（卡优先，卡判据不中回落裸对象）。
 * 一无所获时抛清晰错误。
 */
export function parsePersonaJsonText(text: string): ParsedPersonaSeed[] {
  const json: unknown = JSON.parse((text ?? "").replace(/^\uFEFF/, ""));
  if (isRecord(json) && isRecord(json.personas)) {
    const seeds = personaFileToSeeds(json);
    if (seeds.length) return seeds;
    throw new Error("画像文件中 personas 映射为空");
  }
  if (Array.isArray(json)) {
    const seeds: ParsedPersonaSeed[] = [];
    for (const item of json) {
      if (!isRecord(item)) continue;
      const seed = plainToSeed(item) ?? cardJsonToSeed(JSON.stringify(item));
      if (seed) seeds.push(seed);
    }
    if (seeds.length) return seeds;
    throw new Error("数组中没有可解析的画像条目");
  }
  if (isRecord(json)) {
    // 卡形态特征：spec / data / first_mes / greeting —— 否则按裸对象（画像备份常见）
    const cardLike = json.spec !== undefined || json.data !== undefined || json.first_mes !== undefined || json.greeting !== undefined;
    if (cardLike) {
      const seed = cardJsonToSeed(text);
      if (seed) return [seed];
    }
    const seed = plainToSeed(json);
    if (seed) return [seed];
  }
  throw new Error("无法从该 JSON 识别出任何用户画像");
}

function cardJsonToSeed(text: string): ParsedPersonaSeed | null {
  try {
    const parsed = parseCardJsonText(text);
    const ch = parsedCardToCharacter(parsed, "");
    if (!parsed.name && !parsed.description) return null;
    return characterToPersonaSeed(ch);
  } catch {
    return null;
  }
}

/** 导入画像文件字节：先按 JSON 画像来源试，失败再按角色卡文件（PNG 等）试 */
export async function importPersonaBytes(fileName: string, bytes: ArrayBuffer): Promise<ParsedPersonaSeed[]> {
  const text = new TextDecoder("utf-8").decode(bytes);
  try {
    return parsePersonaJsonText(text);
  } catch {
    // 不是画像 JSON：按角色卡兜底（PNG 内嵌 / 卡 JSON）
  }
  const parsed = await importCardBytes(fileName, bytes);
  return [characterToPersonaSeed(parsedCardToCharacter(parsed, ""))];
}

/** 种子 → 可落库 Persona（id/时间戳在此生成；isDefault 由调用方裁决后用 repos.setDefaultPersona） */
export function personaSeedToPersona(seed: ParsedPersonaSeed, opts: { asDefault?: boolean } = {}): Persona {
  const now = Date.now();
  return {
    id: `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    name: seed.name,
    description: seed.description,
    appearance: seed.appearance,
    personality: seed.personality,
    notes: seed.notes,
    isDefault: opts.asDefault ?? seed.isDefault,
    source: "st-import",
    rawCard: seed.raw,
    createdAt: now,
    updatedAt: now,
  };
}
