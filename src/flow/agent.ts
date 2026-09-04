// ============================================================
// 场记 agent 纯逻辑（v3-P3）：工具协议 / SSE tool_calls 增量累积 / 执行器
//
// agent 只能看到 7 个只读+副本写工具——物理上不存在任何修改主纲的工具，
// 「主纲只能去大纲工作台改」由工具表本身保证，不靠提示词恳求。
// SSE 行解析在这里做成纯函数（Node 可测），client.ts 只做 fetch 薄壳。
// ============================================================

import { scriptBlock, storyAdvance } from "./script.js";
import type { LedgerRecord, LedgerType, ScriptSnapshot } from "../core/types";
// ---------- OpenAI 工具形状（OpenAI 兼容端点） ----------

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string }; // arguments 是 JSON 字符串（可能增量拼出）
}

/** 会话消息宽形（core 的 ChatMessage 只有 role/content；工具流需要更宽的形态） */
export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ---------- tool_calls 增量累积（流式下 function.name/arguments 分片到达） ----------

export interface ToolCallAccumulator {
  feed(delta: unknown): void; // delta = chunk.choices[0].delta（含 tool_calls 分片）
  result(): ToolCall[]; // 无完整工具调用 → []
}

/**
 * 规范：delta.tool_calls[i] 按 index 对齐，首片带 id/name，后续片 arguments 追加。
 * 宽松：无 id 的片忽略；name 分片拼接（个别端点也拆 name）；arguments 全拼接。
 */
export function createToolCallAccumulator(): ToolCallAccumulator {
  const byIndex = new Map<number, { id: string; name: string; args: string }>();
  return {
    feed(delta: unknown): void {
      const d = delta as { tool_calls?: unknown } | undefined;
      if (!d || !Array.isArray(d.tool_calls)) return;
      d.tool_calls.forEach((raw, i) => {
        if (typeof raw !== "object" || raw === null) return;
        const tc = raw as Record<string, unknown>;
        const idx = typeof tc.index === "number" ? tc.index : i;
        const cur = byIndex.get(idx) ?? { id: "", name: "", args: "" };
        if (typeof tc.id === "string") cur.id = tc.id;
        const fn = tc.function as Record<string, unknown> | undefined;
        if (fn) {
          if (typeof fn.name === "string") cur.name += fn.name;
          if (typeof fn.arguments === "string") cur.args += fn.arguments;
        }
        byIndex.set(idx, cur);
      });
    },
    result(): ToolCall[] {
      const out: ToolCall[] = [];
      for (const [, v] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
        if (!v.id || !v.name) continue; // 残片不算调用
        out.push({ id: v.id, type: "function", function: { name: v.name, arguments: v.args } });
      }
      return out;
    },
  };
}

// ---------- 场记的 7 个工具（唯一权限面） ----------

