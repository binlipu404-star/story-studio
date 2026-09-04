// ============================================================
// L3 节拍词条化：一幕的节拍列表 → ST 世界书条目（自动推拍，零换手）
//
// 原理：每个未演节拍做成一条关键词世界书条目——聊到该拍的触发词时，
// ST 原生引擎把「节拍推进指令」注入到深度 depth（默认 1，贴着最后一句），
// sticky 几轮后自动退场（cooldown 冷却），不再刷屏；同组同轮只出一条、
// 靠前拍权重更高 → 天然按序推进。sticky/cooldown 由 ST 本体调度，
// 导出文件完整携带这些字段（对 1.18 实测往返无损）。
//
// 纯逻辑模块：仅依赖 ../st/lorebook.js 的导出器；可进 Node 冒烟测试。
// 触发词抽取是无分词器的保守启发式：引号短语 > 短句尾词 > 英文词 > 人名兜底 >
// 一无所获则该条转蓝灯 constant（永远在提示里当最低限度的进度清单）。
// ============================================================

import type { Beat, LoreEntry } from "../core/types";
import { exportLorebookGlobal } from "../st/lorebook.js";

/** 全部节拍条目挂同一组：同轮命中多条时 ST 只保留一条（权重高者优先） */
export const BEAT_GROUP = "story-studio·节拍推进";

export interface BeatBookOptions {
  projectId?: string;
  uidStart?: number; // 默认 1（独立成书；导入到已有书时 ST 会重排 uid）
  depth?: number; // 注入深度：默认 1 = 贴着最后一句用户消息
  sticky?: number; // 激活后停留轮数：默认 4
  cooldown?: number; // 熄灭后冷却轮数：默认 6（≈4 注入 + 2 静默）
  includeDone?: boolean; // 默认剔除已标记 done 的节拍
  maxKeys?: number; // 每拍触发词上限：默认 3
}

export interface BeatKeyInfo {
  beat: string; // 节拍原文
  keys: string[]; // 抽出的触发词（可空）
  fallback: boolean; // true = 没抽出触发词，转蓝灯 constant
}

export interface BeatBookResult {
  entries: LoreEntry[];
  keysByBeat: BeatKeyInfo[];
}

// ---------- 触发词抽取 ----------

/** 中文短句尾词若落在这张表里则太泛/太动词化，不作触发词 */
const CJK_TAIL_STOPS = new Set([
  "发现", "出现", "来到", "到了", "离开", "开始", "结束", "突然", "于是", "然后",
  "已经", "没有", "无法", "不能", "可以", "自己", "一个", "什么", "他们", "她们",
  "就是", "还是", "为了", "感到", "知道", "决定", "试图", "准备", "打算", "带着",
  "朝着", "向着", "此时", "随即", "立刻", "马上", "终于", "竟然", "忽然", "继续",
]);

/** 英文常见词（≥3 字母但太泛），不作触发词 */
const LATIN_STOPS = new Set([
  "the", "and", "for", "his", "her", "your", "into", "onto", "from", "that", "this",
  "with", "she", "him", "his", "him", "but", "not", "they", "them", "were", "has",
  "had", "was", "are", "say", "says", "said", "then", "when", "while", "over", "under",
]);

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/;

/**
 * 从节拍文本抽触发词（保序、去重、截 maxKeys）：
 *  引号短语（「」『』“”《》）→ 短句尾二字（跳过动词/虚词尾）→ 英文词 → 出场人名。
 */
export function extractBeatKeys(beatText: string, castNames: string[], maxKeys = 3): string[] {
  const text = (beatText ?? "").trim();
  const keys: string[] = [];
  const push = (k: string) => {
    const key = k.trim();
    if (key && !keys.some((x) => x.toLowerCase() === key.toLowerCase())) keys.push(key);
  };

  // 1) 引号短语
  for (const m of text.matchAll(/[「『“《]([^」』”》]{1,12})[」』”》]/g)) push(m[1]);

  // 2) 短句尾二字词（中文句尾常落在宾语名词上：…发现匕首 → 匕首）
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

  // 3) 英文词
  if (keys.length < maxKeys) {
    for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
      if (keys.length >= maxKeys) break;
      if (LATIN_STOPS.has(m[0].toLowerCase())) continue;
      push(m[0]);
    }
  }

  // 4) 出场人名（仅在前面一无所获时兜底，人名触发面太宽）
  if (keys.length === 0) {
    for (const n of castNames) {
      if (n && text.includes(n)) push(n);
    }
  }

  return keys.slice(0, maxKeys);
}

// ---------- 条目生成 ----------

function mkId(): string {
  return `b2b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function beatDirective(beat: string, i: number, total: number): string {
  return [
    `【节拍推进｜第 ${i + 1}/${total} 拍】${beat}`,
    "若这一幕尚未演到此处：让场面在本回合自然向该节拍收拢，结尾留出切入点；已演出则忽略本条。",
  ].join("\n");
}

/** 节拍 → LoreEntry[]（ST 全局世界书语义；配 exportLorebookGlobal 直接落文件） */
export function beatsToEntries(beats: Beat[], castNames: string[], opts: BeatBookOptions = {}): BeatBookResult {
  const {
    projectId = "beat-book",
    uidStart = 1,
    depth = 1,
    sticky = 4,
    cooldown = 6,
    includeDone = false,
    maxKeys = 3,
  } = opts;

  const pool = beats.filter((b) => (includeDone || !b.done) && b.text.trim());
  const total = beats.length; // 编号保持全幕视角（第 N/M 拍），剔除 done 只影响是否成条
  const entries: LoreEntry[] = [];
  const keysByBeat: BeatKeyInfo[] = [];

  pool.forEach((beat) => {
    const i = beats.indexOf(beat); // 全幕编号（1 基）
    const keys = extractBeatKeys(beat.text, castNames, maxKeys);
    const fallback = keys.length === 0;
    keysByBeat.push({ beat: beat.text, keys, fallback });

    entries.push({
      id: mkId(),
      projectId,
      uid: uidStart + entries.length,
      comment: `节拍 ${i + 1}/${total}·${beat.text.slice(0, 16)}${beat.text.length > 16 ? "…" : ""}`,
      content: beatDirective(beat.text, i, total),
      keys,
      secondaryKeys: [],
      constant: fallback, // 抽不到触发词 → 蓝灯常驻，当最低限度的进度清单
      selective: false,
      caseSensitive: false,
      matchWholeWord: true, // ST 对 CJK 自动跳过整词检查，此值只约束英文词
      position: "after_char",
      order: i + 1,
      depth, // 深度注入：贴着最新一句，比塞进角色定义更“大声”
      sticky: fallback ? null : sticky,
      cooldown: fallback ? null : cooldown,
      probability: 100,
      useProbability: true,
      group: fallback ? "" : BEAT_GROUP, // 同组同轮只出一条 → 自动按序、不刷屏
      groupOverride: false,
      groupWeight: (total - i) * 10, // 靠前拍权重高 → 命中并列时优先推最早的拍
      excludeRecursion: false,
      preventRecursion: false,
      enabled: true,
      extensions: { story_studio_beat: true, beat_index: i + 1 },
    });
  });

  return { entries, keysByBeat };
}

/** 一键成书：ST 全局 world info JSON 文本（世界书面板 import 直接可用） */
export function beatBookJson(beats: Beat[], castNames: string[], opts: BeatBookOptions = {}): { json: string; result: BeatBookResult } {
  const result = beatsToEntries(beats, castNames, opts);
  return { json: JSON.stringify(exportLorebookGlobal(result.entries), null, 2), result };
}
