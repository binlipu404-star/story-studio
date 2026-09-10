// v7.1-W3：「应用到大纲树」= 以草稿为准的**合并**计划（纯函数，零 IO，进 dist-test 断言）
//
// 用户 2026-09-10 定调：有旧大纲时，应用对话创作的草稿应当
//  · 以草稿为准（同名卷/章/幕按标题识别为同一个，用草稿字段更新它）；
//  · 不出现重复章节（识别命中就走更新，不再新增一行同名的）；
//  · 不删减（草稿没提到的旧节点一律原地保留，绝不删）。
//
// 分层纪律：本文件只算「写什么」，不碰 Dexie。落库由调用方按三路分发——
//  creates      → db.outlineNodes.bulkAdd
//  fieldUpdates → repos.updateNode（内容修订，revision+1，右栏编辑器按 key=id:revision 重挂载）
//  orderUpdates → repos.applyMovePlan（**排序/换父不动 revision**，见 repos.ts 注释契约）
// 这条分界不是洁癖：把纯排序塞进 updateNode 会重挂载编辑器、吞掉用户未保存的草稿。

import type { ID, OutlineNode } from "../core/types";
import { masterToNodes, type MasterOutlineJson, type MoveUpdate } from "./outline.js";

/** 命中节点的内容补丁。title/status/beats.id/foreshadows 永不进补丁（见 rules）。 */
export interface DraftFieldPatch {
  intent?: string;
  location?: string;
  timepoint?: string;
  cast?: ID[];
  beats?: OutlineNode["beats"];
}

export interface DraftMergeStats {
  updated: number;
  created: number;
  kept: number;
}

export interface DraftMergePlan {
  creates: OutlineNode[];
  fieldUpdates: { id: ID; patch: DraftFieldPatch }[];
  orderUpdates: MoveUpdate[];
  /** 「顺手生成节拍」的目标：新建空幕 ∪ 命中但旧树本就无节拍的幕 */
  newEmptySceneIds: ID[];
  stats: DraftMergeStats;
  warnings: string[];
}

/**
 * 匹配键：标题归一化。NFKC（全角数字/标点归半角）+ 去全部空白 + 小写 + 剥成对书名号。
 * 归一后为空串的标题永不参与匹配（必然按新增处理）——空标题无法判定"同一个"。
 */
export function normTitle(t: string | undefined): string {
  if (!t) return "";
  let s = t.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  const pairs: [string, string][] = [
    ["《", "》"],
    ["〈", "〉"],
    ["「", "」"],
    ["『", "』"],
    ["“", "”"],
    ["(", ")"],
    ["（", "）"],
  ];
  for (const [l, r] of pairs) {
    while (s.length >= l.length + r.length && s.startsWith(l) && s.endsWith(r)) {
      s = s.slice(l.length, s.length - r.length);
    }
  }
  return s;
}

/**
 * 把对话创作草稿合并进既有大纲树，算出最小写集。
 * @param existing 当前整树平面数组（repos.listNodes 结果，含卷/章/幕）
 * @param draft    对话创作的草稿（形态同总纲 JSON；beats 恒空是契约）
 */
