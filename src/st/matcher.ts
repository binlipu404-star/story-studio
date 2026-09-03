// ============================================================
// SillyTavern 世界书匹配引擎（纯逻辑模块）
// - 纯函数、无副作用；除 `import type` 外零运行时依赖。
// - 不使用任何 DOM / Node 专属 API（仅 ECMAScript 标准库）。
// - 输入是内部规范化形态 LoreEntry / LorebookSettings（见 core/types.ts）。
//
// 本版明确不实现（无状态引擎无法跟踪激活历史，留待带状态的上层）：
//   - sticky / cooldown：ST 需要跨轮次记录"词条于第几轮激活/熄灭"，
//     本引擎每次调用互相独立，LoreEntry.sticky / cooldown 两字段本版不生效。
//   - group 的随机加权抽取（ST 按权重随机选一条）：本版为确定性简化——
//     同组只留 groupWeight 大者，tie 按 order 小者，再 tie 按 uid 小者。
//   - groupOverride 字段本版不参与判定（group 规则统一为"非空 group → 同组留一"）。
// ============================================================

import type { LoreEntry, LorebookSettings } from "../core/types";

export interface MatchContext {
  history: { name: string; content: string }[]; // 时间正序，最后一条最新
  depthOverride?: number; // 覆盖 settings.scanDepth
  random?: () => number; // 注入随机源（默认 Math.random）
}

export interface MatchedEntry {
  entry: LoreEntry;
  via: "constant" | "primary" | "secondary" | "recursion";
}

export interface MatchResult {
  before: MatchedEntry[]; // position=before_char，按 order 升序（tie 按 uid）
  after: MatchedEntry[]; // position=after_char，同上
  injected: MatchedEntry[]; // 预算内最终保留（全部词条按 order 升序）
  dropped: MatchedEntry[]; // 超预算被裁掉的
  deep: { depth: number; entries: MatchedEntry[] }[]; // depth!=null 的词条按深度分组
  usedTokens: number;
}

// ---------- 内部工具 ----------

// CJK（含中日韩及扩展、兼容区、假名、谚文）字符检测。
// key 含 CJK 字符时跳过整词词边界检查（CJK 无空格分词，substring 即命中）。
const CJK_RE =
  /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u31f0-\u31ff\u3300-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua960-\ua97f\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/;

// 词边界判定字符集：仅 ASCII 字母/数字/下划线相邻才算"非整词"，
// 与 JS 正则 \b（\w = [A-Za-z0-9_]）语义对齐；CJK、标点、空白相邻均视为整词边界。
const WORD_NEIGHBOR_RE = /[A-Za-z0-9_]/;

/**
 * 单个 key 在扫描文本中是否命中该词条。
 * - 默认大小写不敏感（hay/needle 均已 toLowerCase，locale 无关）；caseSensitive 用原文。
 * - matchWholeWord 且 key 为纯 ASCII/拉丁：每次出现都要检查前后邻字符不是字母/数字/下划线。
 *   例："cat" 不中 "catalog"（邻 'a'），中 "the cat."（邻空格/'.'）。
 * - key 含 CJK：substring 即命中，不做邻字符检查。
 */
function keyHit(entry: LoreEntry, key: string, text: string, lower: string): boolean {
  if (key === "") return false; // 空 key 视为无效，不匹配
  const cs = entry.caseSensitive;
  const hay = cs ? text : lower;
  const needle = cs ? key : key.toLowerCase();
  const skipBoundary = !entry.matchWholeWord || CJK_RE.test(key);
  let idx = hay.indexOf(needle);
  if (idx === -1) return false;
  if (skipBoundary) return true;
  for (; idx !== -1; idx = hay.indexOf(needle, idx + 1)) {
    const before = idx === 0 ? "" : hay.charAt(idx - 1);
    const afterIdx = idx + needle.length;
    const after = afterIdx >= hay.length ? "" : hay.charAt(afterIdx);
    if (!WORD_NEIGHBOR_RE.test(before) && !WORD_NEIGHBOR_RE.test(after)) return true;
  }
  return false;
}

