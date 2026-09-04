// ============================================================
// SillyTavern 角色卡兼容层：PNG(tEXt chara) / JSON 导入，宽容解析为 ParsedCard，
// 与内部 Character 互转，导出 chara_card_v2（roundtrip 尽量无损）。
// 运行时零依赖：只 import type ../core/types + 同层 ./lorebook；入参用 ArrayBuffer。
// 语义约定：
//   - spec=chara_card_v2 → v2；chara_card_v3 → v3；有 data 但无 spec 的畸形卡按 v2 形态处理；
//     其余扁平对象按 v1（first_mes 缺失时兜底读 legacy 字段 greeting）。
//   - 导出 description 由 profile 重建为 st-novel-tool 的标签行格式（外貌：/性格：/背景：/说话风格：）；
//     profile 全空时保留底卡原 description。
// ============================================================

import type {
  Character,
  CharacterProfile,
  LorebookSettings,
  ParsedCard,
  RawLorebook,
} from "../core/types";
// 显式 .js 后缀：dist-test 产物在 Node ESM 下直接运行（package.json type=module）
import { exportEmbeddedBook, lorebookDefaults, normalizeLorebook, toLoreEntries } from "./lorebook.js";

type UnknownDict = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownDict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function strf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 宽容字段读取：字符串原样；字符串数组用「、」拼接（很多 V2 卡把 personality
 * 甚至 description 写成数组，之前按 strf 会得到空串——识别率下降的主因之一）；
 * 其它类型 → 空串。
 */
function fieldStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    const parts = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
    return parts.join("、");
  }
  return "";
}

function cloneDict(d: UnknownDict): UnknownDict {
  try {
    return JSON.parse(JSON.stringify(d)) as UnknownDict;
  } catch {
    return { ...d };
  }
}

// ---------- PNG 提取 ----------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

/**
 * 手动遍历 PNG chunk 提取 tEXt(keyword="chara") 的 base64 JSON 文本。
 * chunk 结构：u32 大端长度 | 4 字节类型 | 数据 | 4 字节 CRC（不校验）。
 * 多帧/APNG 继续扫描直到 IEND；任何异常/找不到均返回 null。
 */
export function extractPngCardJson(bytes: ArrayBuffer): string | null {
  try {
    const u = new Uint8Array(bytes);
    if (u.length < 8) return null;
    for (let i = 0; i < 8; i++) if (u[i] !== PNG_SIGNATURE[i]) return null;
    const dv = new DataView(bytes);
    let off = 8;
    while (off + 12 <= u.length) {
      const len = dv.getUint32(off);
      const type = latin1(u, off + 4, off + 8);
      const dataStart = off + 8;
      if (dataStart + len + 4 > u.length) break; // 长度越界：停止（坏块容忍）
      if (type === "tEXt" && len > 6) {
        let nul = -1;
        for (let i = dataStart; i < dataStart + len; i++) {
          if (u[i] === 0) {
            nul = i;
            break;
          }
        }
        if (nul >= 0 && latin1(u, dataStart, nul) === "chara") {
          const b64 = latin1(u, nul + 1, dataStart + len).replace(/\s+/g, "");
          if (b64) {
            const bin = atob(b64);
            const data = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
            return new TextDecoder("utf-8").decode(data);
          }
        }
      }
      if (type === "IEND") break;
      off = dataStart + len + 4;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- JSON 解析 ----------

function normalizeTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item);
    } else if (isRecord(item)) {
      const name = strf(item.name ?? item.tag);
      if (name) out.push(name);
    }
  }
  return out;
}

