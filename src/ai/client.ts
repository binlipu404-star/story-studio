import type { ChatMessage } from "../core/types";
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