function anyKeyHit(entry: LoreEntry, keys: string[], text: string, lower: string): boolean {
  for (const k of keys) {
    if (keyHit(entry, k, text, lower)) return true;
  }
  return false;
}

/**
 * 主/副键判定（ST selective 简化为 AND_ANY 语义）：
 * - 主键任一命中是前提；
 * - selective 且配置了副键时，副键也须任一命中，via 记 "secondary"；
 * - 否则 via 记 "primary"。selective 但副键为空数组 → 等价普通主键匹配。
 */
function matchKeys(
  entry: LoreEntry,
  text: string,
  lower: string,
): "primary" | "secondary" | null {
  if (!anyKeyHit(entry, entry.keys, text, lower)) return null;
  if (entry.selective && entry.secondaryKeys.length > 0) {
    return anyKeyHit(entry, entry.secondaryKeys, text, lower) ? "secondary" : null;
  }
  return "primary";
}

/**
 * 概率骰：useProbability 且 probability<100 时掷 random()。
 * 规则（本版）：
 * - constant 词条不掷骰（必中）；
 * - 只有"键已命中"的词条才消耗一次 random()，按词条在数组中的先后顺序掷骰，
 *   注入的 random 若为序列生成器，其消耗顺序 = 第一轮命中词条序 → 递归轮命中词条序；
 * - probability>=100 直通不掷骰；probability=0 恒不掷骰通过（random()<0 永假，仍掷）。
 */
function probabilityPass(
  entry: LoreEntry,
  matchedNonConstant: boolean,
  random: () => number,
): boolean {
  if (!matchedNonConstant) return true; // constant：不掷骰
  if (!entry.useProbability || entry.probability >= 100) return true;
  return random() < entry.probability / 100;
}

/** group tie-break：groupWeight 大者胜 → order 小者胜 → uid 小者胜。 */
function groupWins(a: LoreEntry, b: LoreEntry): boolean {
  if (a.groupWeight !== b.groupWeight) return a.groupWeight > b.groupWeight;
  if (a.order !== b.order) return a.order < b.order;
  return a.uid < b.uid;
}

function byOrderThenUid(a: MatchedEntry, b: MatchedEntry): number {
  return a.entry.order - b.entry.order || a.entry.uid - b.entry.uid;
}

// ---------- 主入口 ----------

/**
 * 扫描 history 尾窗，决定哪些词条注入以及注入位置。
 * 流程：扫描窗拼接 → 第一轮匹配（constant/主副键/概率骰）
 *  → 递归扫描（可选，最多 1 轮） → group 同组留一 → order/uid 排序
 *  → token 预算逐条装箱（放不下的进 dropped，后续更小的词条仍可继续装箱）
 *  → 按 position 分流 before/after；depth!=null 的进 deep 分组（按 depth 升序）。
 */