/** 宽容解析角色卡 JSON 文本；缺字段给空串/空数组默认，未知字段通过 raw 原样保留 */
export function parseCardJsonText(text: string): ParsedCard {
  const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
  const top = isRecord(json) ? json : {};
  const spec = strf(top.spec);
  let format: ParsedCard["format"];
  let data: UnknownDict;
  if (spec === "chara_card_v3") {
    format = "v3";
    data = isRecord(top.data) ? top.data : {};
  } else if (spec === "chara_card_v2") {
    format = "v2";
    data = isRecord(top.data) ? top.data : {};
  } else if (isRecord(top.data)) {
    format = "v2"; // {data:...} 缺 spec 的畸形卡：按 v2 形态解析
    data = top.data;
  } else {
    format = "v1"; // 扁平卡（v1 或未知结构）：顶层即字段
    data = top;
  }

  const alternateGreetings = Array.isArray(data.alternate_greetings)
    ? data.alternate_greetings.filter((g): g is string => typeof g === "string")
    : [];
  const creatorNotes = strf(data.creator_notes);
  const systemPrompt = strf(data.system_prompt);
  const postHistory = strf(data.post_history_instructions);
  const creator = strf(data.creator);
  const characterVersion = strf(data.character_version);

  return {
    format,
    name: strf(data.name),
    description: fieldStr(data.description),
    personality: fieldStr(data.personality),
    scenario: fieldStr(data.scenario),
    firstMes: fieldStr(data.first_mes ?? data.greeting), // v1/legacy 兜底：greeting
    mesExample: fieldStr(data.mes_example),
    alternateGreetings,
    creatorNotes: creatorNotes || undefined,
    systemPrompt: systemPrompt || undefined,
    postHistoryInstructions: postHistory || undefined,
    tags: normalizeTags(data.tags),
    creator: creator || undefined,
    characterVersion: characterVersion || undefined,
    extensions: isRecord(data.extensions) ? data.extensions : {},
    embeddedBook: isRecord(data.character_book)
      ? normalizeLorebook(data.character_book, "embedded")
      : null,
    raw: json,
  };
}

/** 导入卡文件字节：按扩展名优先尝试，失败互相兜底；全部失败抛出带文件名的清晰错误 */
export async function importCardBytes(fileName: string, bytes: ArrayBuffer): Promise<ParsedCard> {
  const lower = (fileName ?? "").toLowerCase();
  const tryPng = (): ParsedCard => {
    const text = extractPngCardJson(bytes);
    if (text === null) throw new Error("PNG 中未找到 tEXt keyword=chara 的嵌入卡");
    return parseCardJsonText(text);
  };
  const tryJson = (): ParsedCard => parseCardJsonText(new TextDecoder("utf-8").decode(bytes));
  const attempts: Array<() => ParsedCard> =
    lower.endsWith(".png") ? [tryPng, tryJson] : lower.endsWith(".json") ? [tryJson, tryPng] : [tryJson, tryPng];

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch (e) {
      lastError = e;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`无法从角色卡文件解析出有效的 ST 角色卡 JSON："${fileName}"（${reason}）`);
}

// ---------- Character 互转 ----------

type LabeledProfile = Pick<CharacterProfile, "appearance" | "personality" | "background" | "speechStyle">;

/**
 * 标签行识别：覆盖我们自己的输出格式 + 野生卡常见写法。
 * 英文匹配不分大小写；同类内长标签优先（防「性格」抢走「性格特点」）。
 */
const RAW_PROFILE_LABEL_SYNONYMS: ReadonlyArray<readonly [keyof LabeledProfile, readonly string[]]> = [
  [
    "appearance",
    [
      "appearance details", "appearance detail", "appearance description",
      "physical description", "physical features", "visual description",
      "外貌", "外形", "外观", "外表", "长相", "容貌", "形象", "体格", "身量",
      "穿着", "衣着", "服装", "穿着打扮",
      "appearance", "body", "outfit", "height", "build", "looks", "physique", "visual", "physical",
    ],
  ],
  [
    "personality",
    ["性格特点", "personality traits", "personality", "性格", "个性", "人格", "traits"],
  ],
  [
    "background",
    [
      "background", "backstory", "biography", "history",
      "背景设定", "角色设定", "背景", "经历", "过往", "身世", "简介", "bio",
    ],
  ],
  [
    "speechStyle",
    [
      "way of speaking", "speaking style", "speech style", "manner of speech", "verbal tics",
      "dialogue style",
      "说话风格", "说话方式", "说话习惯", "语言风格", "语言特点", "口癖", "语气", "语态",
      "speech", "voice", "tone",
    ],
  ],
];

/** 同义词按长度降序：长标签优先匹配（「性格特点」先于「性格」被尝试） */
const PROFILE_LABEL_SYNONYMS: ReadonlyArray<readonly [keyof LabeledProfile, readonly string[]]> =
  RAW_PROFILE_LABEL_SYNONYMS.map(
    ([key, syns]) => [key, [...syns].sort((a, b) => b.length - a.length)] as const,
  );

/** 行首剥离 markdown/括号修饰后，尝试把一行匹配为「标签：值」。
 *  标签后必须紧跟分隔符（冒号/括号/破折号等）或行尾——防「形象设计很用心」这类误伤。
 *  bare=true：只有标签没有值（章节头，如 `# Appearance:`），后续无标签行应归入该字段。 */