export function planDraftMerge(
  existing: OutlineNode[],
  draft: MasterOutlineJson | null | undefined,
  opts: { projectId: ID; uid: () => ID; now?: () => number; charactersByName?: Record<string, ID> },
): DraftMergePlan {
  const now = opts.now?.() ?? Date.now();
  const keptAll = existing.length;
  // masterToNodes 对空 volumes 会抛，这里先挡（页面原有守卫的等价前置）
  if (!draft || typeof draft !== "object" || !Array.isArray(draft.volumes) || draft.volumes.length === 0) {
    return {
      creates: [],
      fieldUpdates: [],
      orderUpdates: [],
      newEmptySceneIds: [],
      stats: { updated: 0, created: 0, kept: keptAll },
      warnings: [],
    };
  }
  const mapped = masterToNodes(draft, opts.projectId, {
    charactersByName: opts.charactersByName,
    uid: opts.uid,
    now: () => now,
  });
  const warnings = [...mapped.warnings];

  const group = (rows: OutlineNode[]) => {
    const m = new Map<ID | null, OutlineNode[]>();
    for (const n of rows) {
      const k = n.parentId ?? null;
      const arr = m.get(k);
      if (arr) arr.push(n);
      else m.set(k, [n]);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    return m;
  };
  const draftKids = group(mapped.nodes);
  const liveKids = group(existing);

  const creates: OutlineNode[] = [];
  const fieldUpdates: { id: ID; patch: DraftFieldPatch }[] = [];
  const orderUpdates: MoveUpdate[] = [];
  const newEmptySceneIds: ID[] = [];
  const matched = new Set<ID>(); // 旧树中被草稿认领（=同一个节点）的 id
  const keptIds = new Set<ID>(); // 草稿未提及、原地保留的旧节点 id
  let updated = 0;
  let created = 0;

  /** 整棵新建子树入表（旧树里没有它的容身之处，直接照草稿结构搬） */
  const createSubtree = (draftNode: OutlineNode, parentId: ID | null, order: number) => {
    const fresh: OutlineNode = {
      ...draftNode,
      id: opts.uid(),
      parentId,
      order,
      beats: draftNode.beats.map((b) => ({ ...b })),
    };
    creates.push(fresh);
    created++;
    if (fresh.level === "scene" && fresh.beats.length === 0) newEmptySceneIds.push(fresh.id);
    (draftKids.get(draftNode.id) ?? []).forEach((c, i) => createSubtree(c, fresh.id, i));
  };

  /** 草稿字段非空才覆盖；空一律保留旧值（作者手写的东西不会被 AI 的空字段抹掉） */
  const buildPatch = (d: OutlineNode, e: OutlineNode): DraftFieldPatch => {
    const p: DraftFieldPatch = {};
    const s = (v?: string) => (typeof v === "string" ? v.trim() : "");
    if (s(d.intent) && s(d.intent) !== s(e.intent)) p.intent = d.intent;
    if (s(d.location) && s(d.location) !== s(e.location)) p.location = d.location;
    if (s(d.timepoint) && s(d.timepoint) !== s(e.timepoint)) p.timepoint = d.timepoint;
    if (d.cast.length > 0 && d.cast.join("\u0000") !== e.cast.join("\u0000")) p.cast = [...d.cast];
    // 节拍：既有已填过的一拍都不动（含 done 已演标记）；既有为空才采纳草稿的
    if (d.beats.length > 0 && e.beats.length === 0) p.beats = d.beats.map((b) => ({ ...b }));
    return p;
  };

  /** 同父一组内的匹配 + 追加 + 重排（严格同 level 才算同一个，层级不许错配） */
  const mergeLevel = (parentLive: ID | null, parentDraft: ID | null) => {
    const dk = draftKids.get(parentDraft) ?? [];
    if (dk.length === 0) return;
    const ek = liveKids.get(parentLive) ?? [];
    let order = 0;
    for (const d of dk) {
      const key = normTitle(d.title);
      const hit = key ? ek.find((e) => !matched.has(e.id) && e.level === d.level && normTitle(e.title) === key) : undefined;
      if (hit) {
        matched.add(hit.id);
        const patch = buildPatch(d, hit);
        if (Object.keys(patch).length > 0) {
          fieldUpdates.push({ id: hit.id, patch });
          updated++;
        }
        const willHaveBeats = (patch.beats?.length ?? 0) > 0 || hit.beats.length > 0;
        if (d.level === "scene" && !willHaveBeats) newEmptySceneIds.push(hit.id);
        if (hit.order !== order) orderUpdates.push({ id: hit.id, order });
        order++;
        mergeLevel(hit.id, d.id);
        continue;
      }
      createSubtree(d, parentLive, order);
      order++;
    }
    // 草稿没提的旧节点：一律保留，垫到组尾（保持原有相对序），绝不删
    for (const e of ek) {
      if (matched.has(e.id) || keptIds.has(e.id)) continue;
      keptIds.add(e.id);
      if (e.order !== order) orderUpdates.push({ id: e.id, order });
      order++;
    }
  };
  mergeLevel(null, null);

  return {
    creates,
    fieldUpdates,
    orderUpdates,
    newEmptySceneIds,
    stats: { updated, created, kept: keptIds.size },
    warnings,
  };
}
