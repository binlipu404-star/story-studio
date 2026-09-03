// ============================================================
// story-studio M4 — SillyTavern 聊天记录导入解析（纯逻辑）
// 宽容接受三种外部形态，产出统一的 ParsedChatMessage 序列：
//   1) .jsonl 逐行 JSON（ST 主流导出）：首行常为 chat_metadata（跳过）；
//      消息字段 {name, mes, is_user, is_system?, swipes?, swipe_id?}；
//      mes 空白时取 swipes[swipe_id ?? 0]；坏行静默跳过、好行保留，绝不抛异常。
//   2) 单对象 {messages:[...]}（整包聊天 JSON）。
//   3) 顶层数组 [...]。
// 运行时零依赖：本文件不 import 任何模块（ParsedChatMessage 自带契约；
// role 三态与 core/types 的 RPMessage.role 逐字一致，UI 层直接映射）。
// 语义约定：
//   - 顶层含 chat_metadata 或 user_name 键的条目一律跳过（元数据行）。
//   - is_system 真值 或 name==="System" → role "system"（isUser 强制 false）；
//     其余 is_user 真值 → "user"，否则 "char"。
//   - 布尔宽容：boolean 原样；数字非 0 为真；字符串 "true"/"1" 为真。
//   - mes 与 swipes 兜底后仍无内容（含纯空白）→ 视为坏消息跳过；
//     swipe_id 越界等价于取不到内容。
//   - name 缺失时按角色兜底："System" / "用户" / "角色"（保证转写行可读）。
//   - fileName 为咨询性提示：以 .jsonl 结尾时优先采信逐行解析结果。
// ============================================================

export interface ParsedChatMessage {
  name: string;
  content: string;
  isUser: boolean;
  role: "user" | "char" | "system";
}

type UnknownDict = Record<string, unknown>;

function isRecord(v: unknown): v is UnknownDict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
}

/** 宽容布尔：boolean 原样；有限数字非 0 为真；字符串 "true"/"1"（不分大小写）为真 */
function truthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) && v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1";
  }
  return false;
}

/** 单条消息规范化；返回 null = 元数据行 / 非对象 / 无有效内容，调用方跳过 */
function normMsg(item: unknown): ParsedChatMessage | null {
  if (!isRecord(item)) return null;
  if ("chat_metadata" in item || "user_name" in item) return null;
  let content = str(item.mes);
  if (!content.trim() && Array.isArray(item.swipes)) {
    const idx =
      typeof item.swipe_id === "number" && Number.isInteger(item.swipe_id) ? item.swipe_id : 0;
    const swipe = (item.swipes as unknown[])[idx];
    if (typeof swipe === "string") content = swipe;
  }
  if (!content.trim()) return null;
  const isSystem = truthy(item.is_system) || str(item.name).trim() === "System";
  const isUser = !isSystem && truthy(item.is_user);
  const role: ParsedChatMessage["role"] = isSystem ? "system" : isUser ? "user" : "char";
  const name = str(item.name).trim() || (isSystem ? "System" : isUser ? "用户" : "角色");
  return { name, content, isUser, role };
}

function normList(list: unknown[]): ParsedChatMessage[] {
  const out: ParsedChatMessage[] = [];
  for (const item of list) {
    const m = normMsg(item);
    if (m) out.push(m);
  }
  return out;
}

/** 整体形态：顶层数组 或 {messages:[...]}；返回 null = 本文本不是可识别的整体形态 */
function parseWhole(trimmed: string): ParsedChatMessage[] | null {
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return null; // 多行 JSONL 整体必然失败：回落逐行
  }
  if (Array.isArray(json)) return normList(json);
  if (isRecord(json) && Array.isArray(json.messages)) return normList(json.messages);
  return null; // 单个消息对象/纯元数据对象：交给逐行路径（等价且能正确处理坏行）
}

interface LineResult {
  msgs: ParsedChatMessage[];
  /** 成功解析为对象/数组的行数（>0 说明这基本就是 JSONL） */
  parsedLines: number;
}

function parseLines(trimmed: string): LineResult {
  const msgs: ParsedChatMessage[] = [];
  let parsedLines = 0;
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let json: unknown;
    try {
      json = JSON.parse(t); // 坏行：跳过不抛
    } catch {
      continue;
    }
    if (Array.isArray(json)) {
      parsedLines++;
      msgs.push(...normList(json));
      continue;
    }
    if (!isRecord(json)) continue; // 标量行（pretty JSON 的残片）不算命中
    parsedLines++;
    const m = normMsg(json);
    if (m) msgs.push(m);
  }
  return { msgs, parsedLines };
}

/**
 * 宽容解析 ST 聊天记录文本。任何输入都不抛异常；解析不出消息返回 []。
 * 判定顺序：.jsonl 文件名提示且逐行有产出 → 用逐行；否则先整体（数组/{messages}），
 * 再回落逐行——两种形态因此都能被缺省 fileName 正确识别。
 */
export function parseStChat(text: string, fileName?: string): ParsedChatMessage[] {
  const raw = typeof text === "string" ? text : "";
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return [];
  const lines = parseLines(trimmed);
  if (lines.msgs.length > 0 && /\.jsonl$/i.test(fileName ?? "")) return lines.msgs;
  const whole = parseWhole(trimmed);
  if (whole) return whole;
  return lines.msgs;
}

/** 消息序列 → 分析用转写：每行 `名字：内容`；跳过 system；空数组返回空串 */
export function toTranscript(msgs: ParsedChatMessage[]): string {
  if (!Array.isArray(msgs)) return "";
  const out: string[] = [];
  for (const m of msgs) {
    if (!m || m.role === "system") continue;
    out.push(`${m.name}：${m.content}`);
  }
  return out.join("\n");
}
