import type { ChatMessage } from "../core/types";
import type { AgentMessage, ToolCall, ToolSpec } from "../flow/agent";
import { errMsg } from "../core/uiUtils";
import { loadAppConfig } from "./config";
import { extractJson } from "./json";

/** 模型角色：创作 / 分析（对应 AppConfig 的两个端点槽位） */
export type ChatRole = "writer" | "analyzer";

export interface ChatOptions {
  /** 使用哪套端点配置，默认 "writer" */
  role?: ChatRole;
  temperature?: number;
  maxTokens?: number;
  /** 要求模型返回 JSON 对象（response_format: json_object） */
  json?: boolean;
  /** 外部中断信号 */
  signal?: AbortSignal;
  /** 正文增量回调（reasoning_content 不从这里走） */
  onDelta?: (delta: string) => void;
  /** 思维链增量回调（推理模型 provider 返回 reasoning_content 时逐段回调） */
  onReasoning?: (delta: string) => void;
}

export interface ChatResult {
  content: string;
  /** 推理模型的思维链（provider 未返回时为 undefined） */
  reasoning?: string;
}

/** SSE 单帧里我们关心的部分（其余字段忽略） */
interface SseChunk {
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown };
  }[];
}

/**
 * 流式对话：浏览器直连 OpenAI 兼容端点（/chat/completions, stream:true）。
 * - content 增量边到边回调 onDelta 并累积；
 * - reasoning_content 单独累积，只出现在返回值里；
 * - 非 2xx 抛「状态码 + body 前 300 字」；AbortError 原样上抛。
 */
export async function chat(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const ep = loadAppConfig()[opts.role ?? "writer"];
  if (!ep.baseURL) throw new Error("未配置 baseURL，请先到设置页填写");
  if (!ep.model) throw new Error("未配置模型名（model），请先到设置页填写");

  const temperature = opts.temperature ?? ep.temperature ?? 0.7;
  const maxTokens = opts.maxTokens ?? ep.maxTokens;
  const base = ep.baseURL.replace(/\/+$/, ""); // 去掉尾部斜杠，避免拼出 //chat/completions

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: ep.model,
      messages,
      temperature,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      stream: true,
      // 刻意不加 stream_options：不少兼容端点不认识该字段会直接报错
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
    }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* 忽略读取失败 */
    }
    throw new Error(`AI 请求失败 ${res.status}: ${detail.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("当前环境不支持流式响应体（res.body 为空）");

  let content = "";
  let reasoning: string | undefined;

  /** 处理一行 SSE；返回 true 表示收到 [DONE] */
  const handleLine = (line: string): boolean => {
    const t = line.replace(/\r$/, "").trim();
    if (!t.startsWith("data:")) return false; // 忽略 event:/id:/注释/空行
    const payload = t.slice(5).trim();
    if (!payload) return false;
    if (payload === "[DONE]") return true;
    try {
      const chunk = JSON.parse(payload) as SseChunk;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return false;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        opts.onDelta?.(delta.content);
      }
      if (
        typeof delta.reasoning_content === "string" &&
        delta.reasoning_content
      ) {
        reasoning = (reasoning ?? "") + delta.reasoning_content;
        opts.onReasoning?.(delta.reasoning_content);
      }
    } catch {
      /* 非 JSON 的心跳/残帧，忽略 */
    }
    return false;
  };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = ""; // 跨 chunk 的半行缓冲：chunk 可能把一行 data 切成两半
  let finished = false; // 收到 [DONE]

  for (;;) {
    const { done, value } = await reader.read(); // abort 时这里抛 AbortError，原样上抛
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (handleLine(line)) {
        finished = true;
        break;
      }
      nl = buf.indexOf("\n");
    }
    if (finished) break;
  }

  if (!finished) {
    // 流结束但没有 [DONE]：冲掉解码器残余 + 处理没有换行收尾的最后一行
    buf += decoder.decode();
    if (buf.trim()) handleLine(buf);
  } else {
    // 收到 [DONE] 后主动取消 reader，尽快释放底层连接
    reader.cancel().catch(() => undefined);
  }

  return { content, reasoning };
}

/**
 * JSON 模式对话：流式收全后用 extractJson 解析；
 * 解析失败自动追加一条修复消息重试一次，再失败抛出含原文前 200 字的错误。
 */
export async function chatJSON<T = unknown>(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<T> {
  const jsonOpts: ChatOptions = { ...opts, json: true };
  const first = await chat(messages, jsonOpts);
  try {
    return extractJson<T>(first.content);
  } catch {
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: first.content },
      {
        role: "user",
        content:
          "你上一条回复不是有效的 JSON，无法解析。请重新输出，只包含一个合法 JSON 对象，不要 markdown 代码块、不要任何解释文字。",
      },
    ];
    const second = await chat(repairMessages, jsonOpts);
    try {
      return extractJson<T>(second.content);
    } catch (e) {
      throw new Error(
        `JSON 解析失败（已重试一次）：${errMsg(e)}；响应原文前 200 字：${second.content.slice(0, 200)}`,
      );
    }
  }
}

// ============================================================
// 工具通道（v3-P3 场记 agent）：非流式 + OpenAI tools 多轮循环
// ============================================================

export interface ChatToolsStep {
  round: number;
  assistantText: string;
  reasoning?: string; // 推理模型该轮的思维链（provider 支持时）
  truncated?: boolean; // 该轮被 max_tokens 腰斩（finish_reason=length）
  calls: { name: string; arguments: string; result: string }[];
}

export interface ChatToolsResult {
  text: string; // 最终正文（无工具调用的那轮 content，或最后一轮）
  steps: ChatToolsStep[]; // 活动流（UI 展示每一步调用与结果）
  stopped: "final" | "max_rounds";
}

/** 端点不认识 tools 字段：调用方捕获后降级（场记退化为纯摘要整理） */
export class ToolsUnsupportedError extends Error {}

interface ApiResponseMessage {
  role?: string;
  content?: string | null;
  reasoning_content?: string | null; // 推理模型思维链（非流式形态）
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
}

interface ApiTurnResult {
  message: ApiResponseMessage;
  finishReason?: string; // length = 被 max_tokens 腰斩（截断告警用）
}

async function postChatOnce(
  body: Record<string, unknown>,
  role: ChatRole,
  signal?: AbortSignal,
): Promise<ApiTurnResult> {
  const ep = loadAppConfig()[role];
  if (!ep.baseURL) throw new Error("未配置 baseURL，请先到设置页填写");
  if (!ep.model) throw new Error("未配置模型名（model），请先到设置页填写");
  const base = ep.baseURL.replace(/\/+$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: ep.model, ...body }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* 忽略 */
    }
    throw new Error(`AI 请求失败 ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: ApiResponseMessage; finish_reason?: string }[];
  };
  return { message: data.choices?.[0]?.message ?? {}, finishReason: data.choices?.[0]?.finish_reason };
}

