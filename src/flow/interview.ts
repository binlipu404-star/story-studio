// ============================================================
// M2 构思访谈：字段更新状态机（纯函数）
// 语义：AI/用户的更新都是「提案」，确认后经本函数落到档案；
//       上游字段被改动 → 下游（deps 传递闭包）中已有内容的字段标 stale。
// ============================================================

import type { BibleField, ID } from "../core/types";

export interface BibleUpdate {
  key: string;
  value: string;
  status?: "rough" | "confirmed";
  note?: string;
}

export interface BibleMergeResult {
  fields: BibleField[];
  changedKeys: ID[]; // 本轮真正被改动的 key
  staleKeys: ID[]; // 本轮被标陈旧的下层 key
  ignored: string[]; // 未知 key / 空值等被忽略的更新
}

/** 把一组更新应用到字段表，并做 stale 传导（不改入参，返回新数组） */
export function mergeBibleUpdates(fields: BibleField[], updates: BibleUpdate[]): BibleMergeResult {
  const next = fields.map((f) => ({ ...f }));
  const byKey = new Map(next.map((f) => [f.key, f]));
  const changedKeys: string[] = [];
  const ignored: string[] = [];
  const updatedNow = new Set<string>();

  for (const u of updates ?? []) {
    const key = typeof u?.key === "string" ? u.key.trim() : "";
    const value = typeof u?.value === "string" ? u.value.trim() : "";
    const f = byKey.get(key);
    if (!f || !value) {
      ignored.push(key || "(空key)");
      continue;
    }
    if (f.value === value && f.status === (u.status ?? "confirmed")) continue; // 无变化
    f.value = value;
    f.status = u.status ?? "confirmed";
    updatedNow.add(key);
    if (!changedKeys.includes(key)) changedKeys.push(key);
  }

  // 传递闭包：谁（间接）依赖被改动的字段？
  const staleKeys: string[] = [];
  if (changedKeys.length) {
    const dependents = new Map<string, BibleField[]>(); // key → 直接依赖它的字段
    for (const f of next) for (const d of f.deps) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(f);
    const frontier = [...changedKeys];
    const seen = new Set<string>(frontier);
    while (frontier.length) {
      const k = frontier.shift()!;
      for (const dep of dependents.get(k) ?? []) {
        if (seen.has(dep.key)) continue;
        seen.add(dep.key);
        // 本轮自己也更新了的不标 stale；空字段无所谓陈旧
        if (!updatedNow.has(dep.key) && dep.value && dep.status !== "stale") {
          dep.status = "stale";
          staleKeys.push(dep.key);
        }
        frontier.push(dep.key);
      }
    }
  }
  return { fields: next, changedKeys, staleKeys, ignored };
}

/** 下一个该问的字段：空缺 > 粗略 > 待复查；同级按档案顺序（分组序=数组序） */
export function firstFocus(fields: BibleField[]): BibleField | null {
  const rank = { empty: 0, rough: 1, stale: 2, confirmed: 3 } as const;
  let best: BibleField | null = null;
  for (const f of fields) {
    if (f.status === "confirmed") continue;
    if (!best || rank[f.status] < rank[best.status]) best = f;
  }
  return best;
}

/** 档案完成度（0~1）：confirmed 或 rough 记 0.5，stale 记 0.25 */
export function bibleProgress(fields: BibleField[]): number {
  if (!fields.length) return 0;
  let s = 0;
  for (const f of fields) {
    if (f.status === "confirmed") s += 1;
    else if (f.status === "rough") s += 0.5;
    else if (f.status === "stale") s += 0.25;
  }
  return Math.round((s / fields.length) * 100) / 100;
}
