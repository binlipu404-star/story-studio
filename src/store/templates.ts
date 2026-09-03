// ============================================================
// story-studio M0 — 新项目默认模板（纯数据，零运行时依赖）
// 不 import src/st、src/ai 下任何东西：模板层与解析/AI 层运行时零交叉。
// ============================================================
import type { BibleField, LorebookSettings } from "../core/types";

/**
 * 构思档案默认字段。
 *
 * 依赖链设计（粗粒度，服务 M2 访谈的提问顺序与 stale 传播）：
 *
 *   genre（题材与类型）＝访谈起点，无上游，下游辐射最广：
 *     ├─ tone（基调与文风）        ← genre：文风选择首先受题材约束
 *     ├─ pov（叙事视角）           ← genre：题材决定视角惯例（悬疑限知/史诗多线）
 *     │    └─ tense（时态）        ← pov：人称与时态通常与视角一次性敲定
 *     └─ world_rules（世界规则与设定）← genre：规则围绕题材展开
 *          └─ era_place（时代与地点）  ← world_rules：先有规则，时代地点是其落地实例
 *
 *   protagonist（主角与欲望-障碍）← genre + world_rules：
 *     欲望-障碍必须长在题材与世界规则之上，否则冲突悬空。
 *     ├─ relationships（重要关系） ← protagonist：关系网围绕主角欲望组织
 *     └─ antagonist（对立力量）    ← protagonist + world_rules：
 *          对立力量是"障碍"的具体化，其手段受世界规则限制
 *
 *   core_conflict（核心冲突）  ← protagonist + antagonist：冲突＝欲望 × 对立力量
 *   premise（主线一句话）      ← core_conflict + world_rules：
 *     主线是核心冲突在指定世界中的展开过程（题示的示例依赖）
 *   ending（结局意向）         ← premise：结局是主线的收束点，主线一改结局意向必 stale
 *
 * 性质：无环；上游动→下游标 stale 的方向与访谈推进方向一致；
 * 刻意粗粒度——每字段只挂 1~2 个语义上强相关的上游，避免"全员依赖 genre"
 * 导致改题材就全员 stale 的噪音。
 *
 * status 全 "empty"、value 全空：模板只定义骨架，内容全部由访谈/手工填充。
 * 消费方（repos.createProject）必须深拷贝使用，禁止直接持有本数组。
 */
export const DEFAULT_BIBLE_FIELDS: BibleField[] = [
  // ---------- 定位 ----------
  { key: "genre",        label: "题材与类型",     group: "定位", value: "", status: "empty", deps: [] },
  { key: "tone",         label: "基调与文风",     group: "定位", value: "", status: "empty", deps: ["genre"] },
  { key: "pov",          label: "叙事视角",       group: "定位", value: "", status: "empty", deps: ["genre"] },
  { key: "tense",        label: "时态",           group: "定位", value: "", status: "empty", deps: ["pov"] },
  // ---------- 世界 ----------
  { key: "world_rules",  label: "世界规则与设定", group: "世界", value: "", status: "empty", deps: ["genre"] },
  { key: "era_place",    label: "时代与地点",     group: "世界", value: "", status: "empty", deps: ["world_rules"] },
  // ---------- 人物 ----------
  { key: "protagonist",  label: "主角与欲望-障碍", group: "人物", value: "", status: "empty", deps: ["genre", "world_rules"] },
  { key: "relationships", label: "重要关系",      group: "人物", value: "", status: "empty", deps: ["protagonist"] },
  { key: "antagonist",   label: "对立力量",       group: "人物", value: "", status: "empty", deps: ["protagonist", "world_rules"] },
  // ---------- 结构 ----------
  { key: "core_conflict", label: "核心冲突",      group: "结构", value: "", status: "empty", deps: ["protagonist", "antagonist"] },
  { key: "premise",      label: "主线一句话",     group: "结构", value: "", status: "empty", deps: ["core_conflict", "world_rules"] },
  { key: "ending",       label: "结局意向",       group: "结构", value: "", status: "empty", deps: ["premise"] },
];

/** 世界书全局参数默认值（与 ST 常见默认一致）。 */
export const DEFAULT_LOREBOOK_SETTINGS: LorebookSettings = {
  scanDepth: 4,
  tokenBudget: 2048,
  recursiveScanning: true,
};
