// ============================================================
// M4 试跑包组装器（纯函数）
// 不直接 import 兼容层（避免时序耦合）：调用方把兼容层产出的 JSON 传进来。
// 产出 = 一组「文件」（folder 名即建议 zip/目录名），UI 层落盘或下载。
// ============================================================

import type { OutlineNode } from "../core/types";
import { trialGreeting, trialAuthorNote, trialPackReadme } from "../ai/prompts.js";

export interface TrialPackInput {
  packName: string; // 一般 = 幕标题
  scene: OutlineNode;
  chapter?: OutlineNode;
  castNames: string[];
  userName: string;
  prevSummary?: string;
  loreBlock?: string; // 匹配引擎 buildLoreInjection 的结果
  userPersona?: string; // 用户画像块（personaPromptBlock 拼成，可空）
  /** 兼容层产物（st/card.ts 输出）；省略 = 无预设角色卡，自动合成「旁白卡」（原创小说试跑） */
  cardJson?: Record<string, unknown>;
  /** 旁白卡的展示名（仅无卡模式生效），默认 = 本幕标题 */
  narratorName?: string;
  worldview?: string; // 世界观一两句（旁白卡 description 用）
  lorebookJson?: Record<string, unknown>;
}

export interface TrialPackFile {
  name: string;
  content: string;
}

export interface TrialPack {
  folder: string;
  greeting: string;
  authorNote: string;
  files: TrialPackFile[];
}

/** Windows/Linux 都安全的目录/文件名 */
export function sanitizeName(name: string, fallback = "trial-pack"): string {
  const s = (name ?? "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80).trim();
  return s || fallback;
}

/**
 * 无预设角色卡时合成的「旁白卡」：chara_card_v2 骨架，
 * name=旁白（可改），description=世界观+出场人物+戏剧目标，first_mes=试跑 greeting。
 * 原创小说试跑专用——ST 里导入后即可开聊，无需任何预设角色。
 */
export function synthesizeNarratorCard(
  input: Pick<TrialPackInput, "scene" | "chapter" | "castNames" | "narratorName" | "worldview">,
  greeting: string,
): Record<string, unknown> {
  const cast = input.castNames.filter(Boolean);
  const description = [
    input.worldview ? `世界：${input.worldview}` : "",
    cast.length ? `登场角色：${cast.join("、")}。你扮演其中除 {{user}} 外的全部角色与旁白。` : "你扮演旁白与所有配角。",
    `当前场景：${input.chapter ? input.chapter.title + " · " : ""}${input.scene.title}。${input.scene.intent || ""}`,
    "以小说笔法演出，每个角色口吻区分；台词、心理、环境并重；绝不替 {{user}} 决定言行。",
  ]
    .filter(Boolean)
    .join("\n");
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: (input.narratorName || "").trim() || input.scene.title || "旁白",
      description,
      personality: "",
      scenario: input.scene.timepoint || "",
      first_mes: greeting,
      mes_example: "",
      creator_notes: "story-studio 自动合成的旁白试跑卡（原创模式，无需预设角色）。",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: [],
      tags: ["story-studio", "试跑", "旁白"],
      creator: "story-studio",
      character_version: "",
      extensions: { story_studio_trial: true },
    },
  };
}

export function buildTrialPack(input: TrialPackInput): TrialPack {
  const promptCtx = {
    scene: input.scene,
    chapter: input.chapter,
    castNames: input.castNames,
    userName: input.userName,
    prevSummary: input.prevSummary,
    loreBlock: input.loreBlock,
    userPersona: input.userPersona,
  };
  const greeting = trialGreeting(promptCtx);
  const authorNote = trialAuthorNote(promptCtx);
  const noCard = input.cardJson == null;
  const card = noCard ? synthesizeNarratorCard(input, greeting) : input.cardJson;
  const files: TrialPackFile[] = [
    { name: "card.json", content: JSON.stringify(card, null, 2) },
    { name: "greeting.txt", content: greeting },
    { name: "note.txt", content: authorNote },
    { name: "readme.md", content: trialPackReadme(input.packName, { noCard }) },
  ];
  if (input.lorebookJson) files.push({ name: "worldbook.json", content: JSON.stringify(input.lorebookJson, null, 2) });
  return { folder: sanitizeName(input.packName), greeting, authorNote, files };
}
