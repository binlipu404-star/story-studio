// ============================================================
// 大纲树纯逻辑（无 IO、无 Dexie、无 AI；UI/服务层负责落库与调用）
// 覆盖：层级校验、前序遍历、血缘、总纲 JSON→节点映射、markdown 导出、试跑回写
// ============================================================

import type { OutlineNode, OutlineLevel, OutlineStatus, Beat, ID } from "../core/types";

export const LEVEL_ORDER: OutlineLevel[] = ["volume", "chapter", "scene", "beat"];
export const LEVEL_NAMES: Record<OutlineLevel, string> = { volume: "卷", chapter: "章", scene: "幕", beat: "拍" };

export const STATUS_NAMES: Record<OutlineStatus, string> = {
  idea: "灵感",
  draft: "草案",
  refined: "细化",
  tested: "已试跑",
  locked: "已锁定",
};

function levelIdx(l: OutlineLevel): number {
  return LEVEL_ORDER.indexOf(l);
}

// ---------- 结构校验 ----------

/** 放置校验：返回 null=合法；字符串=给用户看的拒绝理由 */
export function validatePlacement(
  child: { id?: ID; level: OutlineLevel },
  parent: { id: ID; level: OutlineLevel } | null,
  isDescendantOf?: (candidateAncestorId: ID) => boolean,
): string | null {
  if (child.level === "volume") {
    return parent ? "卷是最外层，不能挂在任何节点下" : null;
  }
  if (!parent) return `${LEVEL_NAMES[child.level]}必须有上级节点`;
  if (levelIdx(child.level) <= levelIdx(parent.level)) {
    return `${LEVEL_NAMES[child.level]}不能挂在${LEVEL_NAMES[parent.level]}下（层级必须更细）`;
  }
  if (child.id && isDescendantOf?.(parent.id)) return "不能把节点移动到它自己的子树里";
  return null;
}

/** 状态机：唯一硬规则——进入 locked 前必须 tested（解锁自由） */
export function canTransition(from: OutlineStatus, to: OutlineStatus): boolean {
  if (to === "locked") return from === "tested" || from === "locked";
  return true;
}

// ---------- 树遍历（对平面数组做树操作） ----------

