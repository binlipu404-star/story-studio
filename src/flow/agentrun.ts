// ============================================================
// 场记运行注册表（v3.1-①）：整理任务的生命期脱离 React 组件。
//
// 老毛病根因：整理跑在 TheaterPage 的闭包里，切顶层页签 → 组件卸载 →
// 回写与活动流全部作废，只能从头整理。这里把 run 挂在模块级 Map 上：
//   · run 内所有落库直接走注入的 io（不依赖组件存活）；
//   · 每个工具调用**即时**落库（切页/中断都不丢已完成的部分）；
//   · 页面重挂载 subscribe() 即重连活动流（含进行中步骤的实时回放）。
// 依赖全部注入（io + chatTools），本模块自身不碰 React、不碰 Dexie。
// ============================================================

import type { DigestLedgerItem } from "./snapshot.js";
import type { LedgerRecord, RPSession } from "../core/types";
import { SCRIPT_KIT_DIRECTIVE, SCRIPT_TOOLS, runScriptTool, toolLabel } from "./agent.js";
import { chatJSON, chatTools, ToolsUnsupportedError } from "../ai/client.js";
import { rollingDigestPrompt } from "../ai/prompts.js";
import { sanitizeDigest } from "./snapshot.js";

export interface AgentRunState {
  roomId: string;
  running: boolean;
  steps: string[]; // 活动流（带时间戳），UI 直接渲染
  downgraded: boolean; // 端点无 tools → 已降级纯摘要
  startedAt: number;
}

type Listener = (s: AgentRunState) => void;

const runs = new Map<string, AgentRunState>();
const listeners = new Map<string, Set<Listener>>();

function publish(s: AgentRunState): void {
  listeners.get(s.roomId)?.forEach((fn) => {
    try {
      fn({ ...s, steps: [...s.steps] });
    } catch {
      /* 监听者抛错不连坐 */
    }
  });
}

export function getRunState(roomId: string): AgentRunState | null {
  const s = runs.get(roomId);
  return s ? { ...s, steps: [...s.steps] } : null;
}

export function isRunning(roomId: string): boolean {
  return runs.get(roomId)?.running === true;
}

/** 订阅某剧组的场记状态（当前快照立即回放一次）；返回退订函数。 */
export function subscribeAgentRun(roomId: string, fn: Listener): () => void {
  let set = listeners.get(roomId);
  if (!set) {
    set = new Set();
    listeners.set(roomId, set);
  }
  set.add(fn);
  const cur = runs.get(roomId);
  if (cur) fn({ ...cur, steps: [...cur.steps] });
  return () => {
    set?.delete(fn);
  };
}

function stamp(s: AgentRunState, line: string): void {
  s.steps = [...s.steps.slice(-59), `[${new Date().toLocaleTimeString()}] ${line}`];
  publish(s);
}

/** 页面层注入的落库通道（run 不直接依赖 Dexie，方便测试与复用） */
export interface OrganizeIO {
  /** 现读最新剧组行（每步落库前重读，避免整行覆盖并发丢字段） */
  loadRoom: (roomId: string) => Promise<RPSession | undefined>;
  /** 局部更新剧组字段（progress / rollingSummary…），绝不覆盖对话 */
  patchRoom: (roomId: string, patch: Partial<RPSession>) => Promise<void>;
  /** 写剧组正典（confirmed + roomId 绑定） */
  addCanon: (room: RPSession, items: DigestLedgerItem[]) => Promise<void>;
  /** 剧组正典（read_ledger 与提示词用） */
  canonOf: (roomId: string) => Promise<LedgerRecord[]>;
  /** 正典变化后通知页面刷新列表 */
  onCanonChanged: (roomId: string) => void;
  /** 每条活动行同时投喂给 UI（挂到思维链里展示） */
  onNote: (roomId: string, line: string) => void;
}

export interface OrganizeInput {
  roomId: string;
  io: OrganizeIO;
  sceneTitle: string;
  mode: "manual" | "auto";
}