export const SCRIPT_TOOLS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "read_outline",
      description: "读取房间剧本副本（幕/节拍/伏笔清单，含完成标记）。副本之外你什么大纲也看不到、改不了。",
      parameters: { type: "object", properties: { scope: { type: "string", enum: ["all", "current"], description: "all=全部副本（可能截断），current=当前幕前后窗口" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "get_progress",
      description: "查看推进统计：第几幕/第几拍、完成数、是否演尽。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_beat",
      description: "在副本上把某个节拍标记为 done（已演到）或 skipped（明确跳过）。只改房间的副本标记，主纲不受影响。",
      parameters: {
        type: "object",
        properties: {
          beat_id: { type: "string", description: "read_outline 里的节拍 id" },
          status: { type: "string", enum: ["done", "skipped", "unmark"] },
          note: { type: "string", description: "一句话依据（哪段对话演到了它）" },
        },
        required: ["beat_id", "status"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "where_is_story",
      description: "一句话回答：剧情现在推进到剧本的哪一步。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "next_step",
      description: "按副本推导下一拍是什么（含所属幕的戏剧目标）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_ledger",
      description: "读本房间正典台账（已确认事实；可关键词过滤）。",
      parameters: { type: "object", properties: { query: { type: "string", description: "可选关键词过滤" }, limit: { type: "number", description: "最多条数，默认 30" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "append_ledger",
      description: "把对话中已发生、值得长期记住的事实写入本房间正典台账（宁缺毋滥，一次调用一条）。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["event", "item", "relation", "foreshadow", "worldstate"] },
          content: { type: "string", description: "一句话事实：谁做了什么/什么变成了什么" },
          actors: { type: "array", items: { type: "string" }, description: "相关角色/道具名" },
        },
        required: ["type", "content"],
      },
    },
  },
];

/** 场记 system 附块（工具使用说明+边界，交给页面拼进对话） */
export const SCRIPT_KIT_DIRECTIVE = [
  "你有一个「场记工具包」：read_outline / get_progress / mark_beat / where_is_story / next_step / read_ledger / append_ledger。",
  "- 依据对话实际内容使用：演到某拍就 mark_beat(done)；确定发生且值得长记的事实 append_ledger；拿不准位置就先 where_is_story。",
  "- 一切标记只作用于房间副本；原作大纲由用户在大纲工作台维护，你无权限也无需请求。",
  "- 不要为用工具而用工具：没有新事实/新进展就不调用。",
].join("\n");

// ---------- 工具执行器（纯：输入上下文+调用，输出结果文本与副作用描述） ----------

export interface ScriptCtx {
  snapshot: ScriptSnapshot;
  progress: Record<string, "done" | "skipped">;
  canon: LedgerRecord[]; // confirmed（含作品级借用标记由调用方决定传入范围）
  /** 副作用回调（页面实现：改房间 progress / 写台账表 / 记活动流） */
  onMarkBeat?: (beatId: string, status: "done" | "skipped" | "unmark", note: string) => void;
  onAppendLedger?: (item: { type: LedgerType; content: string; actors: string[] }) => void;
}

export interface ToolOutcome {
  result: string; // 回给模型的 tool 消息（永远纯文本，出错也返文本让模型自纠）
}

export function toolLabel(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "mark_beat":
      return `标记节拍 ${String(args.beat_id ?? "?")} → ${String(args.status ?? "?")}`;
    case "append_ledger":
      return `记台账：${String(args.content ?? "").slice(0, 40)}`;
    default:
      return name;
  }
}

/** 执行一次工具调用。未知工具/坏参数返回纠错文本（模型可见，不抛错）。 */
export function runScriptTool(ctx: ScriptCtx, name: string, argsJson: string): ToolOutcome {
  let args: Record<string, unknown> = {};
  try {
    const o = JSON.parse(argsJson || "{}");
    if (o && typeof o === "object") args = o as Record<string, unknown>;
  } catch {
    return { result: "参数不是合法 JSON 对象，请重新调用。" };
  }
  const adv = storyAdvance(ctx.snapshot, ctx.progress);

  switch (name) {
    case "read_outline": {
      const scope = args.scope === "current" ? "current" : "all";
      const text = scope === "all"
        ? scriptBlock(ctx.snapshot, ctx.progress, adv, 0, 0)
        : scriptBlock(ctx.snapshot, ctx.progress, adv, 1, 2);
      return { result: text || "（沙盒房间：无剧本副本）" };
    }
    case "get_progress":
      return {
        result: `幕 ${adv.scenesDone}/${adv.scenesTotal} 完成；拍 ${adv.beatsDone}/${adv.beatsTotal} 标记；` +
          (adv.finished ? "副本已演尽。" : `当前幕序号 ${adv.currentSceneIndex ?? "-"}，下一拍 ${adv.currentBeatId ?? "-"}。`),
      };
    case "mark_beat": {
      const beatId = typeof args.beat_id === "string" ? args.beat_id.trim() : "";
      const status = args.status;
      const note = typeof args.note === "string" ? args.note.trim() : "";
      if (!beatId || (status !== "done" && status !== "skipped" && status !== "unmark")) {
        return { result: "参数不合法：需要 beat_id 与 status(done|skipped|unmark)。先用 read_outline 找 id。" };
      }
      const exists = ctx.snapshot.scenes.some((sc) => sc.beats.some((b) => b.id === beatId));
      if (!exists) return { result: `副本里没有节拍 ${beatId}。先 read_outline 核对 id。` };
      ctx.onMarkBeat?.(beatId, status, note);
      return { result: `已记录：节拍 ${beatId} → ${status}${note ? `（${note}）` : ""}。这是房间副本标记，主纲未受影响。` };
    }
    case "where_is_story":
      return { result: adv.nextHint };
    case "next_step": {
      if (adv.finished) return { result: "副本节拍已全部标记完成。可以向用户提议：收尾本幕/开新房间/去大纲工作台续写后续。" };
      const cur = adv.currentSceneIndex !== null ? ctx.snapshot.scenes[adv.currentSceneIndex] : null;
      return { result: cur ? `当前幕「${cur.title}」（目标：${cur.intent || "未填"}）；下一拍：${adv.currentBeatText ?? "？"}` : "（沙盒房间：无剧本下一步）" };
    }
    case "read_ledger": {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const limit = typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 30;
      let rows = ctx.canon;
      if (query) rows = rows.filter((r) => r.content.includes(query) || r.actors.some((a) => a.includes(query)));
      if (rows.length === 0) return { result: "（暂无匹配的台账事实）" };
      return { result: rows.slice(-limit).map((r) => `- [${r.type}] ${r.content}`).join("\n") };
    }
    case "append_ledger": {
      const types = ["event", "item", "relation", "foreshadow", "worldstate"];
      const type = types.includes(String(args.type)) ? (args.type as LedgerType) : null;
      const content = typeof args.content === "string" ? args.content.trim() : "";
      if (!type || !content) return { result: "参数不合法：需要 type(event|item|relation|foreshadow|worldstate) 与 content。" };
      const actors = Array.isArray(args.actors) ? args.actors.filter((a): a is string => typeof a === "string" && a.trim() !== "") : [];
      ctx.onAppendLedger?.({ type, content, actors });
      return { result: "已写入本房间正典台账。" };
    }
    default:
      return { result: `未知工具 ${name}。你只有场记工具包里的七个工具。` };
  }
}
