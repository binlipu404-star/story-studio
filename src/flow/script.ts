// ============================================================
// RP 剧场剧本副本与推进（v3；纯逻辑，Node/浏览器同构，零运行时依赖 core/types 之外）
//
// 原则：聊天只认「副本」(ScriptSnapshot)。主纲的改动永远不会自动渗透进房间——
// full 模式只*提示*可同步（用户点按才刷新副本）；chapters 模式连提示都不要。
// 节拍完成标记只写 roomProgress，永不回写 OutlineNode。
// ============================================================

import type { ID, OutlineNode, ScriptSnapshot, TheaterScope } from "../core/types";

// ---------- 副本构建 ----------

/** 把主纲幕序列压成副本（含全路径标题与节拍引用）。纯拷贝，无副作用。 */
export function buildScriptSnapshot(
  sourceTitle: string,
  nodes: OutlineNode[],
  scenes: OutlineNode[],
  takenAt: number,
): ScriptSnapshot {
  const pathOf = (n: OutlineNode): string => {
    const chain: string[] = [];
    let cur: OutlineNode | undefined = n;
    const byId = new Map(nodes.map((x) => [x.id, x] as const));
    while (cur) {
      chain.unshift(cur.title || "（未命名）");
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return chain.join(" › ");
  };
  return {
    sourceTitle,
    takenAt,
    nodesUpdatedAt: scenes.length > 0 ? Math.max(...scenes.map((s) => s.updatedAt), ...nodes.map((n) => n.updatedAt)) : takenAt,
    scenes: scenes.map((s) => ({
      nodeId: s.id,
      path: pathOf(s),
      title: s.title,
      intent: s.intent,
      beats: s.beats.map((b) => ({ id: b.id, text: b.text })),
      foreshadows: s.foreshadows.map((f) => ({ id: f.id, setup: f.setup })),
    })),
  };
}

/** 副本生成后主纲是否又变了（full 模式同步提示的依据：比对幕节点 updatedAt 与快照时点） */
export function detectMainScriptUpdate(snapshot: ScriptSnapshot, nodes: OutlineNode[]): boolean {
  if (!snapshot.scenes.length) return false;
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  for (const sc of snapshot.scenes) {
    const live = sc.nodeId ? byId.get(sc.nodeId) : undefined;
    if (live && live.updatedAt > snapshot.nodesUpdatedAt) return true;
  }
  return false;
}

/** 同步副本时保留已有完成标记（按 beatId；主纲重排的孤儿标记自然失效） */
export function mergeProgressOnSync(
  snapshot: ScriptSnapshot,
  progress: Record<string, "done" | "skipped"> | undefined,
): Record<string, "done" | "skipped"> {
  const alive = new Set<string>();
  for (const sc of snapshot.scenes) for (const b of sc.beats) alive.add(b.id);
  const out: Record<string, "done" | "skipped"> = {};
  for (const [k, v] of Object.entries(progress ?? {})) if (alive.has(k)) out[k] = v;
  return out;
}

// ---------- 推进状态（场记 agent 的 where_is_story / next_step 数据源） ----------

export interface StoryAdvance {
  currentSceneIndex: number | null; // 第一个未全完成的幕
  currentBeatId: string | null; // 该幕第一个未标记节拍
  currentBeatText: string | null;
  scenesDone: number;
  scenesTotal: number;
  beatsDone: number;
  beatsTotal: number;
  finished: boolean; // 副本全部幕的节拍都有标记
  nextHint: string; // 给模型/面板的一句话
}

export function storyAdvance(snapshot: ScriptSnapshot, progress: Record<string, "done" | "skipped">): StoryAdvance {
  let scenesDone = 0;
  let beatsDone = 0;
  let beatsTotal = 0;
  let currentSceneIndex: number | null = null;
  for (let i = 0; i < snapshot.scenes.length; i++) {
    const sc = snapshot.scenes[i];
    beatsTotal += sc.beats.length;
    const undone = sc.beats.filter((b) => !progress[b.id]);
    beatsDone += sc.beats.length - undone.length;
    if (undone.length > 0 && currentSceneIndex === null) currentSceneIndex = i;
    if (undone.length === 0) scenesDone++;
  }
  const cur = currentSceneIndex === null ? null : snapshot.scenes[currentSceneIndex];
  const curBeat = cur ? cur.beats.find((b) => !progress[b.id]) ?? null : null;
  const finished = snapshot.scenes.length > 0 && currentSceneIndex === null;
  const nextHint = snapshot.scenes.length === 0
    ? "（沙盒房间：无剧本，自由即兴）"
    : finished
      ? "副本内所有节拍已标记完成——剧本已演到副本尽头。"
      : `当前：第 ${currentSceneIndex! + 1}/${snapshot.scenes.length} 幕「${cur!.title}」（${cur!.path}）` +
        (curBeat ? `；下一拍：${curBeat.text}` : "");
  return {
    currentSceneIndex,
    currentBeatId: curBeat?.id ?? null,
    currentBeatText: curBeat?.text ?? null,
    scenesDone,
    scenesTotal: snapshot.scenes.length,
    beatsDone,
    beatsTotal,
    finished,
    nextHint,
  };
}

// ---------- 副本 → 提示词注入块 ----------

/**
 * 副本压缩文本（注入 system 的剧本块；场记 read_outline 同源复用）。
 * 只列到「当前幕前后」以省预算：before/after 为当前幕前后各保留的幕数，0=全部。
 */
export function scriptBlock(
  snapshot: ScriptSnapshot,
  progress: Record<string, "done" | "skipped">,
  adv: StoryAdvance,
  before = 1,
  after = 2,
): string {
  if (!snapshot.scenes.length) return "";
  const cur = adv.currentSceneIndex ?? snapshot.scenes.length - 1;
  const lines: string[] = [`【剧本副本·${snapshot.sourceTitle}】（房间只按副本演；标记只影响房间）`];
  snapshot.scenes.forEach((sc, i) => {
    if (before > 0 || after > 0) {
      if (i < cur - before && adv.currentSceneIndex !== null) return;
      if (i > cur + after) return;
    }
    const mark = sc.beats.every((b) => progress[b.id]) ? "✓" : i === cur ? "▶" : "·";
    lines.push(`${mark} ${sc.title}`);
    for (const b of sc.beats) {
      const p = progress[b.id];
      lines.push(`   ${p === "done" ? "[✓]" : p === "skipped" ? "[跳]" : "[ ]"} ${b.text}`);
    }
  });
  return lines.join("\n");
}

// ---------- 台账楼层定时 ----------

/**
 * 进展备忘行（v3.1-⑦ 配套）：一行紧凑文本写明「演到哪、下一拍是什么」，
 * 追加在剧本块尾部——场记每楼自动标进度后，这行随每轮装配刷新，
 * AI 和用户（副本清单/进展头）看到的始终是最新进度。纯函数可测。
 */
export function progressMemoText(adv: StoryAdvance): string {
  if (adv.finished) return "【进展备忘】副本节拍已全部演完（正典以房间台账为准）。";
  if (adv.currentSceneIndex === null) return "";
  const donePart = adv.beatsTotal > 0 ? `拍 ${adv.beatsDone}/${adv.beatsTotal}` : "无拍";
  return (
    `【进展备忘】第 ${adv.currentSceneIndex + 1}/${adv.scenesTotal} 幕 · ${donePart}` +
    (adv.currentBeatText ? `；下一拍：${adv.currentBeatText}` : "")
  );
}

/**
 * 定时整理触发判定：自上次触发以来新增 user 楼层 ≥ cadence 则触发一次。
 * cadence<=0 = 关闭。纯函数：楼层数按 user 消息计（"楼"=用户说一句）。
 */
export function planLedgerCadence(userFloorsSinceLast: number, cadence: number): boolean {
  if (!Number.isFinite(cadence) || cadence <= 0) return false;
  return userFloorsSinceLast >= cadence;
}

// ---------- 章选（chapters 模式） ----------

/** 从全部节点里挑出「所选章」包含的幕（章 id 列表；幕=章的子孙中 level==="scene"） */
export function scenesOfChapters(nodes: OutlineNode[], chapterIds: ID[]): OutlineNode[] {
  const keep = new Set(chapterIds);
  const owned = new Set<ID>();
  const walk = (parentId: ID | null): void => {
    for (const n of childrenSorted(nodes, parentId)) {
      if (keep.has(n.id) || (n.parentId !== null && owned.has(n.parentId))) owned.add(n.id);
      walk(n.id); // 未命中的中间层也要下钻（所选章可能嵌在卷下）
    }
  };
  walk(null);
  // 二次 DFS 按文档序收集（order 只在同父内有效，跨章不可比；卷等中间层不属于所选章也要下钻）
  const out: OutlineNode[] = [];
  const collect = (parentId: ID | null): void => {
    for (const n of childrenSorted(nodes, parentId)) {
      if (owned.has(n.id) && n.level === "scene") out.push(n);
      collect(n.id);
    }
  };
  collect(null);
  return out;
}

function childrenSorted(nodes: OutlineNode[], parentId: ID | null): OutlineNode[] {
  return nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** 模式判定（老房间无 scopeMode → 保守按 full） */
export function roomScope(scopeMode: TheaterScope | undefined): TheaterScope {
  return scopeMode === "chapters" ? "chapters" : "full";
}

/**
 * 副本视角的伏笔欠账：setup 未被房间台账（foreshadow 类型且正文含 setup 关键片段）
 * 或未勾节拍标记视为欠账。只认房间数据——剧本副本之外零依赖（chapters 模式的
 * 「不敏感」正从这里成立：主纲改了也看不到）。
 */
export function snapshotDebt(
  snapshot: ScriptSnapshot,
  paidSetups: string[], // 房间台账中 foreshadow 记录的正文（视为已回收声明）
): { sceneTitle: string; setup: string }[] {
  const norm = (s: string): string => s.replace(/[\s，。！？、；：""''（）()《》【】…—-]/g, "").toLowerCase();
  const paid = paidSetups.map(norm);
  const out: { sceneTitle: string; setup: string }[] = [];
  for (const sc of snapshot.scenes) {
    for (const f of sc.foreshadows) {
      const key = norm(f.setup);
      if (key.length < 6) {
        out.push({ sceneTitle: sc.title, setup: f.setup });
        continue;
      }
      const isPaid = paid.some((p) => p.includes(key) || key.includes(p) && p.length >= 6);
      if (!isPaid) out.push({ sceneTitle: sc.title, setup: f.setup });
    }
  }
  return out;
}

/** 欠账块文本（注入 ledgerBlock 尾部；无欠账返回空串） */
export function snapshotDebtText(debt: { sceneTitle: string; setup: string }[], cap = 12): string {
  if (debt.length === 0) return "";
  const lines = debt.slice(0, cap).map((d) => `- ${d.sceneTitle}：埋了「${d.setup}」，未见回收`);
  return `【伏笔欠账（按剧本副本）】\n${lines.join("\n")}${debt.length > cap ? `\n（另有 ${debt.length - cap} 笔未列）` : ""}`;
}