/** 同剧组幂等防重：已在跑就直接返回（切页后再点也不会双跑）。 */
export async function startOrganize(input: OrganizeInput): Promise<void> {
  const { roomId, io, sceneTitle, mode } = input;
  if (runs.get(roomId)?.running) return;
  const state: AgentRunState = { roomId, running: true, steps: [], downgraded: false, startedAt: Date.now() };
  runs.set(roomId, state);
  const say = (line: string) => {
    stamp(state, line);
    io.onNote(roomId, line);
  };

  // —— 全部以库内最新行为底（不接收页面渲染态，切页期间页面数据是旧的）——
  const fresh0 = await io.loadRoom(roomId);
  if (!fresh0) {
    state.running = false;
    publish(state);
    return;
  }
  // run 私有的进度工作副本：mark_beat 立即落库，同时也更新它供后续工具读
  const progress: Record<string, "done" | "skipped"> = { ...(fresh0.progress ?? {}) };
  const applyMark = async (beatId: string, st: "done" | "skipped" | "unmark") => {
    if (st === "unmark") delete progress[beatId];
    else progress[beatId] = st;
    const fresh = await io.loadRoom(roomId);
    if (!fresh) return;
    await io.patchRoom(roomId, { progress: { ...progress } });
  };
  const appendCanon = async (item: DigestLedgerItem) => {
    const fresh = await io.loadRoom(roomId);
    if (!fresh) return;
    await io.addCanon(fresh, [item]);
    io.onCanonChanged(roomId);
  };

  // 整理用转写：最近 24 条非空消息（tools 主路与降级路共用）
  const transcriptOf = (msgs: typeof fresh0.messages) =>
    msgs
      .filter((m) => m.content.trim())
      .slice(-24)
      .map((m) => `${m.name}：${m.content.trim()}`)
      .join("\n\n");

  try {
    const turns = transcriptOf(fresh0.messages);
    const floors = fresh0.messages.filter((m) => m.role === "user").length;
    if (!turns.trim()) {
      if (mode === "manual") say("没什么可整理的：对话还是空的。");
      return;
    }
    const canon = await io.canonOf(roomId);
    say(mode === "auto" ? `楼层到点：场记开始整理（第 ${floors} 楼）` : "场记开始整理…");
    const res = await chatTools({
      role: "analyzer",
      tools: SCRIPT_TOOLS,
      // runScriptTool 同步返回；副作用转火即刻落库并回「已受理」
      execute: (call) =>
        runScriptTool(
          {
            snapshot: fresh0.script ?? { sourceTitle: "", takenAt: 0, nodesUpdatedAt: 0, scenes: [] },
            progress: { ...progress },
            canon,
            onMarkBeat: (id, st) => void applyMark(id, st),
            onAppendLedger: (it) => void appendCanon(it),
          },
          call.function.name,
          call.function.arguments,
        ).result,
      maxRounds: mode === "auto" ? 3 : 4,
      messages: [
        { role: "system", content: SCRIPT_KIT_DIRECTIVE },
        {
          role: "system",
          content: `【当前局面】${sceneTitle}（剧本《${fresh0.script?.sourceTitle || "沙盒"}》副本）。\n【剧组正典】${canon.length ? `${canon.length} 条已确认事实` : "（空白正典：这是新剧组）"}`,
        },
        {
          role: "user",
          content: `请整理下面这段 RP 对话（最近楼层）：核对已演到的节拍并标记，把新发生的事实写入正典。每标一处节拍，正文里说明依据（第几楼的哪句话）。\n\n${turns}`,
        },
      ],
      onStep: (s) => {
        for (const c of s.calls) {
          say(`${toolLabel(c.name, safeParse(c.arguments))} → ${c.result.split("\n")[0].slice(0, 60)}`);
        }
        if (s.truncated) say("⚠ 本轮输出被 max_tokens 截断（分析端点预算偏小，可在设置里调大）。");
      },
    });
    if (res.stopped === "max_rounds") say("已达轮次上限，剩余下轮继续。");
    if (res.text.trim()) say(`场记小结：${res.text.trim().slice(0, 200)}`);
    say(`本次标记节拍 ${Object.keys(progress).length} 处（只动剧组副本，主纲未受影响）`);
  } catch (e) {
    if (e instanceof ToolsUnsupportedError) {
      // 降级：无工具的纯摘要整理，digest 直接进剧组正典（用户决定②）
      state.downgraded = true;
      publish(state);
      try {
        const fresh = await io.loadRoom(roomId);
        if (!fresh) {
          say("剧组已不存在，整理中止。");
        } else {
          const turns = transcriptOf(fresh.messages);
          const obj = await chatJSON<unknown>(rollingDigestPrompt(fresh.rollingSummary ?? "", turns), { role: "analyzer" });
          const d = sanitizeDigest(obj);
          if (d.ledger.length) {
            await io.addCanon(fresh, d.ledger);
            io.onCanonChanged(roomId);
          }
          if (d.summary) await io.patchRoom(roomId, { rollingSummary: d.summary });
          say(`端点不支持工具调用，已降级为纯摘要整理：正典 ${d.ledger.length} 条${d.summary ? "，滚动摘要已更新" : ""}。（节拍标记不可用）`);
        }
      } catch (e2) {
        say(`降级整理也失败了：${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    } else {
      say(`整理失败：${e instanceof Error ? e.message : String(e)}`);
    }
  } finally {
    state.running = false;
    publish(state);
  }
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