/**
 * 场记 agent 多轮工具循环（非流式：整理动作不需要逐字流）。
 * execute 同步返回给模型的结果文本（runScriptTool）。端点在**首轮请求**就因 tools
 * 字段被拒（400/422/404 且未产生任何轮次）→ 抛 ToolsUnsupportedError 供上层降级。
 */
export async function chatTools(opts: {
  messages: AgentMessage[];
  tools: ToolSpec[];
  execute: (call: ToolCall) => string;
  role?: ChatRole;
  maxRounds?: number; // 成本闸门：模型最多"思考-调用"多少轮
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  onStep?: (step: ChatToolsStep) => void;
}): Promise<ChatToolsResult> {
  const ep = loadAppConfig()[opts.role ?? "analyzer"];
  const maxRounds = Math.max(1, Math.min(opts.maxRounds ?? 4, 10));
  // 截断防护：场记轮要装下「思维链+工具调用 JSON」，绝不能盲从端点全局 maxTokens
  // （analyzer 常配 1024 之类小预算，推理模型光思维链就吃光 → tool_calls 被腰斩，
  //  表现为"场记异常截断"）。显式给足，除非调用方另有指定。
  const maxTokens = opts.maxTokens ?? Math.max(ep.maxTokens ?? 0, 2048);
  const msgs: AgentMessage[] = [...opts.messages];
  const steps: ChatToolsStep[] = [];
  let lastText = "";

  for (let round = 1; round <= maxRounds; round++) {
    let msg: ApiResponseMessage;
    let finishReason: string | undefined;
    try {
      const out = await postChatOnce(
        {
          messages: msgs,
          temperature: opts.temperature ?? ep.temperature ?? 0.4,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          tools: opts.tools,
          tool_choice: "auto",
          stream: false,
        },
        opts.role ?? "analyzer",
        opts.signal,
      );
      msg = out.message;
      finishReason = out.finishReason;
    } catch (e) {
      const m = errMsg(e);
      if (steps.length === 0 && /\b(400|404|422)\b/.test(m)) {
        throw new ToolsUnsupportedError(`端点可能不支持 tools 字段：${m}`);
      }
      throw e;
    }
    const text = typeof msg.content === "string" ? msg.content : "";
    const rawCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const calls: ToolCall[] = rawCalls
      .filter((c) => c && typeof c.id === "string" && c.function && typeof c.function.name === "string")
      .map((c) => ({
        id: c.id as string,
        type: "function" as const,
        function: { name: c.function!.name as string, arguments: c.function!.arguments ?? "{}" },
      }));
    if (text) lastText = text;

    if (calls.length === 0) {
      if (finishReason === "length" && text.trim()) {
        lastText = `${text}\n\n（提醒：本轮输出被 max_tokens 截断，结论可能不完整——可在设置里调大分析端点的 max_tokens）`;
      }
      return { text: lastText, steps, stopped: "final" };
    }

    // 执行并回灌
    const step: ChatToolsStep = {
      round,
      assistantText: text,
      ...(typeof msg.reasoning_content === "string" && msg.reasoning_content ? { reasoning: msg.reasoning_content } : {}),
      ...(finishReason === "length" ? { truncated: true } : {}),
      calls: [],
    };
    msgs.push({ role: "assistant", content: text || null, tool_calls: calls });
    for (const call of calls) {
      let result: string;
      try {
        result = opts.execute(call);
      } catch (e) {
        result = `工具执行出错：${errMsg(e)}`;
      }
      step.calls.push({ name: call.function.name, arguments: call.function.arguments, result });
      msgs.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    steps.push(step);
    opts.onStep?.(step);
  }
  return { text: lastText || "（达到轮次上限，场记停止本轮整理）", steps, stopped: "max_rounds" };
}
