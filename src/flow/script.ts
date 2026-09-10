// ============================================================
// RP 剧场剧本副本与推进（v3；纯逻辑，Node/浏览器同构，零运行时依赖 core/types 之外）
//
// 原则：聊天只认「副本」(ScriptSnapshot)。主纲的改动永远不会自动渗透进剧组——
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
  // v8-B 全书任务卡：父链（不含本幕）上有 intent 的层；老消费方读 undefined 自然跳过
  const byId2 = new Map(nodes.map((x) => [x.id, x] as const));
  const ancestorsOf = (n: OutlineNode): { title: string; intent: string }[] => {
    const chain: { title: string; intent: string }[] = [];
    let cur = n.parentId ? byId2.get(n.parentId) : undefined;
    while (cur) {
      if (cur.intent.trim()) chain.unshift({ title: cur.title || "（未命名）", intent: cur.intent.trim() });
      cur = cur.parentId ? byId2.get(cur.parentId) : undefined;
    }
    return chain.length ? chain : [];
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
      ancestors: ancestorsOf(s),
      beats: s.beats.map((b) => ({ id: b.id, text: b.text })),
      foreshadows: s.foreshadows.map((f) => ({ id: f.id, setup: f.setup })),
    })),
  };
}

/** 副本生成后主纲变化的描述（v7.1-W2：从布尔升级为明细，边写大纲边 RP 要看得见"改在哪"） */
export interface ScriptUpdateInfo {
  changed: boolean;
  /** 副本内已被改动（title/intent/beats 等）的幕题 */
  edited: string[];
  /** 副本内引用、但主纲已删掉的幕题（同步后这些幕会从副本消失） */
  removed: string[];
  /** 主纲新增（副本外）的幕数（同步后会插进副本） */
  added: number;
}

/** 描述主纲相对副本的变化。空副本（沙盒组）恒无变化。 */
export function describeMainScriptUpdate(snapshot: ScriptSnapshot, nodes: OutlineNode[]): ScriptUpdateInfo {
  if (!snapshot.scenes.length) return { changed: false, edited: [], removed: [], added: 0 };
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const edited: string[] = [];
  const removed: string[] = [];
  for (const sc of snapshot.scenes) {
    const live = sc.nodeId ? byId.get(sc.nodeId) : undefined;
    if (!live) removed.push(sc.title || "（未命名）");
    else if (live.updatedAt > snapshot.nodesUpdatedAt) edited.push(sc.title || "（未命名）");
  }
  const snapIds = new Set(snapshot.scenes.map((s) => s.nodeId));
  const added = nodes.filter((n) => n.level === "scene" && !snapIds.has(n.id)).length;
  return { changed: edited.length + removed.length + added > 0, edited, removed, added };
}

/** 副本生成后主纲是否又变了（full 模式同步提示的依据）。v7.1-W2 起含删幕与新增幕。 */
export function detectMainScriptUpdate(snapshot: ScriptSnapshot, nodes: OutlineNode[]): boolean {
  return describeMainScriptUpdate(snapshot, nodes).changed;
}

/**
 * v8-A 同步副本时的指针重定位：旧指针指的幕按标题在新副本里找同一位置；
 * 找不到（该幕被删/改名）→ null=回落自动推导。纯函数可测。
 */
export function remapPointerOnSync(
  pointer: number | undefined,
  oldScenes: ScriptSnapshot["scenes"],
  newScenes: ScriptSnapshot["scenes"],
): number | undefined {
  const i = resolveScenePointerIndex(pointer, oldScenes);
  if (i === null) return undefined;
  const title = oldScenes[i].title;
  const j = newScenes.findIndex((sc) => sc.title === title);
  return j >= 0 ? j : undefined;
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
  currentSceneIndex: number | null; // 当前幕（v8-A：优先手动指针，否则=第一个未全完成的幕）
  currentBeatId: string | null; // 该幕第一个未标记节拍
  currentBeatText: string | null;
  scenesDone: number;
  scenesTotal: number;
  beatsDone: number;
  beatsTotal: number;
  /** v8-A 当前幕自己的拍子（备忘行用它：别幕有拍不得掩护本幕的留白） */
  currentSceneBeatsTotal: number;
  currentSceneBeatsUndone: number;
  finished: boolean; // v8-A：有指针=指针顶到最后一幕；无指针=全部幕的节拍都有标记
  pointerActive: boolean; // v8-A：本结果来自作者手动指针（false=自动推导）
  nextHint: string; // 给模型/面板的一句话
}

/**
 * v8-A 手动故事指针解析：作者亲指的 scenes 下标。
 * 合法域 [0, scenes.length)；undefined/负数/越界/非法 → null（回落自动推导）。
 * 纯函数可测。
 */
export function resolveScenePointerIndex(pointer: number | undefined, scenes: ScriptSnapshot["scenes"]): number | null {
  if (typeof pointer !== "number" || !Number.isFinite(pointer)) return null;
  const i = Math.floor(pointer);
  if (i < 0 || i >= scenes.length) return null;
  return i;
}

/** 一幕"没演完"的判据：有拍→存在未标记拍；零拍幕=永远未完成（v8-A：无拍≠演完，进度交给手动指针） */
function sceneUndone(sc: ScriptSnapshot["scenes"][number], progress: Record<string, "done" | "skipped">): number {
  return sc.beats.filter((b) => !progress[b.id]).length;
}

