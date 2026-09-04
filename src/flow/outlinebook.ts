// ============================================================
// 剧情世界书（outlinebook）：选一段/全部大纲 → 一整本 ST 世界信息
//
// 与早期"节拍书"的区别：一本完整、可在酒馆长期管理的书——
//   · 粒度为「幕」：每幕一条导演指令（期望事件列表内嵌），不再一拍一条；
//   · 调度沿用 ST 原生机制：触发词命中 → depth 深度注入 → sticky 停留 →
//     cooldown 冷却；同组互斥 + 靠前幕权重高 → 天然按幕推进、不刷屏；
//   · 不绑定任何角色：只指导叙事推进，不定义角色；指令文本用酒馆变量
//     {{char}}/{{user}} 指代当前对象，导入任何角色即时可用；
//   · 已演完自动退场：节拍 done 标「已演」，整幕 done（状态机）默认整条跳过，
//     复盘标记后重新生成，书会自己"变薄"。
//
// 纯逻辑模块：依赖 ../st/lorebook.js 导出器，可进 Node 冒烟测试。
// ============================================================

import type { Beat, LoreEntry } from "../core/types";
import { exportLorebookGlobal } from "../st/lorebook.js";

/** 全部剧情条目同组：同轮多条命中时 ST 只保留权重最高的一条 */
export const STORY_GROUP = "story-studio·剧情推进";

/** 一本完整书自带的使用协议（蓝灯常驻）：教模型怎么读这些导演指令 */
export const STORY_PROTOCOL = [
  "【剧情推进协议】本书条目是虚构故事的导演指令（作者注释性质），不是世界事实。",
  "被激活的条目描述当前应推进的剧情：让 {{char}} 及其他虚构角色把局面推向尚未演出的事件，并为 {{user}} 的介入留白。",
  "绝不替 {{user}} 发言或行动；玩家若明显偏离指令，尊重玩家选择，但保留指令事件日后发生的可能。",
  "与当前剧情无关、或标注「已演」的指令一律忽略。",
].join("\n");

export interface OutlineBookScene {
  nodeId: string;
  title: string;
  /** 层级路径（如 "卷一·第一章"），写进 comment 便于在 ST 里管理 */
  lineage?: string;
  intent?: string;
  location?: string;
  timepoint?: string;
  beats: Beat[];
  castNames?: string[];
  /** 节点状态机为 done/canon 之类已演完状态时置 true：默认整幕跳过 */
  done?: boolean;
}

export interface OutlineBookOptions {
  projectId?: string;
  uidStart?: number;
  depth?: number; // 默认 1：贴着最新一条消息注入
  sticky?: number; // 默认 8：幕级指令值得停留更久
  cooldown?: number; // 默认 4
  includeDone?: boolean; // 默认 false：已演完的幕不成条
  maxKeys?: number; // 每幕触发词上限，默认 8
  protocolEntry?: boolean; // 默认 true：附带蓝灯「使用协议」条目
}

export interface OutlineBookEntryInfo {
  scene: string; // 幕标题
  keys: string[];
  fallback: boolean; // 无触发词 → 蓝灯常驻兜底
}

export interface OutlineBookResult {
  entries: LoreEntry[];
  scenesByEntry: OutlineBookEntryInfo[];
  skippedDone: number;
}

// ---------- 触发词抽取（无分词器的保守启发式） ----------

/** 中文短句尾词落在这张表里则太泛/太动词化，不作触发词 */
const CJK_TAIL_STOPS = new Set([
  "发现", "出现", "来到", "到了", "离开", "开始", "结束", "突然", "于是", "然后",
  "已经", "没有", "无法", "不能", "可以", "自己", "一个", "什么", "他们", "她们",
  "就是", "还是", "为了", "感到", "知道", "决定", "试图", "准备", "打算", "带着",
  "朝着", "向着", "此时", "随即", "立刻", "马上", "终于", "竟然", "忽然", "继续",
]);

/** 英文常见虚词（≥3 字母但太泛） */
const LATIN_STOPS = new Set([
  "the", "and", "for", "his", "her", "your", "into", "onto", "from", "that", "this",
  "with", "she", "him", "but", "not", "they", "them", "were", "has", "had", "was",
  "are", "say", "says", "said", "then", "when", "while", "over", "under",
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 从文本抽触发词（保序去重，截 maxKeys）：
 * 引号短语（「」『』“”《》）→ 短句尾二字（剥语气助词、动停表过滤）→ 英文实词 → 人名兜底。
 */
export function extractBeatKeys(beatText: string, castNames: string[], maxKeys = 3): string[] {
  const text = (beatText ?? "").trim();
  const keys: string[] = [];
  const push = (k: string) => {
    const key = k.trim();
    if (key && !keys.some((x) => x.toLowerCase() === key.toLowerCase())) keys.push(key);
  };

  for (const m of text.matchAll(/[「『“《]([^」』”》]{1,12})[」』”》]/g)) push(m[1]);

  if (keys.length < maxKeys) {
    for (const clause of text.split(/[，。！？；：、,.!?;:\s…—\-「」『』“”《》()（）]+/)) {
      if (keys.length >= maxKeys) break;
      // 剥掉尾部语气助词再取尾词："摩根娜离开了" → "摩根娜离开"
      const c = clause.trim().replace(/[的了着过吧啊呢吗嘛哦呀]+$/, "");
      if (!c || !CJK_RE.test(c)) continue;
      const tail = c.slice(-2);
      if (!CJK_RE.test(tail)) continue;
      if (CJK_TAIL_STOPS.has(tail)) continue;
      push(tail);
    }
  }

  if (keys.length < maxKeys) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
      if (keys.length >= maxKeys) break;
      if (LATIN_STOPS.has(m[0].toLowerCase())) continue;
      push(m[0]);
    }
  }

  if (keys.length === 0) {
    for (const n of castNames) {
      if (n && text.includes(n)) push(n);
    }
  }

  return keys.slice(0, maxKeys);
}

