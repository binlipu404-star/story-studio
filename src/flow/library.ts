// ============================================================
// v4 全局资产库 — 可见集纯逻辑（无 IO，进 logic 编译范围可测）
// 模型（零迁移）：
//   - Character/LoreEntry 的 projectId 语义 =「主场作品」（溯源用，'' = 全局页直建）；
//   - Project.castIds / loreIds =「外部选用列表」；缺失 ⇔ 旧数据 = 不选用外部资产；
//   - 某作品对某资产的可见集 = 自有（projectId 命中）∪ 选用（id 命中列表）。
// 悬空容忍：选用列表里的 id 若资产已删，一律按不存在处理（读侧过滤，不做迁移）。
// 排序契约：本模块只做过滤，**不重排**——行的稳定排序仍由 repos 门面负责，
// 保证同一输入恒得同一输出（剧场前缀缓存依赖字节稳定）。
// ============================================================
import type { ID } from "../core/types";

/** 带 id + 主场 projectId 的行（Character / LoreEntry 的公共形状）。 */
export interface OwnedRow {
  id: ID;
  projectId: ID;
}

/**
 * 作品可见集 = 自有 ∪ 选用（保持入参 rows 原有顺序，去重）。
 * projectId 传 null → 全局库视角：全部行。
 */
export function filterVisible<T extends OwnedRow>(
  rows: T[],
  projectId: ID | null,
  selectedIds: ID[] | undefined,
): T[] {
  if (projectId === null) return [...rows];
  const sel = new Set(selectedIds ?? []);
  return rows.filter((r) => r.projectId === projectId || sel.has(r.id));
}

/** 选用/取消选用（纯函数）：已选则移除，未选则追加；返回新数组，不改入参。 */
export function toggleSelected(selectedIds: ID[] | undefined, id: ID): ID[] {
  const cur = selectedIds ?? [];
  return cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
}

/** 剔除悬空 id（资产已删/从未存在）：写回 Project 选用列表前调用，幂等。 */
export function pruneSelection(selectedIds: ID[] | undefined, aliveIds: Iterable<ID>): ID[] {
  const alive = new Set(aliveIds);
  return (selectedIds ?? []).filter((x) => alive.has(x));
}

/** 该作品实际「用到」的外部资产数（选用列表 ∩ 存活资产），统计卡展示用。 */
export function usedSelectedCount(selectedIds: ID[] | undefined, aliveIds: Iterable<ID>): number {
  const alive = new Set(aliveIds);
  return (selectedIds ?? []).reduce((n, x) => (alive.has(x) ? n + 1 : n), 0);
}

// ============================================================
// v5 世界书「整本书」可见集纯逻辑
// 模型：LoreEntry.bookId 标记归属书；Project.loreBookIds = 按序选用的书。
// 排序契约同 filterVisible：只过滤不重排——行的稳定次序由 repos 门面提供（bookId 相同行保持
// 入参数组原有 order/uid 序），跨书拼接顺序由「选中书序」决定，保证输入恒得同一输出（前缀缓存依赖）。
// ============================================================

/** 取属于某一本书的词条（保持入参数组顺序）。 */
export function entriesOfBook<T extends { bookId?: ID }>(entries: T[], bookId: ID): T[] {
  return entries.filter((e) => e.bookId === bookId);
}

/**
 * 按「选中书序」拼接各书全部词条（每个 bookId 在 bookIds 里出现的次序 = 拼接次序；
 * 书内维持入参数组原序）。悬空书 id 自动忽略。
 */
export function entriesOfBooks<T extends { bookId?: ID }>(entries: T[], bookIds: ID[] | undefined): T[] {
  if (!bookIds || bookIds.length === 0) return [];
  const out: T[] = [];
  for (const bid of bookIds) {
    for (const e of entries) {
      if (e.bookId === bid) out.push(e);
    }
  }
  return out;
}

/**
 * 作品可见词条（v5）：
 *   - bookIds 已定义 → 按「选中书序」拼接各书词条（每本书内维持入参数组原序），
 *     尾部再补「本作品自有的未归书词条」（迁移收尾前的兜底尾巴）；
 *   - bookIds 未定义（旧数据、未迁移）→ 回落 v4 语义：返回自有（projectId 命中本作品）的行。
 * 纯函数只过滤+按选择序拼接，不更动书内相对顺序。
 */