function matchLabelLine(
  rawLine: string,
): { key: keyof LabeledProfile; value: string; bare: boolean } | null {
  let s = rawLine.trim();
  if (!s) return null;
  s = s.replace(/^[#>＊*\-\u2022\s]+/, ""); // markdown 列表/标题/粗体星号
  s = s.replace(/^[【\[（(「『]+/, "").replace(/[】\]）)」』]+$/, ""); // 包裹括号
  s = s.replace(/[*_`]+/g, ""); // 残余强调符
  if (!s) return null;
  const lower = s.toLowerCase();
  for (const [key, syns] of PROFILE_LABEL_SYNONYMS) {
    for (const syn of syns) {
      if (!lower.startsWith(syn)) continue;
      const rest = s.slice(syn.length);
      if (!rest.trim() || /^[ \t]*[：:，,、\-—–·|｜】\]]+[ \t]*$/.test(rest)) {
        return { key, value: "", bare: true }; // 标签独占一行（可带冒号）= 章节头
      }
      const m = rest.match(/^[ \t]*[：:，,、\-—–·|｜】\]]+[ \t]*(.*)$/);
      if (!m) continue; // 标签后没有分隔符 → 不是标签行
      const value = m[1].trim();
      if (value) return { key, value, bare: false };
    }
  }
  return null;
}

/** 未知章节头（以冒号收尾或 markdown 标题/包裹括号行）：中断裸标签延续 */
function isSectionBreak(rawLine: string): boolean {
  const t = rawLine.trim();
  if (!t) return false;
  return /^[#【\[（(「『>]/.test(t) || /[：:]$/.test(t);
}

interface LabeledExtract extends LabeledProfile {
  /** 至少命中过一次标签 */
  hit: boolean;
  /** 没匹配任何标签的行（原样保留，避免信息丢失） */
  rest: string[];
}

/**
 * description 逐行扫描：
 *  - 「标签：值」行 → 对应字段；
 *  - 「标签：」空值行（章节头）→ 之后的连续无标签行归入该字段（Sans 的 `# Appearance:` 多行式）；
 *  - 其余行 → rest（背景），裸标签延续被未知章节头中断。
 */
function extractLabeledProfile(description: string): LabeledExtract {
  const found: LabeledExtract = {
    appearance: "",
    personality: "",
    background: "",
    speechStyle: "",
    hit: false,
    rest: [],
  };
  const append = (key: keyof LabeledProfile, value: string) => {
    found[key] = found[key] ? `${found[key]}\n${value}` : value;
  };
  let section: keyof LabeledProfile | null = null;
  for (const rawLine of (description ?? "").split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    const hit = matchLabelLine(rawLine);
    if (hit) {
      found.hit = true;
      section = hit.bare ? hit.key : null; // 仅裸标签开启多行章节；行内标签不吞后续正文
      if (!hit.bare) append(hit.key, hit.value);
    } else if (!trimmed) {
      continue; // 空行不打断章节
    } else if (isSectionBreak(rawLine)) {
      section = null;
      found.rest.push(trimmed);
    } else if (section) {
      append(section, trimmed); // 裸标签章节的多行正文
    } else {
      found.rest.push(trimmed);
    }
  }
  return found;
}

/**
 * WLAB 内联格式：`Personality:(...) Appearance:(short blonde hair + brown eyes) ...`——
 * 标签在一行中间、值用一层括号包裹。逐标签扫全文，取首个括号段（容忍一层内部括号）。
 */
export function extractParenLabeledFields(
  description: string,
): Partial<Record<keyof LabeledProfile, string>> {
  const out: Partial<Record<keyof LabeledProfile, string>> = {};
  const text = description ?? "";
  for (const [key, syns] of PROFILE_LABEL_SYNONYMS) {
    if (out[key]) continue;
    for (const syn of syns) {
      const re = new RegExp(
        `(?:^|[\\s/\\\\|])${syn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]\\s*\\(\\s*((?:[^()]|\\([^()]*\\))*)\\s*\\)`,
        "i",
      );
      const m = text.match(re);
      const value = m?.[1]?.trim();
      if (value) {
        out[key] = value.replace(/\s*\+\s*/g, "，");
        break;
      }
    }
  }
  return out;
}

/** 外貌线索词（强=几乎只在外貌语境出现；弱=需两条共现才可信）。英文按词边界匹配。 */
const APPEAR_KEYWORDS_STRONG = [
  "hair", "eyes", "skin", "build", "tall", "muscular", "bald", "beard", "physique",
  "figure", "pale", "scar", "freckles", "fur", "scales", "wings", "horns", "muzzle",
  "claws", "slender", "chubby", "blonde", "redhead", "ponytail",
  "头发", "发型", "发色", "眼睛", "瞳", "身高", "体型", "身材", "皮肤", "肌肉",
  "面容", "长相", "脸庞", "疤痕", "纹身", "獠牙", "鳞片", "羽毛", "胡须", "胡子", "光头",
];
const APPEAR_KEYWORDS_WEAK = [
  "wears", "wearing", "outfit", "clothes", "clothing", "face", "facial", "features",
  "looks", "stature", "broad", "lean", "frame",
  "穿着", "服装", "衣着", "外貌", "外表", "样子", "模样", "打扮", "五官",
];
let _appearRe: RegExp | null = null;
function countAppearKeywords(clause: string): { strong: number; weak: number } {
  if (!_appearRe) {
    _appearRe = new RegExp(`(?:${APPEAR_KEYWORDS_STRONG.map((k) => (/[a-z]/i.test(k) ? `\\b${k}\\b` : k)).join("|")})`, "gi");
  }
  const lower = clause.toLowerCase();
  let strong = 0;
  const strongTexts = clause.match(_appearRe);
  if (strongTexts) strong = new Set(strongTexts.map((s) => s.toLowerCase())).size;
  let weak = 0;
  for (const k of APPEAR_KEYWORDS_WEAK) {
    if (/[a-z]/i.test(k)) {
      if (new RegExp(`\\b${k}\\b`, "i").test(clause)) weak++;
    } else if (lower.includes(k)) weak++;
  }
  return { strong, weak };
}

/**
 * 外貌兜底提取（仅在标签与非标字段都落空时启用）：把 description 按行/分号/句号切小句，
 * 强线索词命中≥1 且句短，或弱词≥2 共现 → 收进外貌。宁缺毋滥，提不出就留空。
 */
export function appearanceFallback(description: string, charName = ""): string {
  // 切小句：换行 / 分号 / 中文句号 / 英文句号后接空白（"2.5" 这类小数点后无空格不会误切）
  const clauses = (description ?? "")
    .split(/\r?\n|[;；。]|\.(?=\s)|!|！|\?(?=\s)/)
    .map((c) => c.trim())
    .filter((c) => c.length > 2 && c.length <= 240);
  const picked: string[] = [];
  for (const c of clauses) {
    const { strong, weak } = countAppearKeywords(c);
    if (strong >= 1 || (weak >= 2 && c.length <= 160)) picked.push(c);
    if (picked.length >= 10 || picked.join("\n").length > 700) break;
  }
  if (!picked.length) return "";
  const name = charName || "{{char}}";
  return picked.map((c) => c.replace(/\{\{char\}\}/gi, name)).join("\n");
}

/** 野生卡常把外貌放进非标准顶层/extensions 字段（appearance 等），直接捞取 */
function customAppearanceFromRaw(parsed: ParsedCard): string {
  const top = isRecord(parsed.raw) ? parsed.raw : {};
  const data = isRecord(top.data) ? top.data : top;
  const keys = ["appearance", "appearance_description", "visual_description", "physical_description"];
  for (const k of keys) {
    const v = fieldStr(data[k]);
    if (v.trim()) return v.trim();
  }
  const ext = isRecord(data.extensions) ? data.extensions : isRecord(parsed.extensions) ? parsed.extensions : {};
  for (const k of keys) {
    const v = fieldStr(ext[k]);
    if (v.trim()) return v.trim();
  }
  return "";
}

/** 对话示例按行拆：去 <START> 行内标记与说话人前缀（{{char}}/{{user}}/角色名 + 冒号） */
function splitExampleLines(mesExample: string, charName: string): string[] {
  if (!mesExample) return [];
  const esc = charName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alt = esc ? "\\{\\{char\\}\\}|\\{\\{user\\}\\}|".concat(esc) : "\\{\\{char\\}\\}|\\{\\{user\\}\\}";
  const prefixRe = new RegExp(`^\\s*(?:${alt})\\s*[:：]\\s*`, "i");
  const out: string[] = [];
  for (const rawLine of mesExample.split(/\r?\n/)) {
    const line = rawLine.replace(/<START>/gi, "").trim();
    if (!line) continue;
    const stripped = line.replace(prefixRe, "").trim();
    if (stripped) out.push(stripped);
  }
  return out;
}

function makeId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * ParsedCard → Character。字段识别策略（尽量填满、绝不臆造）：
 *  - 外貌：标签行（含裸标签章节多行式）> 非标顶层/extensions 的 appearance 字段 > 线索词小句兜底；都没有则留空。
 *  - 性格：V2 独立 personality 字段为主，description 里的性格标签补充（去重）。
 *  - 背景：命中过标签时取标签背景 + 未命中的正文行；完全没命中则整段 description 兜底。
 *  - 说话风格：仅来自标签行。
 */
export function parsedCardToCharacter(parsed: ParsedCard, projectId: string): Character {
  const now = Date.now();
  const exampleLines = splitExampleLines(parsed.mesExample, parsed.name);
  const labeled = extractLabeledProfile(parsed.description);
  const paren = extractParenLabeledFields(parsed.description); // WLAB 内联 `标签:(值)` 格式

  const appearance =
    labeled.appearance.trim() ||
    paren.appearance ||
    customAppearanceFromRaw(parsed) ||
    appearanceFallback(parsed.description, parsed.name);

  let personality = parsed.personality.trim();
  for (const extra of [labeled.personality.trim(), paren.personality]) {
    if (extra && !personality.includes(extra)) {
      personality = personality ? `${personality}\n${extra}` : extra;
    }
  }

  const background = labeled.hit
    ? [labeled.background.trim(), labeled.rest.join("\n").trim()].filter(Boolean).join("\n")
    : parsed.description.trim();

  const profile: CharacterProfile = {
    appearance,
    personality,
    background,
    speechStyle: labeled.speechStyle.trim() || paren.speechStyle || "",
    exampleLines,
  };
  return {
    id: makeId(),
    projectId,
    name: parsed.name,
    profile,
    scenario: parsed.scenario,
    greeting: parsed.firstMes,
    mesExample: parsed.mesExample,
    source: "st-import",
    cardFormat: parsed.format,
    rawCard: parsed.raw,
    createdAt: now,
    updatedAt: now,
  };
}

/** profile → description 标签行（与 st-novel-tool buildSTCard 的生成格式一致） */
function rebuildDescription(profile: CharacterProfile): string {
  const parts = [
    profile.appearance ? `外貌：${profile.appearance}` : "",
    profile.personality ? `性格：${profile.personality}` : "",
    profile.background ? `背景：${profile.background}` : "",
    profile.speechStyle ? `说话风格：${profile.speechStyle}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/**
 * 生成 chara_card_v2。若 rawCard 是 v2 形态（含缺 spec 的 {data:...} 畸形卡）则深拷贝其 data
 * 再覆盖当前值，extensions/alternate_greetings 等未识别字段原样保留；否则生成全新骨架。
 * book 传入时以 exportEmbeddedBook 规范化后挂入 data.character_book。
 */
export function exportCardV2(character: Character, book?: RawLorebook): Record<string, unknown> {
  const raw = character.rawCard;
  let data: UnknownDict;
  if (isRecord(raw) && (raw.spec === undefined || raw.spec === "chara_card_v2") && isRecord(raw.data)) {
    data = cloneDict(raw.data);
  } else {
    data = {
      name: "",
      description: "",
      personality: "",
      scenario: "",
      first_mes: "",
      mes_example: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: [],
      creator: "story-studio",
      character_version: "",
      extensions: {},
    };
  }

  const profile: CharacterProfile = character.profile ?? {
    appearance: "",
    personality: "",
    background: "",
    speechStyle: "",
    exampleLines: [],
  };
  const desc = rebuildDescription(profile);
  data.name = character.name ?? "";
  if (desc) data.description = desc; // profile 全空时保留底卡原 description
  data.personality = profile.personality ?? "";
  data.scenario = character.scenario ?? "";
  data.first_mes = character.greeting ?? "";
  const exampleLines = Array.isArray(profile.exampleLines) ? profile.exampleLines : [];
  const mesExample = character.mesExample;
  data.mes_example =
    mesExample !== undefined && mesExample !== ""
      ? mesExample
      : exampleLines.length > 0
        ? exampleLines.map((l) => `${data.name}: ${l}`).join("\n")
        : strf(data.mes_example);

  if (book && Array.isArray(book.entries)) {
    const d = lorebookDefaults();
    const settings: LorebookSettings = {
      scanDepth: book.scanDepth ?? d.scanDepth,
      tokenBudget: book.tokenBudget ?? d.tokenBudget,
      recursiveScanning: book.recursiveScanning ?? d.recursiveScanning,
    };
    const cb = exportEmbeddedBook(toLoreEntries(book, character.projectId ?? "", 0), settings);
    if (book.name) cb.name = book.name;
    data.character_book = cb;
  }

  return { spec: "chara_card_v2", spec_version: "2.0", data };
}
