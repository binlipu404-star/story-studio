// ============================================================
// RP 剧场剧组装配（v3 核心；纯逻辑，可 Node 测试）
//
// 剧组 = 一条 kind:"theater" 的 RPSession：名字/节奏/模式/剧本副本/进展/配置快照。
// 装配只认剧组自带的数据（副本+剧组正典），主纲与作品级台账默认渗透不进来——
// full 模式的「同步」是用户显式按的按钮，不是隐式读取。
// ============================================================

import type {
  Character,
  LedgerRecord,
  LoreEntry,
  Persona,
  Project,
  RPSession,
  ScriptSnapshot,
  TheaterPace,
  TheaterScope,
} from "../core/types";
import type { RpSetup } from "./rp.js";
import { buildTrialPack, synthesizeNarratorCard } from "./trialpack.js";
import { ledgerSnapshot } from "./snapshot.js";
import { progressMemoText, scriptBlock, snapshotDebt, snapshotDebtText, storyAdvance } from "./script.js";
import { bibleElementsBlock, personaPromptBlock } from "../ai/prompts.js";
import { exportCardV2 } from "../st/card.js";

const EMPTY_SNAP: ScriptSnapshot = { sourceTitle: "", takenAt: 0, nodesUpdatedAt: 0, scenes: [] };

/** 剧组当前该演副本里的哪一幕：第一个未演尽的幕；全尽=最后一幕；沙盒=null */
export function roomCurrentScene(room: RPSession): ScriptSnapshot["scenes"][number] | null {
  const snap = room.script ?? EMPTY_SNAP;
  if (!snap.scenes.length) return null;
  const adv = storyAdvance(snap, room.progress ?? {});
  const i = adv.currentSceneIndex ?? snap.scenes.length - 1;
  return snap.scenes[i];
}

export interface RoomAssemblyInput {
  room: RPSession;
  project: Project | null;
  characters: Character[]; // 剧组所属作品的人物
  persona?: Persona; // 配置里选中的画像（可空）
  loreEntries: LoreEntry[]; // 已启用词条
  roomCanon: LedgerRecord[]; // 本剧组 confirmed 正典（roomId 绑定）
  projectCanon?: LedgerRecord[]; // 作品级 confirmed（仅 borrowProjectLedger 时传入）
}

export interface RoomAssembly {
  setup: RpSetup;
  greeting: string;
  /** author's note 基底（纠偏重建用） */
  baseNote: string;
  sceneTitle: string; // 当前幕（无剧本=自由即兴）
}