export function visibleByBooks<T extends { bookId?: ID; projectId: ID }>(
  entries: T[],
  projectId: ID,
  bookIds: ID[] | undefined,
): T[] {
  if (bookIds === undefined) {
    return entries.filter((e) => e.projectId === projectId);
  }
  const out: T[] = [];
  for (const bid of bookIds) {
    for (const e of entries) {
      if (e.bookId === bid) out.push(e);
    }
  }
  // 自有未归书兜底（正常迁移后不存在）
  for (const e of entries) {
    if (e.bookId === undefined && e.projectId === projectId) out.push(e);
  }
  return out;
}

/** 整本启用过滤：保留「启用书」的词条 + 未归书词条（迁移兜底）；enabledIds 传 null ⇒ 全保留。 */
export function keepBooksEnabled<T extends { bookId?: ID }>(entries: T[], enabledIds: Set<ID> | null): T[] {
  if (enabledIds === null) return [...entries];
  return entries.filter((e) => e.bookId === undefined || enabledIds.has(e.bookId));
}

/** 旧散装词条（bookId 缺失）是否还存在——用于「旧版词条」合并的判定与提示。 */
export function hasUnbookedEntries<T extends { bookId?: ID }>(entries: T[]): boolean {
  return entries.some((e) => e.bookId === undefined);
}

/**
 * 旧数据 shim 的纯逻辑核心：把散装词条（bookId 缺失）全部归入 legacyBookId 一书。
 * 返回 { entries: 打上书 id 后的全部词条, merged: 本次新归入的书 id 列表（bookId 原本缺失的行） }。
 * 只做标记不改序；shim 由 repos 落库时调用。
 */
export function assignLegacyBook<T extends { bookId?: ID }>(entries: T[], legacyBookId: ID): { entries: T[]; merged: T[] } {
  const out = entries.map<T>((e) => (e.bookId === undefined ? { ...e, bookId: legacyBookId } : e));
  return { entries: out, merged: out.filter((e) => e.bookId === legacyBookId) };
}

/**
 * 作品应否「自动选中旧版词条书」：旧书迁移后，
 *   有旧 loreIds（v4 选过词条）或 在旧书里有自有词条 的作品，一律把 legacy 书放进选用开头，
 *   保住 v4 的「自有 ∪ 选用」可见语义。pure：只算该选哪些书，落库由 repos 做。
 */
export function legacySelection(
  project: { loreIds?: ID[]; loreBookIds?: ID[] },
  ownInLegacy: boolean,
  legacyBookId: ID,
): ID[] {
  const hadOldSelection = (project.loreIds?.length ?? 0) > 0;
  if (!hadOldSelection && !ownInLegacy) return project.loreBookIds ?? [];
  const cur = project.loreBookIds ?? [];
  return cur.includes(legacyBookId) ? cur : [legacyBookId, ...cur];
}

// ---------- 访谈辅助选材：世界书按整本勾选（v8-D3，纯函数可测） ----------

/**
 * 整本勾选/取消：把某书全部词条 id 并入/移出已选集。
 * 结果按 id 升序（选材的顺序契约：id 升序存储 → 注入块字节稳定，前缀缓存可命中）。
 */
export function toggleBookIds(selected: ID[], bookEntryIds: ID[], on: boolean): ID[] {
  const set = new Set(selected);
  if (on) for (const id of bookEntryIds) set.add(id);
  else for (const id of bookEntryIds) set.delete(id);
  return [...set].sort();
}

/** 整本勾选三态：该书页全在已选=all，一条都没有=none，其余=some（UI 画 indeterminate）。 */
export function bookSelState(bookEntryIds: ID[], selected: Set<ID>): "all" | "some" | "none" {
  let hit = 0;
  for (const id of bookEntryIds) if (selected.has(id)) hit++;
  if (hit === 0) return "none";
  return hit === bookEntryIds.length ? "all" : "some";
}
