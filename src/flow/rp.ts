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
  /** 台账快照+伏笔欠账（flow/snapshot.ledgerFacts 产物，可空；N2 组装管线注入） */
  ledgerBlock?: string;
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

/** system 提示词分段（组装序）。priority=∞ 永不裁；有限值小者先裁。 */
export interface RpSystemSection {
  key: "roleDirective" | "extra" | "loreBefore" | "card" | "persona" | "ledger" | "examples" | "loreAfter" | "authorNote";
  label: string;
  text: string;
  priority: number;
}

const NEVER = Number.POSITIVE_INFINITY;

/**
 * 把静态装配拆成分段（N2 预算管线需要逐段计 token/取舍）。
 * 段序=原 system 组装序；ledgerBlock 插在画像之后。
 */
export function rpSystemSections(setup: RpSetup, loreBefore = "", loreAfter = ""): RpSystemSection[] {
  const { charName, userName } = setup;
  const sections: RpSystemSection[] = [];
  sections.push({
    key: "roleDirective",
    label: "角色扮演主指令",
    text: applyMacros(ST_DEFAULT_DIRECTIVE, charName, userName),
    priority: NEVER,
  });

  if (nonEmpty(setup.systemExtra)) sections.push({ key: "extra", label: "本幕指引", text: setup.systemExtra!.trim(), priority: NEVER });
  if (nonEmpty(loreBefore)) sections.push({ key: "loreBefore", label: "世界书·背景", text: `【世界书·背景】\n${loreBefore.trim()}`, priority: 10 });

  const card: string[] = [`你是 ${charName}。`];
  if (nonEmpty(setup.description)) card.push(`【人物设定】\n${setup.description!.trim()}`);
  if (nonEmpty(setup.personality)) card.push(`【性格】\n${setup.personality!.trim()}`);
  if (nonEmpty(setup.scenario)) card.push(`【当前场景】\n${setup.scenario!.trim()}`);
  sections.push({ key: "card", label: "角色卡", text: applyMacros(card.join("\n\n"), charName, userName), priority: NEVER });

  if (nonEmpty(setup.personaBlock)) {
    sections.push({ key: "persona", label: "用户画像", text: applyMacros(`【{{user}}（由用户扮演）】\n${setup.personaBlock!.trim()}`, charName, userName), priority: 30 });
  }
  if (nonEmpty(setup.ledgerBlock)) {
    sections.push({ key: "ledger", label: "台账快照", text: `【台账快照·正典事实】\n${setup.ledgerBlock!.trim()}`, priority: 40 });
  }
  if (nonEmpty(setup.exampleDialogue)) {
    sections.push({ key: "examples", label: "对话范例", text: applyMacros(`【对话范例｜仅供口吻与格式参考，禁止逐字复述或续写范例】\n${setup.exampleDialogue!.trim()}`, charName, userName), priority: 5 });
  }
  if (nonEmpty(loreAfter)) sections.push({ key: "loreAfter", label: "世界书·补充", text: `【世界书·补充】\n${loreAfter.trim()}`, priority: 15 });
  if (nonEmpty(setup.authorNote)) {
    sections.push({ key: "authorNote", label: "作者注释", text: applyMacros(`【作者注释｜优先级最高，但不得违反以上规则与人物设定】\n${setup.authorNote!.trim()}`, charName, userName), priority: NEVER });
  }
  return sections;
}

/**
 * 组装 ST 默认标准的 system 提示词。loreBefore / loreAfter 是本轮世界书命中
 * （before_char / after_char 两段正文），由 rpMessages 传入。
 */