/** 快照幕 → buildTrialPack 可用的最小 OutlineNode 形状（cast 空：名字来自配置） */
function pseudoScene(sc: ScriptSnapshot["scenes"][number]): import("../core/types").OutlineNode {
  return {
    id: sc.nodeId ?? "",
    projectId: "",
    parentId: null,
    level: "scene",
    order: 0,
    title: sc.title,
    intent: sc.intent,
    beats: sc.beats.map((b) => ({ id: b.id, text: b.text, done: false })),
    cast: [],
    foreshadows: [],
    status: "draft",
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * 剧组装配：产出 RpSetup+greeting（与试跑包同一管线）。
 * 台账块 = 剧组正典快照（+可选借用作品级，标注来源）+ 副本伏笔欠账。
 */
export function assembleRoom(input: RoomAssemblyInput): RoomAssembly {
  const { room, project, characters, persona, loreEntries, roomCanon, projectCanon } = input;
  const cfg = room.config;
  const snap = room.script ?? EMPTY_SNAP;
  const progress = room.progress ?? {};
  const advance = storyAdvance(snap, progress);
  const cur = roomCurrentScene(room);

  // ---- 台账块（剧组独立正典为核心） ----
  const canonParts: string[] = [];
  const roomSnap = ledgerSnapshot(roomCanon, { maxChars: 700 });
  if (roomSnap.text) canonParts.push(roomSnap.text);
  if (cfg?.borrowProjectLedger && projectCanon && projectCanon.length > 0) {
    const borrow = ledgerSnapshot(projectCanon, { maxChars: 400 });
    if (borrow.text) canonParts.push(`（以下借自作品级台账）\n${borrow.text}`);
  }
  const debt = snapshotDebt(snap, roomCanon.filter((r) => r.type === "foreshadow").map((r) => r.content));
  const debtText = snapshotDebtText(debt);
  const ledgerBlock = [canonParts.join("\n\n"), debtText].filter(Boolean).join("\n\n") || undefined;

  // ---- 世界设定摘录（constant 词条）与世界观一句 ----
  const enabled = loreEntries.filter((e) => e.enabled);
  const loreBlock = enabled
    .map((e) => (e.constant ? e.content : ""))
    .filter((c) => c.trim())
    .join("\n");
  const worldview =
    (project?.bible.fields ?? [])
      .filter((f) => /世界|设定/.test(f.label))
      .map((f) => f.value.trim())
      .filter(Boolean)
      .join("\n") || undefined;
  const loreSettings = project?.lorebook ?? { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true };
  // v3.2 构思档案要素块（固定注入）：作者定稿的题材/文风/视角/世界/主角/冲突。
  // 纯函数确定性输出——档案不动则字节不动，配合 rp.ts 的分段位置吃满前缀缓存。
  const bibleBlock = bibleElementsBlock(project?.bible.fields ?? []);
  // v3.1-⑤ 用户名取决于画像：有画像用画像名，无画像回落剧组存量名（旧组兼容）
  const uname = persona?.name?.trim() || room.userName || "读者";
  const personaBlock = persona ? personaPromptBlock(persona) : undefined;
  // 玩家实名指令：画像名与对话历史里的旧称呼（老 greeting/旧用户名）冲突时，以此为准
  const userNameHint = persona
    ? [
        `【玩家实名】用户扮演的玩家角色名叫「{{user}}」。`,
        "- 你的叙述与任何角色的台词中，一律用「{{user}}」称呼玩家。",
        "- 若上方对话历史或开场白里出现过别的称呼，那是旧记录：从现在起统一改称「{{user}}」，不要在正文里解释或提及这次改名。",
      ].join("\n")
    : undefined;

  const lead: Character | null = cfg && cfg.charId ? characters.find((c) => c.id === cfg.charId) ?? null : null;
  const charNameOf = (c: Character): string => c.name || "角色";

  // ---- 沙盒组：无副本，旁白自由开场 ----
  if (!cur) {
    const greeting = `暮色四合，故事尚未落笔。（自由即兴剧组：没有剧本约束，${uname} 的每个动作都会留下痕迹。）`;
    return {
      setup: {
        charName: "旁白",
        userName: uname,
        description: worldview ?? "自由即兴场景：以环境反应与配角插叙回应 {{user}}。",
        bibleBlock,
        personaBlock,
        userNameHint,
        authorNote: "（自由即兴组：无剧本。保持世界一致，把主动权交给 {{user}}。）",
        ledgerBlock,
        pace: room.pace,
        loreEntries: enabled,
        loreSettings,
      },
      greeting,
      baseNote: "（自由即兴组：无剧本。保持世界一致，把主动权交给 {{user}}。）",
      sceneTitle: "自由即兴",
    };
  }

  // ---- 剧本组：与 ST 试跑包同一装配管线（greeting=当前幕目标+节拍+前情） ----
  const chapterTitle = cur.path.split(" › ").slice(0, -2).join(" › ") || undefined;
  const castNames = Array.from(new Set(characters.map((c) => charNameOf(c))));
  const scene = pseudoScene(cur);
  const chapter = chapterTitle
    ? ({ ...pseudoScene(cur), id: "", title: chapterTitle, level: "chapter", intent: "", beats: [] } as unknown as import("../core/types").OutlineNode)
    : undefined;
  const built = buildTrialPack({
    packName: `${room.name ?? "剧组"} · ${cur.title}`,
    scene,
    chapter,
    castNames,
    userName: uname,
    userPersona: personaBlock,
    prevSummary: room.rollingSummary?.trim() || undefined,
    loreBlock: loreBlock || undefined,
    cardJson: lead ? exportCardV2(lead) : undefined,
    worldview,
  });

  // 剧本块 + 进展备忘行（场记每楼标进度后，此处每轮自动反映最新进度）
  const memo = progressMemoText(advance);
  const scriptText = [scriptBlock(snap, progress, advance, 1, 2), memo].filter(Boolean).join("\n");

  let setup: RpSetup;
  if (lead) {
    setup = {
      charName: charNameOf(lead),
      userName: uname,
      description: [
        lead.profile.appearance.trim() ? `外貌：${lead.profile.appearance.trim()}` : "",
        lead.profile.background,
      ]
        .filter(Boolean)
        .join("\n"),
      personality: lead.profile.personality || undefined,
      scenario: lead.scenario || undefined,
      exampleDialogue: lead.profile.exampleLines.join("\n") || undefined,
      bibleBlock,
      personaBlock,
      userNameHint,
      authorNote: built.authorNote,
      ledgerBlock,
      scriptBlock: scriptText || undefined,
      pace: room.pace as TheaterPace | undefined,
      loreEntries: enabled,
      loreSettings,
    };
  } else {
    const narrator = synthesizeNarratorCard({ scene, chapter, castNames, worldview }, built.greeting);
    const nd = (narrator as { data?: Record<string, unknown> }).data ?? {};
    setup = {
      charName: typeof nd.name === "string" && nd.name ? nd.name : "旁白",
      userName: uname,
      description: typeof nd.description === "string" ? nd.description : "",
      scenario: typeof nd.scenario === "string" ? nd.scenario || undefined : undefined,
      bibleBlock,
      personaBlock,
      userNameHint,
      authorNote: built.authorNote,
      ledgerBlock,
      scriptBlock: scriptText || undefined,
      pace: room.pace as TheaterPace | undefined,
      loreEntries: enabled,
      loreSettings,
    };
  }
  return {
    setup,
    greeting: built.greeting,
    baseNote: built.authorNote,
    sceneTitle: cur.title,
  };
}

/** 新建剧组行（不落库；id 由调用方 repos.uid() 传入保持可测） */
export function newRoom(input: {
  id: string;
  projectId: string;
  name: string;
  userName: string;
  pace: TheaterPace;
  scopeMode: TheaterScope;
  sandbox: boolean;
  script: ScriptSnapshot;
  charId: string;
  personaId: string;
  budgetTokens: number;
  reserveTokens: number;
  ledgerCadence: number;
  borrowProjectLedger: boolean;
  chapterIds?: string[];
  now: number;
}): RPSession {
  return {
    id: input.id,
    projectId: input.projectId,
    nodeId: null,
    cast: [],
    userName: input.userName,
    messages: [],
    status: "testing",
    createdAt: input.now,
    updatedAt: input.now,
    kind: "theater",
    name: input.name,
    pace: input.pace,
    scopeMode: input.scopeMode,
    sandbox: input.sandbox,
    script: input.script,
    progress: {},
    config: {
      charId: input.charId,
      personaId: input.personaId,
      budgetTokens: input.budgetTokens,
      reserveTokens: input.reserveTokens,
      ledgerCadence: input.ledgerCadence,
      borrowProjectLedger: input.borrowProjectLedger,
      ...(input.chapterIds && input.chapterIds.length > 0 ? { chapterIds: input.chapterIds } : {}),
    },
  };
}

/** 剧组列表展示排序：活跃倒序 */
export function roomSort(rooms: RPSession[]): RPSession[] {
  return [...rooms].sort((a, b) => b.updatedAt - a.updatedAt);
}
