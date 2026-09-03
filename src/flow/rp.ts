// ============================================================
// story-studio M5 — 站内试跑 RP 提示词组装器（纯逻辑，ST 默认标准）
// 目标：不导出 SillyTavern，也能在本机按「ST 默认标准」直接与模型对话试跑。
//
// 与 st/matcher.ts 一致：纯函数、无副作用、除 import type 外零运行时依赖
// （estimateTokens 由 ai/tokenizer 提供，matchLore 由 st/matcher 提供，皆纯）。
//
// ST 默认标准要点（本模块忠实复刻其 chat-completion 组装）：
//   1. system 提示词 = 角色扮演主指令 → 世界书(before_char) → 角色卡正文
//      （人物设定/性格/场景）→ {{user}} 画像 → 对话范例 → 世界书(after_char)
//      → 作者注释(author's note，最高优先，置尾)；
//   2. {{char}} / {{user}} 宏全局替换（大小写不敏感）；
//   3. 历史映射 char→assistant、user→user、system→system；greeting 为首条 assistant；
//   4. 世界书每轮按当前聊天重扫（matchLore：扫描深度/主副键/递归/概率/预算/前后位）。
// ============================================================

import type { ChatMessage, LoreEntry, LorebookSettings } from "../core/types";
import { matchLore, type MatchedEntry } from "../st/matcher.js";
import { estimateTokens } from "../ai/tokenizer.js";

/** 一次 RP 会话的静态装配（不随轮次变化；世界书随轮次重扫除外） */
export interface RpSetup {
  charName: string; // {{char}}
  userName: string; // {{user}}
  /** 角色卡正文（含外貌/背景，调用方拼好）；无卡模式为旁白卡 description */
  description: string;
  personality?: string;
  scenario?: string;
  /** 对话范例（few-shot，仅供口吻参考） */
  exampleDialogue?: string;
  /** 玩家画像块（personaPromptBlock 产物，可空） */
  personaBlock?: string;
  /** 作者注释（trialAuthorNote 产物，置尾、高优先） */
  authorNote?: string;
  /** 额外主指令（如「本幕戏剧目标」提示），插在主指令之后 */
  systemExtra?: string;
  loreEntries: LoreEntry[]; // 已启用的世界书词条
  loreSettings: LorebookSettings; // 扫描深度 / 预算 / 递归
}

/** 会话轮次：char 由模型产出、user 由用户输入、system 为旁路系统条 */
export interface RpTurn {
  role: "user" | "char" | "system";
  name: string;
  content: string;
}

export interface RpMessagesResult {
  messages: ChatMessage[];
  injected: MatchedEntry[]; // 本轮实际注入的世界书（UI 可提示「本回合命中 N 条」）
  dropped: MatchedEntry[]; // 超预算被裁
  usedTokens: number;
}

/** ST 默认宏：{{char}} / {{user}} 全局替换（大小写不敏感，容忍内部空格） */
export function applyMacros(text: string, char: string, user: string): string {
  return (text ?? "")
    .replace(/\{\{\s*char\s*\}\}/gi, char)
    .replace(/\{\{\s*user\s*\}\}/gi, user);
}

/** 角色扮演主指令（ST 默认主提示词的创作向中文标准版） */
const ST_DEFAULT_DIRECTIVE = [
  "（这是一个虚构的文学角色扮演。你扮演 {{char}}，以及除 {{user}} 之外的所有角色与旁白；用户扮演 {{user}}。）",
  "- 只书写 {{char}} 与旁人的台词、动作、心理与环境反应；绝不替 {{user}} 发言、行动或做决定，不在回复中代用户推进。",
  "- 严格遵守下方人物设定、场景与世界书，保持人物口吻一致，不复述设定、不堆砌套话。",
  "- 以文学小说笔法叙述（第三人称，或贴合角色卡语气）；主动制造张力、推进冲突，同时为 {{user}} 留出回应空间。",
  "- 每轮只书写剧情正文；不输出解释、元指令、OOC 旁白或对规则的复述。",
].join("\n");

function nonEmpty(s: string | undefined): boolean {
  return !!s && s.trim().length > 0;
}

/**
 * 组装 ST 默认标准的 system 提示词。loreBefore / loreAfter 是本轮世界书命中
 * （before_char / after_char 两段正文），由 rpMessages 传入。
 */
export function rpSystemPrompt(setup: RpSetup, loreBefore = "", loreAfter = ""): string {
  const { charName, userName } = setup;
  const blocks: string[] = [applyMacros(ST_DEFAULT_DIRECTIVE, charName, userName)];

  if (nonEmpty(setup.systemExtra)) blocks.push(setup.systemExtra!.trim());
  if (nonEmpty(loreBefore)) blocks.push(`【世界书·背景】\n${loreBefore.trim()}`);

  const card: string[] = [`你是 ${charName}。`];
  if (nonEmpty(setup.description)) card.push(`【人物设定】\n${setup.description!.trim()}`);
  if (nonEmpty(setup.personality)) card.push(`【性格】\n${setup.personality!.trim()}`);
  if (nonEmpty(setup.scenario)) card.push(`【当前场景】\n${setup.scenario!.trim()}`);
  blocks.push(applyMacros(card.join("\n\n"), charName, userName));

  if (nonEmpty(setup.personaBlock)) {
    blocks.push(applyMacros(`【{{user}}（由用户扮演）】\n${setup.personaBlock!.trim()}`, charName, userName));
  }
  if (nonEmpty(setup.exampleDialogue)) {
    blocks.push(applyMacros(`【对话范例｜仅供口吻与格式参考，禁止逐字复述或续写范例】\n${setup.exampleDialogue!.trim()}`, charName, userName));
  }
  if (nonEmpty(loreAfter)) blocks.push(`【世界书·补充】\n${loreAfter.trim()}`);
  if (nonEmpty(setup.authorNote)) {
    blocks.push(applyMacros(`【作者注释｜优先级最高，但不得违反以上规则与人物设定】\n${setup.authorNote!.trim()}`, charName, userName));
  }

  return blocks.filter(Boolean).join("\n\n");
}

/**
 * 把「静态装配 + 当前轮次历史」组装为发给模型的 ChatMessage[]：
 * 本轮先按聊天历史重扫世界书（matchLore），命中词条并入 system；历史 char→assistant。
 * depthOverride 可临时改扫描深度（默认用 setup.loreSettings.scanDepth）。
 */
export function rpMessages(
  setup: RpSetup,
  turns: RpTurn[],
  opts: { depthOverride?: number; random?: () => number } = {},
): RpMessagesResult {
  const scanHistory = turns
    .filter((t) => t.role !== "system")
    .map((t) => ({ name: t.name, content: t.content }));
  const match = matchLore(
    setup.loreEntries,
    setup.loreSettings,
    { history: scanHistory, depthOverride: opts.depthOverride, random: opts.random },
    estimateTokens,
  );
  const loreBefore = match.before.map((m) => m.entry.content).join("\n");
  const loreAfter = match.after.map((m) => m.entry.content).join("\n");

  const messages: ChatMessage[] = [{ role: "system", content: rpSystemPrompt(setup, loreBefore, loreAfter) }];
  for (const t of turns) {
    if (t.role === "system") {
      messages.push({ role: "system", content: t.content });
    } else {
      messages.push({ role: t.role === "user" ? "user" : "assistant", content: t.content });
    }
  }
  return { messages, injected: match.injected, dropped: match.dropped, usedTokens: match.usedTokens };
}