export function rpSystemPrompt(setup: RpSetup, loreBefore = "", loreAfter = ""): string {
  return rpSystemSections(setup, loreBefore, loreAfter)
    .map((s) => s.text)
    .join("\n\n");
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

// ============================================================
// N2 组装管线 v2：优先级预算队列 + 前情摘要 + 分段 token 预览
// ============================================================

/** 预算管线的一节（UI 预览条直接渲染） */
export interface RpPlanSection {
  key: string; // system 段 key / "summary" / "history"
  label: string;
  tokens: number; // 估算 token（kept 的计入总量）
  kept: boolean;
  note?: string; // 被裁原因 / 补充说明
}

export interface RpAssembleOptions {
  budgetTokens?: number; // 上下文总预算（默认 8192）
  reserveTokens?: number; // 预留给回复（默认 768）
  keepTurns?: number; // 至少保留的最近消息数（默认 6）
  summary?: string; // 滚动摘要（前情，永不裁剪）
  depthOverride?: number;
  random?: () => number;
}

export interface RpAssembly {
  messages: ChatMessage[];
  sections: RpPlanSection[]; // 预览条：system 各段 + 摘要 + 历史
  injected: MatchedEntry[];
  dropped: MatchedEntry[]; // 世界书预算被裁
  totalTokens: number; // 实际发出的估算总 token（system+摘要+保留历史）
  droppedTurns: number; // 因超预算被裁的历史消息数
  overflow: boolean; // 裁无可裁仍超预算（照发，UI 应警示）
}

/**
 * 预算队列（超预算时从低优先级先裁，与 ST 的上下文管理同构）：
 *   裁序：对话范例(5) → 世界书·背景(10) → 世界书·补充(15) → 用户画像(30) → 台账快照(40)
 *         → 历史（只裁 keepTurns 之外的旧消息，从最旧起）
 *   永裁不动：主指令 / 本幕指引 / 角色卡 / 作者注释 / 前情摘要（它就是记忆本体）。
 * 同优先级先裁大的（腾预算最见效）。
 */
export function rpAssemble(
  setup: RpSetup,
  turns: RpTurn[],
  opts: RpAssembleOptions = {},
): RpAssembly {
  const budget = opts.budgetTokens && opts.budgetTokens > 0 ? opts.budgetTokens : 8192;
  const reserve = opts.reserveTokens && opts.reserveTokens >= 0 ? opts.reserveTokens : 768;
  const keep = Math.max(1, Math.floor(opts.keepTurns ?? 6));

  const scanHistory = turns.filter((t) => t.role !== "system").map((t) => ({ name: t.name, content: t.content }));
  const match = matchLore(setup.loreEntries, setup.loreSettings, { history: scanHistory, depthOverride: opts.depthOverride, random: opts.random }, estimateTokens);
  const loreBefore = match.before.map((m) => m.entry.content).join("\n");
  const loreAfter = match.after.map((m) => m.entry.content).join("\n");

  const sysSecs = rpSystemSections(setup, loreBefore, loreAfter);
  const sysSections = sysSecs.map<RpPlanSection>((s) => ({
    key: s.key,
    label: s.label,
    tokens: estimateTokens(s.text),
    kept: true,
    note: s.priority === NEVER ? "保护段·不裁" : undefined,
  }));
  const prio = new Map<string, number>(sysSecs.map((s) => [s.key, s.priority]));

  const summaryText = nonEmpty(opts.summary) ? `【前情摘要】以下是此前剧情的压缩记录（正典级参考，不得与之矛盾）：\n${opts.summary!.trim()}` : "";
  const summarySection: RpPlanSection | null = summaryText
    ? { key: "summary", label: "前情摘要", tokens: estimateTokens(summaryText), kept: true, note: "保护段·不裁" }
    : null;

  // 历史映射（char→assistant）；token 逐条计
  const histMsgs = turns.map<RpPlanSection & { msg: ChatMessage }>((t) => ({
    key: "history",
    label: `${t.role === "user" ? "user" : t.role === "char" ? "assistant" : "system"}:${t.name}`,
    tokens: estimateTokens(t.content),
    kept: true,
    msg: { role: t.role === "user" ? "user" : t.role === "char" ? "assistant" : "system", content: t.content },
  }));

  const total = () =>
    sysSections.reduce((n, s) => n + (s.kept ? s.tokens : 0), 0) +
    (summarySection?.tokens ?? 0) +
    histMsgs.reduce((n, s) => n + (s.kept ? s.tokens : 0), 0);

  const available = budget - reserve;

  // ① 裁 system 可裁段（低优先级优先；同级裁大的）
  while (total() > available) {
    const candidates = sysSections
      .filter((s) => s.kept && (prio.get(s.key) ?? NEVER) !== NEVER)
      .sort((a, b) => (prio.get(a.key)! - prio.get(b.key)!) || b.tokens - a.tokens);
    if (candidates.length === 0) break;
    candidates[0].kept = false;
    candidates[0].note = "已裁：超预算，低优先级";
  }

  // ② 还不够：从最旧开始裁历史，保 keepTurns 条兜底
  let droppedTurns = 0;
  let guard = histMsgs.length; // Infinity 预算的防御性上限（理论上不触达）
  while (total() > available && guard-- > 0) {
    const droppable = histMsgs.filter((s) => s.kept);
    if (droppable.length <= keep) break;
    droppable[0].kept = false;
    droppedTurns++;
  }

  const overflow = total() > available;
  const keptMsgs = histMsgs.filter((s) => s.kept);
  if (droppedTurns > 0) {
    // 在被裁最旧的位置挂一条说明（历史条以首条呈现"已裁 N 条"）
    keptMsgs[0] = { ...keptMsgs[0], note: `更早 ${droppedTurns} 条已裁（滚动摘要兜底）` };
  }

  const messages: ChatMessage[] = [];
  const keptKeys = new Set(sysSections.filter((s) => s.kept).map((s) => s.key));
  const sysBody = sysSecs
    .filter((s) => keptKeys.has(s.key))
    .map((s) => s.text)
    .join("\n\n");
  messages.push({ role: "system", content: sysBody });
  if (summarySection && summaryText) messages.push({ role: "system", content: summaryText });
  for (const s of keptMsgs) messages.push(s.msg);

  const sections: RpPlanSection[] = [...sysSections];
  if (summarySection) sections.push(summarySection);
  const histTokens = histMsgs.reduce((n, s) => n + (s.kept ? s.tokens : 0), 0);
  sections.push({
    key: "history",
    label: `历史消息（${keptMsgs.length}/${histMsgs.length} 条）`,
    tokens: histTokens,
    kept: true,
    note: droppedTurns > 0 ? `已裁旧消息 ${droppedTurns} 条` : undefined,
  });

  return {
    messages,
    sections,
    injected: match.injected,
    dropped: match.dropped,
    totalTokens: total(),
    droppedTurns,
    overflow,
  };
}

// ---------- 滚动摘要规划（纯逻辑：决定"哪些旧回合该折进摘要"） ----------

export interface RollPlan {
  rollup: RpTurn[]; // 要折叠进摘要的旧回合（含开场白）
  keep: RpTurn[]; // 保留原文的最近回合
}

/**
 * 当 keepTurns 之外的旧历史 token 超过 thresholdTokens 时，规划一次折叠。
 * 未达阈值 / 可折叠内容为空 → null（什么都不用做）。
 */
export function planRollingSummary(
  turns: RpTurn[],
  opts: { thresholdTokens: number; keepTurns: number },
): RollPlan | null {
  const keepN = Math.max(1, Math.floor(opts.keepTurns));
  if (turns.length <= keepN) return null;
  const rollup = turns.slice(0, turns.length - keepN);
  const keep = turns.slice(turns.length - keepN);
  // 折叠段须以 assistant 收尾才安全（保持 user/assistant 交替干净）
  let roll = rollup;
  let kept = keep;
  while (roll.length > 0 && roll[roll.length - 1].role !== "char") {
    kept = [roll[roll.length - 1], ...kept];
    roll = roll.slice(0, -1);
  }
  if (roll.length === 0) return null;
  const tokens = estimateTokens(turnsTranscript(roll));
  if (tokens <= opts.thresholdTokens) return null;
  return { rollup: roll, keep: kept };
}

/** 回合列表 → 转写文本（摘要/复盘共用；system 条跳过） */
export function turnsTranscript(turns: RpTurn[]): string {
  return turns
    .filter((t) => t.role !== "system" && t.content.trim())
    .map((t) => `${t.name}：${t.content.trim()}`)
    .join("\n\n");
}

/**
 * 作者注释装配：base（试跑包 AN）+ 纠偏指令列表（最新在后）。
 * N3「注入纠偏继续演」的纯逻辑核：调用方持有列表（限流如 slice(-3)），每次重建全量 AN，
 * 不留字符串考古问题。
 */
export function composeAuthorNote(base: string | undefined, directives: string[]): string {
  return [base?.trim() ?? "", ...directives.map((d) => (d.trim() ? `【纠偏】${d.trim()}` : ""))]
    .filter(Boolean)
    .join("\n\n");
}
