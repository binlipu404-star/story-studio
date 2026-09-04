// ============================================================
// SillyTavern 世界书兼容层
// 规范化两种外部形态（ST 全局 world info / 卡内 character_book v2-v3）到 RawLorebook，
// 以及与 st-novel-tool worldBookToSTJson 对齐的全局导出、chara_card_v2 内嵌书导出。
// 运行时零依赖：只 import type ../core/types。
// 语义约定：
//   - position：全局数字 0=before_char 1=after_char；字符串形态同义；无法识别一律 before_char。
//   - enabled：disable 字段存在时以其反义为准（ST 全局），否则读 enabled（卡内），都缺省 true。
//   - keys：字符串按 "," 拆分并 trim、过滤空串；数组逐元素同样处理。
// ============================================================

import type { LorebookSettings, LoreEntry, RawLorebook, RawLoreEntry } from "../core/types";

type UnknownDict = Record<string, unknown>;

// ---------- 宽容取值助手（任何输入都不抛异常） ----------

function isRecord(v: unknown): v is UnknownDict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

function num(v: unknown, fallback: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function optNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function bool(v: unknown, fallback = false): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1") return true;
    if (s === "false" || s === "0") return false;
  }
  return fallback;
}

function optBool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** 触发词键：字符串按逗号拆分；数组逐元素拆分；trim + 过滤空串 */
function keysOf(v: unknown): string[] {
  const raw: string[] = [];
  if (typeof v === "string") raw.push(v);
  else if (Array.isArray(v)) {
    for (const item of v) {
      if (typeof item === "string") raw.push(item);
      else if (typeof item === "number" && Number.isFinite(item)) raw.push(String(item));
    }
  }
  const out: string[] = [];
  for (const s of raw) {
    for (const part of s.split(",")) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

function firstNonEmpty(a: string, b: string): string {
  return a.trim() ? a : b;
}

/** 归一化 position：数字 0/1 或字符串均映射为 before/after */
function normalizePosition(v: unknown): "before_char" | "after_char" {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "after_char" || s === "after" || s === "1") return "after_char";
    return "before_char";
  }
  if (typeof v === "number") return v === 1 ? "after_char" : "before_char";
  return "before_char";
}

// ---------- 规范化 ----------

export function lorebookDefaults(): LorebookSettings {
  return { scanDepth: 4, tokenBudget: 2048, recursiveScanning: true };
}

/**
 * 单条目规范化。同时容忍两种形态的字段名：
 * 全局：key/keysecondary/comment/disable/order/caseSensitive...
 * 卡内：keys/secondary_keys/name|comment/enabled/insertion_order/case_sensitive...
 * legacy：content 可为 text；comment 可为 name。
 * 明显坏条目（非对象，或既无 content 也无触发词）返回 null 由调用方跳过。
 */
function normalizeRawEntry(e: unknown, fallbackUid: number | null): RawLoreEntry | null {
  if (!isRecord(e)) return null;
  const keys = keysOf(e.key ?? e.keys);
  const hasContent = e.content !== undefined || e.text !== undefined;
  if (!hasContent && keys.length === 0) return null;

  const out: RawLoreEntry = {
    keys,
    secondaryKeys: keysOf(e.keysecondary ?? e.secondary_keys),
    content: str(e.content ?? e.text),
    constant: bool(e.constant, false),
    selective: bool(e.selective, false),
    caseSensitive: optBool(e.caseSensitive ?? e.case_sensitive),
    matchWholeWords: optBool(e.matchWholeWords ?? e.match_whole_words),
    position: normalizePosition(e.position),
    insertionOrder: num(e.order ?? e.insertion_order, 0),
    enabled:
      e.disable !== undefined && e.disable !== null
        ? !bool(e.disable)
        : e.enabled !== undefined && e.enabled !== null
          ? bool(e.enabled, true)
          : true,
    depth: optNum(e.depth),
    sticky: optNum(e.sticky),
    cooldown: optNum(e.cooldown),
    probability: e.probability === undefined || e.probability === null ? null : num(e.probability, 100),
    useProbability: optBool(e.useProbability ?? e.use_probability),
    group: e.group === undefined || e.group === null ? null : str(e.group),
    groupOverride: optBool(e.groupOverride ?? e.group_override),
    groupWeight: optNum(e.groupWeight ?? e.group_weight),
    excludeRecursion: bool(e.excludeRecursion ?? e.exclusion, false),
    preventRecursion: bool(e.preventRecursion, false),
    extensions: isRecord(e.extensions) ? e.extensions : {},
  };
  const uid = optNum(e.uid) ?? optNum(e.id);
  if (uid !== null) out.uid = uid;
  else if (fallbackUid !== null) out.uid = fallbackUid;
  const comment = firstNonEmpty(str(e.comment), str(e.name));
  if (comment) out.comment = comment;
  return out;
}

