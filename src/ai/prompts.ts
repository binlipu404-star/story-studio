// ============================================================
// 提示词库（纯函数，零运行时依赖，可进 Node 冒烟测试）
// 每个阶段一组：M2 构思访谈 / M3 大纲 / M4 试跑闭环 / M5 RP / M6 台账
// 约定：需要 AI 返回 JSON 的地方，都把 JSON 规格写死在提示里，
//       解析由调用方（服务层）用 ai/json.ts extractJson 完成。
// ============================================================

import type { BibleField, OutlineNode, Beat, LedgerRecord, ChatMessage, Persona } from "../core/types";
import type { MasterOutlineJson } from "../flow/outline.js"; // 仅类型（type-only，编译后零依赖）

// ---------- 通用小助手 ----------

/** 构思档案 → Markdown 摘要（按组渲染，标注状态；截断过长值） */
export function fieldsMarkdown(fields: BibleField[], valueLimit = 400): string {
  if (!fields.length) return "（构思档案为空）";
  const groups: Record<string, BibleField[]> = {};
  for (const f of fields) (groups[f.group] ??= []).push(f);
  const mark: Record<BibleField["status"], string> = {
    empty: "空缺",
    rough: "粗略",
    confirmed: "已确认",
    stale: "待复查",
  };
  const lines: string[] = [];
  for (const [g, fs] of Object.entries(groups)) {
    lines.push(`## ${g}`);
    for (const f of fs) {
      const v = f.value ? (f.value.length > valueLimit ? f.value.slice(0, valueLimit) + "…" : f.value) : "（空缺）";
      lines.push(`- [${f.key}]「${f.label}」状态=${mark[f.status]}：${v}`);
    }
  }
  return lines.join("\n");
}

export function beatsToLines(beats: Beat[]): string {
  return beats.map((b, i) => `${i + 1}. ${b.text}${b.done ? "（已上演）" : ""}`).join("\n");
}

/** 大纲节点 → 缩进摘要（注入后续提示词用） */
export function nodeDigest(node: OutlineNode, opts: { withBeats?: boolean } = {}): string {
  const lv: Record<OutlineNode["level"], string> = { volume: "卷", chapter: "章", scene: "幕", beat: "拍" };
  const st: Record<OutlineNode["status"], string> = {
    idea: "灵感",
    draft: "草案",
    refined: "细化",
    tested: "已试跑",
    locked: "锁定",
  };
  let s = `【${lv[node.level]}·${st[node.status]}】${node.title || "（未命名）"}`;
  if (node.intent) s += `\n  意图：${node.intent}`;
  if (opts.withBeats && node.beats.length) s += `\n  节拍：\n  ${beatsToLines(node.beats).split("\n").join("\n  ")}`;
  return s;
}

// ---------- M2 构思访谈 ----------

export interface InterviewTurn {
  /** 面向作者的自然回复 */
  reply: string;
  /** 对档案字段的提案更新（用户确认后才落库） */
  updates: { key: string; value: string; status: "rough" | "confirmed"; note: string }[];
  /** 本轮结尾要抛给作者的下一个问题 */
  askNext: { key: string; question: string };
}

/** 访谈系统提示词：角色 + 规则 + 字段表现状（含 stale 语义） */
export function interviewSystemPrompt(fields: BibleField[]): string {
  const empties = fields.filter((f) => f.status === "empty");
  return [
    "你是一位资深小说编辑兼创作伙伴，正在通过轻松对话帮作者填写「构思档案」。",
    "规则：",
    "1. 每轮只聚焦一个最要紧的字段（优先级：空缺>粗略>待复查；空缺字段按档案顺序从前往后）。",
    "2. 提问要具体：给 2~3 个有画面感的示例方向，允许作者一句话回答或长篇大论，绝不审问。",
    "3. 作者闲谈或倾倒灵感时，先自然回应，再把可提炼的内容整理为字段更新提案；作者明说\"就这样\"才标 confirmed。",
    "4. 字段间有依赖（deps）：上游字段变更后，下游被标 stale 的字段要在后续对话中温和复查。",
    "5. 每轮都必须输出一个 JSON（除此之外不要输出任何其他文字）：",
    '{"reply":"给作者的自然回复(含下一个问题)","updates":[{"key":"字段键","value":"新内容","status":"rough或confirmed","note":"为什么更新"}],"askNext":{"key":"下一问的字段键","question":"问题原文"}}',
    "6. 没有值得更新的字段就 updates:[]。askNext.key 必须取自字段表。",
    "",
    "当前构思档案：",
    fieldsMarkdown(fields),
    empties.length
      ? ""
      : "（提示：档案已全部有内容，本轮起以细化、复查 stale 字段与发散讨论为主。）",
  ].join("\n");
}

