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