function parseEntryArray(list: unknown[]): RawLoreEntry[] {
  const out: RawLoreEntry[] = [];
  for (const item of list) {
    const e = normalizeRawEntry(item, null);
    if (e) out.push(e);
  }
  return out;
}

function parseEntryMap(map: UnknownDict): RawLoreEntry[] {
  const keys = Object.keys(map);
  keys.sort((a, b) => {
    const na = a.trim() === "" ? NaN : Number(a);
    const nb = b.trim() === "" ? NaN : Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const out: RawLoreEntry[] = [];
  for (const k of keys) {
    const uid = k.trim() !== "" && Number.isFinite(Number(k)) ? Number(k) : null;
    const e = normalizeRawEntry(map[k], uid);
    if (e) out.push(e);
  }
  return out;
}

/** 读取卡内书顶层设置字段（全局文件通常没有，读到才带上） */
function attachSettings(book: RawLorebook, raw: UnknownDict): RawLorebook {
  if (typeof raw.name === "string" && raw.name) book.name = raw.name;
  const sd = optNum(raw.scan_depth ?? raw.scanDepth);
  if (sd !== null) book.scanDepth = sd;
  const tb = optNum(raw.token_budget ?? raw.tokenBudget);
  if (tb !== null) book.tokenBudget = tb;
  const rs =
    typeof raw.recursive_scanning === "boolean"
      ? raw.recursive_scanning
      : typeof raw.recursiveScanning === "boolean"
        ? raw.recursiveScanning
        : undefined;
  if (rs !== undefined) book.recursiveScanning = rs;
  return book;
}

/**
 * 极宽容规范化任意世界书输入；绝不抛异常，坏条目跳过、好条目保留。
 * source 为咨询性参数：实际按 entries 形态解析（对象 map=全局 world info，数组=卡内 v2/v3）；
 * 顶层直接是数组时按卡内书处理。
 */
export function normalizeLorebook(
  raw: unknown,
  source: "auto" | "global" | "embedded" = "auto",
): RawLorebook {
  if (Array.isArray(raw)) return { entries: parseEntryArray(raw) };
  if (!isRecord(raw)) return { entries: [] };
  const entriesRaw = raw.entries;
  let entries: RawLoreEntry[];
  if (Array.isArray(entriesRaw)) entries = parseEntryArray(entriesRaw); // 数组 → 卡内 v2/v3 形态
  else if (isRecord(entriesRaw)) entries = parseEntryMap(entriesRaw); // 字符串键 map → 全局 world info
  else entries = []; // entries 缺失/畸形：无论 source 声明为何，返回空书
  void source; // 形态按 entries 实际结构判定，source 仅作调用方意图记录
  return attachSettings({ entries }, raw);
}

// ---------- 内部形态 ----------

/** RawLorebook → LoreEntry[]（全字段默认值）；缺 uid 的按 startUid+序号补 */
export function toLoreEntries(book: RawLorebook, projectId: string, startUid = 0): LoreEntry[] {
  const list = book && Array.isArray(book.entries) ? book.entries : [];
  return list.map((e0, i) => {
    const e = e0 ?? ({} as RawLoreEntry);
    const uid = typeof e.uid === "number" ? e.uid : startUid + i;
    return {
      id: `${projectId}:lore:${uid}`,
      projectId,
      uid,
      comment: typeof e.comment === "string" ? e.comment : "",
      content: typeof e.content === "string" ? e.content : "",
      keys: Array.isArray(e.keys) ? [...e.keys] : [],
      secondaryKeys: Array.isArray(e.secondaryKeys) ? [...e.secondaryKeys] : [],
      constant: e.constant ?? false,
      selective: e.selective ?? false,
      caseSensitive: e.caseSensitive ?? false,
      matchWholeWord: e.matchWholeWords ?? false,
      position: normalizePosition(e.position),
      order: typeof e.insertionOrder === "number" ? e.insertionOrder : 0,
      depth: e.depth ?? null,
      sticky: e.sticky ?? null,
      cooldown: e.cooldown ?? null,
      probability: e.probability ?? 100,
      useProbability: e.useProbability ?? true,
      group: e.group ?? "",
      groupOverride: e.groupOverride ?? false,
      groupWeight: e.groupWeight ?? 100,
      excludeRecursion: e.excludeRecursion ?? false,
      preventRecursion: e.preventRecursion ?? false,
      enabled: e.enabled ?? true,
      extensions: isRecord(e.extensions) ? { ...e.extensions } : {},
    };
  });
}

// ---------- 导出 ----------

/**
 * ST 全局 world info 文件形态：{ entries: { "uid": {...} } }。
 * 字段与 st-novel-tool worldBookToSTJson 对齐且完整；position 用 ST 原生数字 0/1；
 * disable = !enabled；caseSensitive/matchWholeWords 为 false 时写 null（ST 的“继承全局”语义）。
 */
export function exportLorebookGlobal(entries: LoreEntry[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  const sorted = [...entries].sort((a, b) => a.uid - b.uid);
  for (const e of sorted) {
    map[String(e.uid)] = {
      uid: e.uid,
      key: Array.isArray(e.keys) ? [...e.keys] : [],
      keysecondary: Array.isArray(e.secondaryKeys) ? [...e.secondaryKeys] : [],
      comment: e.comment ?? "",
      content: e.content ?? "",
      constant: e.constant ?? false,
      selective: e.selective ?? false,
      order: e.order ?? 0,
      position: e.position === "after_char" ? 1 : 0,
      disable: !(e.enabled ?? true),
      excludeRecursion: e.excludeRecursion ?? false,
      preventRecursion: e.preventRecursion ?? false,
      probability: e.probability ?? 100,
      useProbability: e.useProbability ?? true,
      depth: e.depth ?? 4,
      group: e.group ?? "",
      groupOverride: e.groupOverride ?? false,
      groupWeight: e.groupWeight ?? 100,
      // 有组的条目必须显式启用组打分，否则 ST 不会做组内择一（默认继承=全局关）
      useGroupScoring: e.group ? true : false,
      scanDepth: null,
      caseSensitive: e.caseSensitive ? true : null,
      matchWholeWords: e.matchWholeWord ? true : null,
      automationId: "",
      role: 0,
      sticky: e.sticky ?? 0,
      cooldown: e.cooldown ?? 0,
      delay: 0,
      displayIndex: e.uid,
      extensions: isRecord(e.extensions) ? { ...e.extensions } : {},
    };
  }
  return { entries: map };
}

/**
 * chara_card_v2 的 data.character_book 形态（lorebook v2）。
 * position 写 ST 原生数字 0/1；min_depth/max_depth 不导出（导入时也忽略）。
 */
export function exportEmbeddedBook(
  entries: LoreEntry[],
  settings: LorebookSettings,
): Record<string, unknown> {
  return {
    name: "",
    description: "",
    scan_depth: settings.scanDepth,
    token_budget: settings.tokenBudget,
    recursive_scanning: settings.recursiveScanning,
    extensions: {},
    entries: entries.map((e, i) => ({
      keys: Array.isArray(e.keys) ? [...e.keys] : [],
      secondary_keys: Array.isArray(e.secondaryKeys) ? [...e.secondaryKeys] : [],
      content: e.content ?? "",
      comment: e.comment ?? "",
      constant: e.constant ?? false,
      selective: e.selective ?? false,
      insertion_order: e.order ?? 0,
      position: e.position === "after_char" ? 1 : 0,
      enabled: e.enabled ?? true,
      case_sensitive: e.caseSensitive ?? false,
      name: e.comment ?? "",
      id: typeof e.uid === "number" ? e.uid : i,
      priority: e.order ?? 0,
      extensions: isRecord(e.extensions) ? { ...e.extensions } : {},
    })),
  };
}