export function interviewUserTurn(text: string): ChatMessage {
  return { role: "user", content: text };
}

// ---------- M3 总纲与大纲树 ----------

export type OutlineStructure = "three-act" | "kishotenketsu" | "hero";

export const STRUCTURE_NAMES: Record<OutlineStructure, string> = {
  "three-act": "三幕式（建置-对抗-解决）",
  kishotenketsu: "起承转合",
  hero: "英雄之旅（12 阶段简化为 6 站）",
};

/** 总纲输出的 JSON 规格（masterOutlinePrompt 与解析端共用的字面量） */
export const MASTER_OUTLINE_SPEC =
  '{"logline":"一句话主线","volumes":[{"title":"卷名","intent":"本卷叙事目的与结构位置","chapters":[{"title":"章名","intent":"本章要完成什么","scenes":[{"title":"幕名","intent":"这一幕的戏剧目标","location":"地点","timepoint":"故事内时间","cast":["出场角色名"],"beats":["节拍1：谁做了什么、造成什么局面","节拍2…"]}]}]}]}';

export function masterOutlinePrompt(
  fields: BibleField[],
  opts: { structure: OutlineStructure; volumeCount?: number; hint?: string } = { structure: "three-act" },
): ChatMessage[] {
  const vol = opts.volumeCount ? `卷数控制在 ${opts.volumeCount} 卷左右。` : "卷数自行判断，以叙事节奏为准。";
  return [
    {
      role: "system",
      content: [
        "你是一位小说结构编辑，擅长把松散构思落成可执行的总纲。",
        `采用结构骨架：${STRUCTURE_NAMES[opts.structure]}。`,
        vol,
        "幕（scene）是 RP 试跑的最小单位：每幕必须是单一时空、可直接开演的戏剧场面，3~8 个节拍。",
        "节拍要具体到\"谁做了什么、改变了什么局面\"，禁止用\"两人感情升温\"这类无动作表述。",
        "伏笔意识：在 intent 中点明埋设/回收。",
        `只输出 JSON（不要任何解释），结构：${MASTER_OUTLINE_SPEC}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: ["构思档案：", fieldsMarkdown(fields), opts.hint ? `作者补充要求：${opts.hint}` : "", "", "请产出总纲。"].join("\n"),
    },
  ];
}

/** 讨论/细化某个节点的草案（任意层级通用） */
// ---------- 大纲共创访谈：一边访谈一边搭大纲（粗放，只定盘子） ----------

/** 共创访谈的每轮 JSON 规格：回复 + 阶段 + 全量大纲草稿（形态同总纲，beats 恒空） */
export const OUTLINE_COACH_SPEC =
  '{"reply":"本轮自然回复（含下一个问题）","phase":"direction|structure|scenes|ready","ready":true或false,"draft":' +
  MASTER_OUTLINE_SPEC +
  "}";

/**
 * 共创访谈系统提示词：每轮重建（内嵌最新草稿），对话历史按普通消息携带。
 * 粗放纪律：只谈整体大纲/剧情走向/细纲题目，节拍明确不在此产出。
 */
export function outlineCoachPrompt(
  fields: BibleField[],
  draft: MasterOutlineJson | null,
  facts?: string,
): string {
  return [
    "你是一位资深小说结构顾问，正通过轻松对话与作者一起搭建大纲：每轮问一个问题，同时更新大纲草稿。",
    "访谈纪律（粗放）：只谈三类大事——整体大纲（卷数与结构里程碑）、剧情走向（给出 2~3 个带冲突与代价的方向供作者挑选或混合）、细纲题目（章与幕的标题＋一句话戏剧目标）。",
    "严禁询问细枝末节：天气、服饰、配角、道具细节、场面内具体过程都不问——那些属于节拍与试跑阶段。",
    "每轮只问一个问题，具体、有画面感；作者一句话就采纳进草稿，作者跑题先自然接话再把可取处提炼进草稿；走向分歧时给选项而不是审问。",
    "草稿演进顺序：先搭卷框架（phase=direction）→ 定走向与关键转折（phase=structure）→ 逐卷列幕标题与目标（phase=scenes）；当每幕都有标题与 intent 时置 phase=ready、ready=true。",
    "draft 始终输出全量（形态同总纲），但 beats 一律留空数组——节拍由后续的细纲填充单独完成，你不得抢跑。",
    "cast 只列构思档案或人物库里已有的名字（如有），不确定就留空，不发明人名。",
    "当 phase=ready：在 reply 里告诉作者后续三条路——应用到大纲树 / 让 AI 填充细纲 / 直接导出为剧情推进世界书。",
    "每轮必须只输出这个 JSON（除此之外没有任何文字）：",
    OUTLINE_COACH_SPEC,
    "",
    "构思档案（访谈须以此为基础，不推翻作者已确认的设定）：",
    fieldsMarkdown(fields),
    ...(facts && facts.trim()
      ? ["", "已确认事实与欠账（硬约束：新剧情不得与之矛盾，欠账要留意回收）：", facts.trim()]
      : []),
    "",
    "当前大纲草稿（null=尚未开搭；本轮请基于档案给出初稿并以一个问题开场）：",
    draft ? JSON.stringify(draft) : "null",
  ].join("\n");
}

/** 细纲填充：为树上已有题目/目标的空幕生成 3~8 个节拍 */
export function sceneBeatsPrompt(
  scene: OutlineNode,
  ancestors: OutlineNode[],
  prevScene: OutlineNode | null,
  fields: BibleField[],
): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是细纲编辑。作者已定下这一幕的标题与戏剧目标，你的任务是填 3~8 个节拍。",
        "节拍必须具体到「谁做了什么、改变了什么局面」，禁止「感情升温」式状态描述；埋设/回收伏笔用（埋：…）/（收：…）内联标注。",
        "上一幕的结尾如何接本幕的开局要在第一个节拍里体现；最后一拍留 RP 即兴空间（开决策点），不写死结局。",
        '只输出 JSON：{"beats":["节拍1","节拍2",…]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "构思档案：",
        fieldsMarkdown(fields, 200),
        "",
        prevScene ? `上一幕：\n${nodeDigest(prevScene, { withBeats: true })}` : "上一幕：无（本作开场幕）",
        "",
        `待填充的幕（路径：${ancestors.map((a) => a.title).join(" › ") || "未挂载"}）：`,
        nodeDigest(scene),
      ].join("\n"),
    },
  ];
}

export function nodeDiscussPrompt(node: OutlineNode, ancestors: OutlineNode[], fields: BibleField[]): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "你是小说结构编辑，正与作者逐节点打磨大纲。",
        "职责：指出该节点目标模糊/缺冲突/节拍无动作之处，并给出改进后的完整草案。",
        "只输出 JSON：",
        '{"comment":"一段点评与建议(150字内)","node":{"title":"标题","intent":"叙事目的","beats":["节拍…"]},"foreshadows":[{"setup":"伏笔内容","payoffIn":"预期在何处回收"}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "档案：",
        fieldsMarkdown(fields),
        "上级脉络：",
        ancestors.map((a) => nodeDigest(a)).join("\n"),
        "待细化节点：",
        nodeDigest(node, { withBeats: true }),
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

/** 按总纲与已写进度，提案下一幕（顺纲扩张） */
export function nextScenePrompt(
  spine: OutlineNode[],
  doneScenes: OutlineNode[],
  fields: BibleField[],
  ledger?: LedgerRecord[],
  /** 预生成的台账快照+伏笔欠账文本（flow/snapshot.ledgerFacts）；缺省时退回台账粗格式 */
  facts?: string,
): ChatMessage[] {
  const confirmed = (ledger ?? []).filter((r) => r.status === "confirmed");
  const factsBlock =
    facts && facts.trim()
      ? facts.trim()
      : confirmed.length
        ? "正典台账（已确认事实）：\n" + confirmed.map((r) => `- [${r.type}] ${r.content}`).join("\n")
        : "";
  return [
    {
      role: "system",
      content: [
        "你是小说结构编辑。根据总纲、已上演进度与正典台账，提案「下一幕」。",
        "下一幕必须推进主线且尊重已确认事实（台账），不得与伏笔冲突。",
        `只输出 JSON（形态同总纲中的一幕）：{"scene":{"title":"","intent":"","location":"","timepoint":"","cast":[],"beats":[]}}`,
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        "档案：",
        fieldsMarkdown(fields),
        "总纲骨架：",
        spine.map((n) => nodeDigest(n)).join("\n") || "（尚无总纲）",
        "已上演（按序）：",
        doneScenes.map((n) => nodeDigest(n, { withBeats: true })).join("\n") || "（还没有演过的幕）",
        factsBlock,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// ---------- M4 过渡试跑闭环（导出到 ST / 导回回写） ----------

export interface TrialContext {
  scene: OutlineNode;
  chapter?: OutlineNode;
  castNames: string[];
  userName: string;
  prevSummary?: string; // 上一幕实际发生摘要
  loreBlock?: string; // 世界书注入块（由匹配引擎/全量导出拼成）
  userPersona?: string; // 用户画像块（personaPromptBlock 拼成，可空）
}

/** 用户画像 → 注入文本块（试跑/画像预览共用） */
export function personaPromptBlock(p: Pick<Persona, "name" | "description" | "appearance" | "personality" | "notes">): string {
  return [
    `名字：${p.name}`,
    p.description ? `身份/背景：${p.description}` : "",
    p.appearance ? `外貌：${p.appearance}` : "",
    p.personality ? `性格：${p.personality}` : "",
    p.notes ? `备注：${p.notes}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** ST 角色卡 greeting 位：把这一幕的戏剧目标做成开场指令+开场文 */
export function trialGreeting(ctx: TrialContext): string {
  const { scene, chapter, castNames, userName, prevSummary, loreBlock, userPersona } = ctx;
  return [
    "【试跑指导】",
    `本场戏：${scene.title}`,
    scene.intent ? `戏剧目标：${scene.intent}` : "",
    prevSummary ? `前情实际走向：${prevSummary}` : "",
    castNames.length ? `出场人物：${castNames.join("、")}` : "",
    userPersona ? `玩家形象（{{user}}＝${userName}）：\n${userPersona}` : "",
    scene.beats.length ? `期望节拍（按序推进，可自然放缓但勿跳过核心）：\n${beatsToLines(scene.beats)}` : "",
    "开场：从第一拍之前的情境自然起笔，勿复述以上内容。",
    loreBlock ? `\n【世界设定摘录】\n${loreBlock}` : "",
    "",
    `（${chapter ? chapter.title + " · " : ""}${scene.title}｜扮演除 ${userName} 以外的全部角色与旁白）`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** ST author's note 位：末位强提醒（短！） */
export function trialAuthorNote(ctx: TrialContext, maxChars = 300): string {
  const next = ctx.scene.beats.find((b) => !b.done);
  const base = [
    `本场目标：${ctx.scene.intent || ctx.scene.title}`,
    next ? `当前待演节拍：${next.text}` : "收尾节拍：把本场戏剧目标落定",
    "保持世界书设定与人物口吻，勿替 {{user}} 行动。",
  ].join("；");
  return base.length > maxChars ? base.slice(0, maxChars - 1) + "…" : base;
}

/** 导入包 README：给作者看的操作指引；noCard=本包为大纲自动合成的「旁白卡」 */
export function trialPackReadme(packName: string, opts: { noCard?: boolean } = {}): string {
  return [
    `# 试跑包：${packName}`,
    "",
    "在 SillyTavern 中的操作：",
    opts.noCard
      ? "1. 导入角色卡 card.json —— 这是由大纲自动合成的「旁白卡」（无预设角色，适合原创小说试跑），greeting 已带全场指导"
      : "1. 导入角色卡（含世界书：卡内嵌 world info，或在世界书面板导入 lorebook.json）",
    "2. 角色卡 greeting 已写好「试跑指导」，直接开聊即从本场情境开场",
    "3. 建议开启 author's note（note-depth 1），粘贴 readme 附带的 note.txt 内容",
    "4. 演完这一幕后导出聊天记录（Character ▸ export chat .jsonl），带回 Story Studio「导入试跑记录」",
    "",
    "提示：试跑允许跑偏。跑偏不是错误——导回后系统会比对节拍，由你裁决改纲还是纠偏。",
  ].join("\n");
}

/** 导回后的统一分析（一幕）：实际走向摘要 + 节拍比对 + 偏差 + 台账提案，一次调用 */
export function sessionRecapPrompt(
  transcriptText: string,
  scene: OutlineNode,
  opts: { maxTranscriptChars?: number } = {},
): ChatMessage[] {
  const cap = opts.maxTranscriptChars ?? 12000;
  const text = transcriptText.length > cap ? transcriptText.slice(0, cap) + "\n……（截断）" : transcriptText;
  return [
    {
      role: "system",
      content: [
        "你是剧本统筹。比对「期望节拍」与「实际演出记录」，输出结构化结论。",
        "判定从严：只有实际演出明确呈现了该拍的动作与后果才算 hit。",
        "台账提案只收有演出依据的事实，宁缺毋滥；道具/承诺/信息差/伤势都要收。",
        "只输出 JSON：",
        '{"summary":"实际走向摘要(200字内，以已发生事实口吻)","beatStatus":[{"beat":"原节拍文本","status":"hit|partial|missed","evidence":"对应演出要点"}],"divergences":[{"desc":"偏了哪里","severity":"minor|major","suggestion":"update_outline|steer|accept"}],"proposals":[{"type":"event|item|relation|foreshadow|worldstate","content":"事实陈述","actors":["名"]}]}',
      ].join("\n"),
    },
    {
      role: "user",
      content: [
        `本场：${scene.title}`,
        scene.intent ? `戏剧目标：${scene.intent}` : "",
        "期望节拍：",
        beatsToLines(scene.beats) || "（无预设节拍，纯自由试跑：beatStatus 给 []，总结实际发生即可）",
        "",
        "实际演出记录：",
        text,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}

// ---------- M5 自建 RP 引擎（先备好系统提示，引擎稍后接） ----------

export interface RpSystemOpts {
  userName: string;
  charNames: string[];
  styleInstructions: string; // 文风/POV/时态/尺度约束
}

export function rpSystemPrompt(opts: RpSystemOpts): string {
  return [
    `你扮演 ${opts.charNames.join(" 与 ")} 以及全部配角与旁白；用户扮演 ${opts.userName}。`,
    "永远不替用户角色说话、行动或做决定；一次回复聚焦当前场面，推进但不抢节拍。",
    "保持各角色口吻、知情范围（角色不知道的事不能引用）与世界书设定一致。",
    opts.styleInstructions,
    "输出：小说式叙事+对白，长度跟随场面张力；不要输出 OOC 说明，除非用户以 OOC 起头。",
  ].join("\n");
}