// ---------- 成书 ----------

function mkId(): string {
  return `obk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function blankEntry(projectId: string, uid: number): LoreEntry {
  return {
    id: mkId(),
    projectId,
    uid,
    comment: "",
    content: "",
    keys: [],
    secondaryKeys: [],
    constant: false,
    selective: false,
    caseSensitive: false,
    matchWholeWord: true, // ST 对 CJK 自动跳过整词检查，此值只约束英文词
    position: "after_char",
    order: 0,
    depth: null,
    sticky: null,
    cooldown: null,
    probability: 100,
    useProbability: true,
    group: "",
    groupOverride: false,
    groupWeight: 100,
    excludeRecursion: false,
    preventRecursion: false,
    enabled: true,
    extensions: {},
  };
}

function sceneDirective(s: OutlineBookScene, order: number, total: number): string {
  const head = [`【剧情指令｜第 ${order} 幕·${s.title}】`];
  if (s.intent?.trim()) head.push(`目标：${s.intent.trim()}`);
  const when = [s.timepoint?.trim(), s.location?.trim()].filter(Boolean).join("·");
  if (when) head.push(`时空：${when}`);
  const beats = s.beats.filter((b) => b.text.trim());
  if (beats.length > 0) {
    head.push("期望事件（按序只推进第一个未演出的）：");
    beats.forEach((b, i) => head.push(`${i + 1}. ${b.text.trim()}${b.done ? "（已演）" : ""}`));
  }
  head.push(
    "执行：让 {{char}} 与其他登场角色把剧情推向尚未演出的期望事件，为 {{user}} 的介入留白；全部已演则忽略本条。",
  );
  return head.join("\n");
}

/** 选中的幕 → 一整本世界书条目（协议条目 + 每幕一条；配 exportLorebookGlobal 落文件） */
export function outlineBookEntries(
  scenes: OutlineBookScene[],
  opts: OutlineBookOptions = {},
): OutlineBookResult {
  const {
    projectId = "outline-book",
    uidStart = 1,
    depth = 1,
    sticky = 8,
    cooldown = 4,
    includeDone = false,
    maxKeys = 8,
    protocolEntry = true,
  } = opts;

  const entries: LoreEntry[] = [];
  const scenesByEntry: OutlineBookEntryInfo[] = [];
  let nextUid = uidStart;
  let skippedDone = 0;

  if (protocolEntry) {
    const proto = blankEntry(projectId, nextUid++);
    proto.comment = "剧情推进协议（蓝灯·常驻）";
    proto.content = STORY_PROTOCOL;
    proto.constant = true;
    proto.order = 0;
    proto.depth = 2;
    proto.extensions = { story_studio_protocol: true };
    entries.push(proto);
  }

  const pool = scenes.filter((s) => s.title.trim() || s.beats.length > 0);
  const total = pool.length;

  pool.forEach((s, idx) => {
    if (s.done && !includeDone) {
      skippedDone++;
      return;
    }
    const cast = s.castNames ?? [];
    // 触发词：幕标题必入 + 全部节拍文本抽取补位（去重、截断）
    const keys: string[] = [];
    const push = (k: string) => {
      const key = k.trim();
      if (key && !keys.some((x) => x.toLowerCase() === key.toLowerCase())) keys.push(key);
    };
    push(s.title);
    for (const b of s.beats) {
      if (keys.length >= maxKeys) break;
      for (const k of extractBeatKeys(b.text, cast, 3)) push(k);
    }
    if (keys.length <= 1) {
      for (const n of cast) {
        if (keys.length >= maxKeys) break;
        push(n);
      }
    }
    const fallback = keys.length <= 1; // 只有标题一个词也视为弱触发

    const e = blankEntry(projectId, nextUid++);
    e.comment = `幕 ${idx + 1}/${total}${s.lineage ? `·${s.lineage}` : ""}·${s.title}`;
    e.content = sceneDirective(s, idx + 1, total);
    e.keys = keys;
    e.constant = fallback;
    e.order = idx + 1;
    e.depth = fallback ? 1 : depth;
    e.sticky = fallback ? null : sticky;
    e.cooldown = fallback ? null : cooldown;
    e.group = fallback ? "" : STORY_GROUP;
    e.groupWeight = (total - idx) * 10; // 靠前幕权重高 → 命中并列优先推最早的幕
    e.extensions = { story_studio_scene: true, scene_node: s.nodeId, scene_index: idx + 1 };
    entries.push(e);
    scenesByEntry.push({ scene: s.title || `#${idx + 1}`, keys, fallback });
  });

  return { entries, scenesByEntry, skippedDone };
}

/** 一键成书：ST 全局 world info JSON（世界信息面板 import 直接可用；不绑角色） */
export function outlineBookJson(
  scenes: OutlineBookScene[],
  opts: OutlineBookOptions = {},
): { json: string; result: OutlineBookResult } {
  const result = outlineBookEntries(scenes, opts);
  return { json: JSON.stringify(exportLorebookGlobal(result.entries), null, 2), result };
}