export function matchLore(
  entries: LoreEntry[],
  settings: LorebookSettings,
  ctx: MatchContext,
  estimateTokens: (s: string) => number,
): MatchResult {
  const random = ctx.random ?? Math.random;

  // ---- 扫描窗：history 最后 N 条（N>=1），拼接 content 为扫描文本 ----
  // depthOverride ?? scanDepth；NaN/非数字兜底为 1；Infinity 表示全量扫描。
  // 注：只用消息 content 拼接，name 不进扫描文本（避免角色名误触 key）。
  let rawDepth: number = ctx.depthOverride ?? settings.scanDepth;
  if (typeof rawDepth !== "number" || Number.isNaN(rawDepth)) rawDepth = 1;
  const depth = Math.max(1, Math.floor(rawDepth)); // Infinity 透传（slice 尾切片取全量）
  const history = ctx.history ?? [];
  const window = depth >= history.length ? history : history.slice(history.length - depth);
  const scanText = window.map((m) => m.content).join("\n");
  const scanLower = scanText.toLowerCase();

  // ---- 第一轮匹配 ----
  const matched: MatchedEntry[] = [];
  const matchedIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.enabled) continue;
    let via: MatchedEntry["via"];
    if (entry.constant) {
      via = "constant";
    } else {
      const keyVia = matchKeys(entry, scanText, scanLower);
      if (keyVia === null) continue;
      via = keyVia;
    }
    if (!probabilityPass(entry, !entry.constant, random)) continue;
    matched.push({ entry, via });
    matchedIds.add(entry.id);
  }

  // ---- 递归扫描（最多 1 轮额外）----
  // - 任一命中词条 preventRecursion → 整个递归轮跳过；
  // - 命中且未 excludeRecursion 的词条 content 追加进扫描文本；
  // - 第二轮命中标 via="recursion"（副键参与同样记 recursion）；
  // - 已命中词条不重复；概率骰规则同第一轮（在递归轮按词条数组序消耗 random）。
  if (
    settings.recursiveScanning &&
    !matched.some((m) => m.entry.preventRecursion)
  ) {
    const extra = matched
      .filter((m) => !m.entry.excludeRecursion)
      .map((m) => m.entry.content)
      .join("\n");
    const extText = scanText + "\n" + extra;
    const extLower = extText.toLowerCase();
    for (const entry of entries) {
      if (!entry.enabled || matchedIds.has(entry.id)) continue;
      if (entry.constant) continue; // constant 已在第一轮必中，走到这里=被概率骰丢弃，递归轮不再捞回
      const keyVia = matchKeys(entry, extText, extLower);
      if (keyVia === null) continue;
      if (!probabilityPass(entry, true, random)) continue;
      matched.push({ entry, via: "recursion" });
      matchedIds.add(entry.id);
    }
  }

  // ---- group 简化：非空 group 的同组命中词条只留一条 ----
  // 其余同组词条直接舍弃（不进 dropped——dropped 语义专指"超 token 预算被裁"）。
  const survivors: MatchedEntry[] = [];
  const bestByGroup = new Map<string, MatchedEntry>();
  for (const m of matched) {
    const g = m.entry.group;
    if (g === "") {
      survivors.push(m);
      continue;
    }
    const cur = bestByGroup.get(g);
    if (cur === undefined || groupWins(m.entry, cur.entry)) bestByGroup.set(g, m);
  }
  for (const m of bestByGroup.values()) survivors.push(m);

  // ---- 排序：order 升序，tie uid 升序 ----
  survivors.sort(byOrderThenUid);

  // ---- token 预算：按序装箱，放不进预算的进 dropped（不回溯，后续小的仍可进）----
  const injected: MatchedEntry[] = [];
  const dropped: MatchedEntry[] = [];
  let usedTokens = 0;
  for (const m of survivors) {
    const cost = estimateTokens(m.entry.content);
    if (usedTokens + cost > settings.tokenBudget) {
      dropped.push(m);
      continue;
    }
    usedTokens += cost;
    injected.push(m);
  }

  // ---- 分流：before/after 从 injected 按 position 分（保持已排序序）----
  const before = injected.filter((m) => m.entry.position === "before_char");
  const after = injected.filter((m) => m.entry.position === "after_char");

  // ---- deep：injected 中 depth!=null 的按 depth 升序分组 ----
  // 只统计进了 injected 的词条（被预算裁掉的不进 deep，保证 deep ⊆ before∪after）。
  const deepMap = new Map<number, MatchedEntry[]>();
  for (const m of injected) {
    if (m.entry.depth === null) continue;
    const arr = deepMap.get(m.entry.depth);
    if (arr) arr.push(m);
    else deepMap.set(m.entry.depth, [m]);
  }
  const deep = [...deepMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([d, es]) => ({ depth: d, entries: es }));

  return { before, after, injected, dropped, deep, usedTokens };
}

/** 将最终注入的词条 content 以换行连接，供拼进提示词。 */
export function buildLoreInjection(result: MatchResult): string {
  return result.injected.map((m) => m.entry.content).join("\n");
}