export function childrenOf(nodes: OutlineNode[], parentId: ID | null): OutlineNode[] {
  return nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** 前序（阅读/上演顺序）；不传 rootId 则遍历整片森林 */
export function preorder(nodes: OutlineNode[], rootId?: ID): OutlineNode[] {
  const out: OutlineNode[] = [];
  const roots = rootId ? nodes.filter((n) => n.id === rootId) : childrenOf(nodes, null);
  const walk = (n: OutlineNode) => {
    out.push(n);
    for (const c of childrenOf(nodes, n.id)) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}

/** 血缘链：根→…→父→自身（含自身）；防御环 */
export function lineageOf(nodes: OutlineNode[], id: ID): OutlineNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const chain: OutlineNode[] = [];
  const seen = new Set<ID>();
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return chain;
}

export function subtreeIds(nodes: OutlineNode[], rootId: ID): ID[] {
  return preorder(nodes, rootId).map((n) => n.id);
}

/** 前一幕/后一幕（前序里的 scene 序列） */
export function sceneSequence(nodes: OutlineNode[]): OutlineNode[] {
  return preorder(nodes).filter((n) => n.level === "scene");
}

// ---------- 总纲 JSON → 节点行 ----------

export interface MasterOutlineJson {
  logline?: string;
  volumes?: {
    title?: string;
    intent?: string;
    chapters?: {
      title?: string;
      intent?: string;
      scenes?: {
        title?: string;
        intent?: string;
        location?: string;
        timepoint?: string;
        cast?: string[];
        beats?: string[];
      }[];
    }[];
  }[];
}

export interface MasterMapping {
  nodes: OutlineNode[];
  warnings: string[];
  logline: string;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v.trim() : fallback;
}

/**
 * 把 masterOutlinePrompt 产出的 JSON 映射成 OutlineNode 行。
 * charactersByName: 角色名→Character.id 映射；匹配不上的名字保留原文并给警告。
 * 形态非法时抛 Error（调用方用 ai/json.ts 重试或提示人工修复）。
 */
export function masterToNodes(
  outline: unknown,
  projectId: ID,
  opts: { charactersByName?: Record<string, ID>; uid: () => ID; now?: () => number },
): MasterMapping {
  const now = opts.now?.() ?? Date.now();
  const warnings: string[] = [];
  const nodes: OutlineNode[] = [];
  const o = outline as MasterOutlineJson | null;
  if (!o || typeof o !== "object" || !Array.isArray(o.volumes) || !o.volumes.length) {
    throw new Error("总纲 JSON 缺少 volumes 数组，无法映射");
  }
  const mk = (level: OutlineLevel, parentId: ID | null, order: number, title: string, intent: string): OutlineNode => ({
    id: opts.uid(),
    projectId,
    parentId,
    level,
    order,
    title,
    intent,
    beats: [],
    cast: [],
    foreshadows: [],
    status: "draft",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  });
  o.volumes.forEach((v, vi) => {
    const vol = mk("volume", null, vi, str(v?.title) || `第${vi + 1}卷`, str(v?.intent));
    nodes.push(vol);
    (Array.isArray(v?.chapters) ? v.chapters : []).forEach((ch, ci) => {
      const chap = mk("chapter", vol.id, ci, str(ch?.title) || `第${ci + 1}章`, str(ch?.intent));
      nodes.push(chap);
      (Array.isArray(ch?.scenes) ? ch.scenes : []).forEach((sc, si) => {
        const scene = mk("scene", chap.id, si, str(sc?.title) || `第${si + 1}幕`, str(sc?.intent));
        scene.location = str(sc?.location) || undefined;
        scene.timepoint = str(sc?.timepoint) || undefined;
        scene.beats = beatsFromStrings(Array.isArray(sc?.beats) ? sc.beats : [], opts.uid);
        for (const name of Array.isArray(sc?.cast) ? sc.cast : []) {
          const nm = str(name);
          if (!nm) continue;
          const cid = opts.charactersByName?.[nm];
          if (cid) scene.cast.push(cid);
          else warnings.push(`幕「${scene.title}」的角色「${nm}」未在人物库中匹配到`);
        }
        nodes.push(scene);
      });
    });
  });
  return { nodes, warnings, logline: str(o.logline) };
}

export function beatsFromStrings(texts: unknown[], uid: () => ID): Beat[] {
  return texts
    .map((t) => (typeof t === "string" ? t.trim() : ""))
    .filter(Boolean)
    .map((text) => ({ id: uid(), text }));
}

// ---------- 大纲导出 Markdown ----------

export function treeToMarkdown(nodes: OutlineNode[], rootId?: ID): string {
  const roots = rootId ? nodes.filter((n) => n.id === rootId) : childrenOf(nodes, null);
  const lines: string[] = [];
  const walk = (n: OutlineNode, depth: number) => {
    lines.push(`${"#".repeat(Math.min(depth + 1, 6))} ${LEVEL_NAMES[n.level]}·${n.title}（${STATUS_NAMES[n.status]}）`);
    if (n.intent) lines.push(`> ${n.intent}`);
    const meta = [
      n.location ? `地点：${n.location}` : "",
      n.timepoint ? `时间：${n.timepoint}` : "",
      n.cast.length ? `角色：${n.cast.length}人` : "",
    ]
      .filter(Boolean)
      .join("｜");
    if (meta) lines.push(meta);
    if (n.beats.length) lines.push(...n.beats.map((b, i) => `${i + 1}. ${b.text}${b.done ? " ✅" : ""}`));
    for (const fo of n.foreshadows) {
      lines.push(`- 伏笔[${fo.status}] ${fo.setup}${fo.payoffIn ? ` → 回收于 ${fo.payoffIn}` : ""}`);
    }
    for (const c of childrenOf(nodes, n.id)) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return lines.join("\n");
}

// ---------- 试跑回写（sessionRecapPrompt 产物 → 节点提案） ----------

export interface RecapBeatStatus {
  beat: string;
  status: "hit" | "partial" | "missed";
  evidence?: string;
}
export interface RecapDivergence {
  desc: string;
  severity?: "minor" | "major" | string;
  suggestion?: "update_outline" | "steer" | "accept" | string;
}
export interface RecapResult {
  summary?: string;
  beatStatus?: RecapBeatStatus[];
  divergences?: RecapDivergence[];
  proposals?: { type?: string; content?: string; actors?: string[] }[];
}

export interface RecapApplication {
  beatUpdates: { id: ID; done: boolean }[];
  hitRate: number | null; // 无节拍=null；partial 计半
  suggestedStatus: "tested";
  divergenceReport: string[];
  majorCount: number;
}

/** 把导回分析结果映射成对该幕节点的修改提案（落库前仍需用户确认） */
export function applyRecapToNode(node: OutlineNode, recap: RecapResult): RecapApplication {
  const byText = new Map(node.beats.map((b) => [b.text.trim(), b]));
  const beatUpdates: { id: ID; done: boolean }[] = [];
  let hit = 0;
  let judged = 0;
  for (const bs of recap.beatStatus ?? []) {
    const beat = byText.get(str(bs?.beat));
    if (!beat) continue;
    const done = bs.status === "hit";
    beatUpdates.push({ id: beat.id, done });
    judged++;
    if (done) hit++;
    else if (bs.status === "partial") hit += 0.5;
  }
  const divergences = (recap.divergences ?? []).filter((d) => d && str(d.desc));
  const majorCount = divergences.filter((d) => d.severity === "major").length;
  return {
    beatUpdates,
    hitRate: node.beats.length ? (judged ? hit / node.beats.length : 0) : null,
    suggestedStatus: "tested",
    divergenceReport: divergences.map(
      (d) => `[${d.severity === "major" ? "重大偏差" : "小偏差"}] ${d.desc}${d.suggestion ? `（建议：${d.suggestion}）` : ""}`,
    ),
    majorCount,
  };
}

/** 偏差三选一里「反向修纲」的草案：把未命中节拍替换为实际走向要点 */
export function reweaveBeats(node: OutlineNode, recap: RecapResult): Beat[] {
  const hitTexts = new Set((recap.beatStatus ?? []).filter((b) => b?.status === "hit").map((b) => str(b.beat)));
  const out: Beat[] = [];
  for (const b of node.beats) {
    if (hitTexts.has(b.text.trim())) out.push({ ...b, done: true });
    else {
      const bs = (recap.beatStatus ?? []).find((x) => str(x.beat) === b.text.trim() && x?.evidence);
      out.push({ ...b, done: false, text: bs?.evidence ? `${b.text}（实际：${str(bs.evidence)}）` : b.text });
    }
  }
  return out;
}