export function storyAdvance(
  snapshot: ScriptSnapshot,
  progress: Record<string, "done" | "skipped">,
  pointer?: number,
): StoryAdvance {
  let scenesDone = 0;
  let beatsDone = 0;
  let beatsTotal = 0;
  let autoIdx: number | null = null;
  for (let i = 0; i < snapshot.scenes.length; i++) {
    const sc = snapshot.scenes[i];
    beatsTotal += sc.beats.length;
    const undone = sceneUndone(sc, progress);
    beatsDone += sc.beats.length - undone;
    if (undone > 0 && autoIdx === null) autoIdx = i;
    // 零拍幕不计入 scenesDone（旧行为会把"没拍"谎报成"演完"）
    if (sc.beats.length > 0 && undone === 0) scenesDone++;
  }
  // v8-A 指针优先：作者手指的幕就是当前幕，进度不再凭空猜
  const pointerIdx = resolveScenePointerIndex(pointer, snapshot.scenes);
  const currentSceneIndex = pointerIdx ?? autoIdx;
  const pointerActive = pointerIdx !== null;
  const cur = currentSceneIndex === null ? null : snapshot.scenes[currentSceneIndex];
  const curBeat = cur ? cur.beats.find((b) => !progress[b.id]) ?? null : null;
  const finished = pointerActive
    ? pointerIdx === snapshot.scenes.length - 1
    : snapshot.scenes.length > 0 && autoIdx === null && beatsTotal > 0;
  const nextHint = snapshot.scenes.length === 0
    ? "（沙盒剧组：无剧本，自由即兴）"
    : finished
      ? pointerActive
        ? `作者指针停在最后一幕「${cur?.title ?? ""}」——剧本尽头，由作者定夺收尾或续写。`
        : "副本内所有节拍已标记完成——剧本已演到副本尽头。"
      : `${pointerActive ? "作者指针指认" : "当前"}：第 ${(currentSceneIndex ?? 0) + 1}/${snapshot.scenes.length} 幕「${cur?.title ?? ""}」（${cur?.path ?? ""}）` +
        (curBeat ? `；下一拍：${curBeat.text}` : pointerActive ? "；本幕无预设节拍（作者留白：自由演出，推进由作者指针裁决）" : "");
  return {
    currentSceneIndex,
    currentBeatId: curBeat?.id ?? null,
    currentBeatText: curBeat?.text ?? null,
    scenesDone,
    scenesTotal: snapshot.scenes.length,
    beatsDone,
    beatsTotal,
    currentSceneBeatsTotal: cur?.beats.length ?? 0,
    currentSceneBeatsUndone: cur ? sceneUndone(cur, progress) : 0,
    finished,
    pointerActive,
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
  opts: { withAncestors?: boolean } = {},
): string {
  if (!snapshot.scenes.length) return "";
  const cur = adv.currentSceneIndex ?? snapshot.scenes.length - 1;
  const lines: string[] = [
    `【剧本副本·${snapshot.sourceTitle}】（剧组只按副本演；标记只影响剧组）`,
    // v8-B 免责句：intent=作者计划意图，与演出事实冲突时顺事实（构思档案块同款教训）
    "（注：「意图」是作者的计划意图，不是必须执行的台词；与已演出事实冲突时以事实为准，顺势演化，勿硬拗回计划。）",
  ];
  snapshot.scenes.forEach((sc, i) => {
    if (before > 0 || after > 0) {
      if (i < cur - before && adv.currentSceneIndex !== null) return;
      if (i > cur + after) return;
    }
    // v8-A：零拍幕不标 ✓（旧写法 every 对空数组恒真，把"没拍"画成"演完"）
    const mark = sc.beats.length > 0 && sc.beats.every((b) => progress[b.id]) ? "✓" : i === cur ? "▶" : "·";
    lines.push(`${mark} ${sc.title}`);
    // v8-B T1-D1：逐幕渲染叙事意图（任务卡不是正文，超 120 字截断）
    const intent = sc.intent.trim();
    if (intent) lines.push(`  意图：${intent.length > 120 ? intent.slice(0, 120) + "…" : intent}`);
    // v8-B 全书任务卡（仅工具读副本时开启；每轮注入的剧本块不带，省 token）
    if (opts.withAncestors && sc.ancestors && sc.ancestors.length) {
      const seg = sc.ancestors.map((a) => `${a.title}：${a.intent.length > 80 ? a.intent.slice(0, 80) + "…" : a.intent}`).join(" ┃ ");
      lines.push(`  全书任务：${seg}`);
    }
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
  if (adv.finished) {
    return adv.pointerActive
      ? "【进展备忘】作者指针停在最后一幕——剧本尽头（正典以剧组台账为准）。"
      : "【进展备忘】副本节拍已全部演完（正典以剧组台账为准）。";
  }
  if (adv.currentSceneIndex === null) return "";
  const donePart = adv.currentSceneBeatsTotal > 0
    ? `拍 ${adv.currentSceneBeatsTotal - adv.currentSceneBeatsUndone}/${adv.currentSceneBeatsTotal}`
    : "本幕无预设节拍（作者留白，自由演出）";
  return (
    `【进展备忘】${adv.pointerActive ? "作者指针指向" : ""}第 ${adv.currentSceneIndex + 1}/${adv.scenesTotal} 幕 · ${donePart}` +
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

/** 模式判定（老剧组无 scopeMode → 保守按 full） */
export function roomScope(scopeMode: TheaterScope | undefined): TheaterScope {
  return scopeMode === "chapters" ? "chapters" : "full";
}

/**
 * 副本视角的伏笔欠账：setup 未被剧组台账（foreshadow 类型且正文含 setup 关键片段）
 * 或未勾节拍标记视为欠账。只认剧组数据——剧本副本之外零依赖（chapters 模式的
 * 「不敏感」正从这里成立：主纲改了也看不到）。
 */
export function snapshotDebt(
  snapshot: ScriptSnapshot,
  paidSetups: string[], // 剧组台账中 foreshadow 记录的正文（视为已回收声明）
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
