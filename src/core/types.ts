// ============================================================
// story-studio 核心域模型（共享契约）
// 所有模块只许 `import type` 引用本文件；修改本文件须由集成者（主代理）统一执行。
// 设计原则（见《AI小说创作工具-规划.md》）：
//   - 大纲树 = “意图”的唯一事实源；台账 = “已发生事实”的唯一事实源；RP 记录是底稿。
//   - 一切 AI 产出先做提案（proposed），用户确认后才生效（confirmed）。
//   - 允许残缺：任何大纲节点可独立存在、独立试跑。
// ============================================================

export type ID = string;

// ---------- 项目 ----------
export interface Project {
  id: ID;
  title: string;
  synopsis: string; // 一句话梗概（访谈产物，可随时更新）
  bible: StoryBible; // 构思档案直接内嵌（体量小、整体版本化方便）
  lorebook: LorebookSettings; // 世界书全局参数
  // v4 全局资产库：人物卡/世界书是全局数据，作品侧只持「选用列表」。
  // 可选字段（零迁移）：缺失 ⇔ 旧数据，语义 = 只用自有资产（projectId 命中本作品的行）。
  castIds?: ID[]; // 选用的外部人物卡（Character.id；自有卡不必列，恒可见）
  loreIds?: ID[]; // v4 选用外部世界书词条（LoreEntry.id）——v5 弃用，仅旧数据读侧兼容，不再写入
  // v5 世界书「整本书」：作品侧改为按「书」选用（多本，有序）。
  loreBookIds?: ID[]; // 选用的世界书（LoreBook.id，有序——按此顺序拼接各书启用词条注入）
  createdAt: number;
  updatedAt: number;
}

// ---------- 构思档案 Story Bible ----------
export type BibleFieldStatus = "empty" | "rough" | "confirmed" | "stale";

export interface BibleField {
  key: string; // 稳定键，如 "genre" / "premise"
  label: string; // 中文名，如「题材与类型」
  group: string; // 分组，如「定位」「世界」「人物」「结构」
  value: string;
  status: BibleFieldStatus;
  deps: string[]; // 依赖的其他字段 key；上游变更后本字段标 stale
}

export interface BibleRevision {
  at: number;
  note: string; // 本次修订摘要（谁改的/访谈轮次）
  fields: BibleField[]; // 修订前快照
}

export interface StoryBible {
  fields: BibleField[];
  revisions: BibleRevision[];
}

// ---------- 大纲树 ----------
export type OutlineLevel = "volume" | "chapter" | "scene" | "beat";
export type OutlineStatus = "idea" | "draft" | "refined" | "tested" | "locked";

export interface Beat {
  id: ID;
  text: string;
  done?: boolean; // 试跑后由偏差分析标记
}

export interface ForeshadowLink {
  id: ID;
  setup: string; // 伏笔内容描述
  payoffIn?: ID | null; // 计划回收于哪个节点
  status: "planted" | "paid" | "abandoned";
}

export interface OutlineNode {
  id: ID;
  projectId: ID;
  parentId: ID | null;
  level: OutlineLevel; // 与父节点的关系：父.level 必须是更粗一级（UI 层校验）
  order: number; // 同父兄弟排序
  title: string;
  intent: string; // 本节点的叙事目的（一段话）
  beats: Beat[]; // scene 层为主，任何层都可挂
  cast: ID[]; // 出场角色 Character.id
  location?: string;
  timepoint?: string; // 故事内时间标签
  pov?: string; // 视角角色 Character.id 或自由文本
  foreshadows: ForeshadowLink[];
  status: OutlineStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

// ---------- 人物 ----------
export type CharacterSource = "st-import" | "manual" | "ai";
export type CardFormat = "v1" | "v2" | "v3" | "internal";

export interface CharacterProfile {
  appearance: string;
  personality: string;
  background: string;
  speechStyle: string;
  exampleLines: string[];
}

export interface Character {
  id: ID;
  projectId: ID; // 主场作品（v4 起仅溯源用：'' = 全局建卡）；可见性由 Project.castIds 选用列表决定
  name: string;
  profile: CharacterProfile;
  scenario?: string;
  greeting?: string; // first_mes
  mesExample?: string; // 原始对话示例文本
  source: CharacterSource;
  cardFormat: CardFormat;
  rawCard?: unknown; // 原始 ST 卡 JSON 原样保留（roundtrip 无损）
  createdAt: number;
  updatedAt: number;
}

// ---------- 世界书（内部规范化形态）----------
export interface LoreEntry {
  id: ID;
  projectId: ID; // 主场作品（v4 起仅溯源用：'' = 全局建词条）；v5 起可见性由所属书决定
  bookId?: ID; // v5：所属世界书（LoreBook.id）；缺失 ⇔ 旧散装词条（首开时归入「旧版词条」书）
  uid: number; // ST 语义里的整型 id
  comment: string; // 词条名/备注
  content: string;
  keys: string[]; // 主键（触发词）
  secondaryKeys: string[]; // 副键（配合 selective）
  constant: boolean; // 蓝灯：始终注入
  selective: boolean; // 副键逻辑生效
  caseSensitive: boolean;
  matchWholeWord: boolean;
  position: "before_char" | "after_char";
  order: number; // insertion_order，越小越先
  depth: number | null; // null=跟随默认扫描深度；n=注入到倒数第 n 条消息处
  sticky: number | null;
  cooldown: number | null;
  probability: number; // 0-100
  useProbability: boolean;
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  excludeRecursion: boolean; // 其内容不参与递归扫描（ST: exclusion 语义简化）
  preventRecursion: boolean; // 命中后阻止其他词条递归扫描
  enabled: boolean;
  extensions: Record<string, unknown>;
}

export interface LorebookSettings {
  scanDepth: number; // 扫描最近多少条消息
  tokenBudget: number; // 世界书总预算
  recursiveScanning: boolean;
}

/** v5 世界书「整本书」管理单元：一本书 = 一个可整体导入/选用/导出/删除的单元。
 *  书本体存 `db.meta`（key=`lorebook:<id>`，value 即本接口）；词条仍是 loreEntries 表里的独立行，
 *  靠 LoreEntry.bookId 归属本书。启用/停用整本走 book.enabled，注入侧再与词条级 enabled 做与。 */
export interface LoreBook {
  id: ID;
  name: string;
  desc?: string;
  enabled: boolean; // 整本启用/停用总开关
  settings: LorebookSettings;
  createdAt: number;
  updatedAt: number;
}

// ---------- ST 原始格式（导入中间形态） ----------
// 宽容形态：normalizeLorebook() 的输入是任意 unknown，输出这个规整形态
export interface RawLoreEntry {
  uid?: number;
  keys: string[];
  secondaryKeys: string[];
  content: string;
  comment?: string;
  constant?: boolean;
  selective?: boolean;
  caseSensitive?: boolean | null;
  matchWholeWords?: boolean | null;
  /** ST 全局格式：0=before_char 1=after_char；embedded lorebook：同义 */
  position?: number | "before_char" | "after_char";
  insertionOrder?: number;
  enabled?: boolean;
  depth?: number | null;
  sticky?: number | null;
  cooldown?: number | null;
  probability?: number | null;
  useProbability?: boolean | null;
  group?: string | null;
  groupOverride?: boolean | null;
  groupWeight?: number | null;
  excludeRecursion?: boolean;
  preventRecursion?: boolean;
  extensions?: Record<string, unknown>;
}

export interface RawLorebook {
  name?: string;
  scanDepth?: number;
  tokenBudget?: number;
  recursiveScanning?: boolean;
  entries: RawLoreEntry[];
}

export interface ParsedCard {
  format: "v1" | "v2" | "v3";
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  mesExample: string;
  alternateGreetings: string[];
  creatorNotes?: string;
  systemPrompt?: string;
  postHistoryInstructions?: string;
  tags: string[];
  creator?: string;
  characterVersion?: string;
  extensions: Record<string, unknown>;
  embeddedBook: RawLorebook | null; // 卡内嵌 character_book（已规范化）
  raw: unknown; // 原始 JSON（roundtrip 用）
}

// ---------- RP 会话（M5 引擎使用，M0 先落表） ----------
export interface RPMessage {
  id: ID;
  role: "user" | "char" | "system";
  name: string;
  content: string;
  createdAt: number;
  reasoning?: string; // 推理模型的思维链（可折叠查看；provider 未返回则无）
  notes?: string[]; // 场记 agent 挂在本条上的活动（工具调用/进度标记），随消息持久
}

// ---------- RP 剧场：剧本副本与剧组（v3 剧场独立化） ----------
export type TheaterPace = "tight" | "loose"; // 紧凑=强引导快推 / 舒缓=弱引导允许跑题
export type TheaterScope = "full" | "chapters"; // 全剧（感知主纲更新）/ 章选（试跑，不敏感）
export type TheaterSandbox = boolean;

export interface ScriptBeatRef {
  id: string; // 主纲 Beat.id 的副本引用（只读引用；标记只写剧组 progress）
  text: string;
}

/** 剧组创建/同步时的剧本快照：此后聊天只认副本，主纲改动不自动渗透 */
export interface ScriptSnapshot {
  sourceTitle: string;
  takenAt: number;
  nodesUpdatedAt: number; // 快照时全部节点的最大 updatedAt（检测主纲变化的依据）
  scenes: {
    nodeId: ID | null; // 主纲节点 id（同步/定位用；永不回写）
    path: string; // 卷/章/幕 全路径
    title: string;
    intent: string;
    beats: ScriptBeatRef[];
    foreshadows: { id: string; setup: string }[];
    /** v8-B 全书任务卡：自卷到父章的祖先链（不含本幕；intent 为空的层不记）。
     *  只进场记 read_outline 工具返回，不进每轮 system。老快照无此字段=不渲染（向后兼容）。 */
    ancestors?: { title: string; intent: string }[];
  }[];
}

export interface RPSession {
  id: ID;
  projectId: ID;
  nodeId?: ID | null; // 绑定的大纲节点（可空=自由试跑）
  cast: ID[]; // 出场 Character.id
  userName: string; // {{user}}
  messages: RPMessage[];
  rollingSummary?: string; // 远期记忆滚动摘要
  /** v3.1-⑥ 折叠留底：被滚动摘要折叠掉的旧回合永不真删，只挪到这里（只增不读注入） */
  messagesArchive?: RPMessage[];
  status: "testing" | "canon" | "abandoned";
  createdAt: number;
  updatedAt: number;
  // ---- RP 剧场剧组扩展（全部可选：旧试跑会话天然不属于剧场） ----
  kind?: "theater"; // 有 = 剧场剧组（左栏列表按此过滤）
  name?: string; // 剧组名（列表展示/重命名）
  pace?: TheaterPace;
  scopeMode?: TheaterScope;
  sandbox?: TheaterSandbox; // 自由即兴组：无剧本
  script?: ScriptSnapshot; // 剧本副本（沙盒组=空 scenes）
  progress?: Record<string, "done" | "skipped">; // 副本节拍完成标记（key=ScriptBeatRef.id；永不回写主纲）
  /** v8-A 手动故事指针：副本 scenes 下标，作者亲指"当前演这一幕"。
   *  undefined/越界=回落自动推导（按 progress 标记）。不写节拍的剧组以此获得诚实进度。 */
  scenePointer?: number;
  /** v8-B 导演简报：场记整理时经 set_brief 工具写下一段 ≤150 字的续写引导
   *  （当前幕意图+最该照顾的事实）；装配拼在剧本块尾。空=无简报。 */
  brief?: string;
  config?: {
    // 剧组级配置快照（开台时由全局 prefs 落一份；面板可改，切剧组互不污染）
    charId: string; // "" = 旁白无卡
    personaId: string; // "" = 不设
    budgetTokens: number;
    reserveTokens: number;
    ledgerCadence: number; // 每 N 个用户楼层自动整理台账；0=关；1=每楼自动（v3.1 默认）
    borrowProjectLedger: boolean; // 本剧组正典之外借用作品级台账
    chapterIds?: ID[]; // chapters 模式的所选章（full/sandbox 无）
    agentEnabled?: boolean; // 场记工具（undefined=true）
    cadenceMark?: number; // 上次楼层整理时的用户楼层数（触发游标）
  };
}

// ---------- 台账（M6 使用，M0 先落表） ----------
export type LedgerType = "event" | "item" | "relation" | "foreshadow" | "worldstate";
export type LedgerStatus = "proposed" | "confirmed" | "rejected";

export interface LedgerRecord {
  id: ID;
  projectId: ID;
  type: LedgerType;
  content: string;
  actors: string[]; // 角色名/道具名（不强制外键）
  provenance?: { sessionId: ID; msgId: ID }; // 溯源：产生它的 RP 消息
  status: LedgerStatus;
  createdAt: number;
  roomId?: ID; // 剧场剧组正典绑定：有 = 只属于该剧组（新剧组从空白正典开始）；无 = 作品级台账
}

// ---------- 用户画像（全局，跨作品；{{user}} 在不同故事中的形象） ----------
export type PersonaSource = "manual" | "st-import";

export interface Persona {
  id: ID;
  name: string; // {{user}} 显示名
  description: string; // 画像正文（身份/背景/与角色的关系）
  appearance: string; // 外貌（可空）
  personality: string; // 性格（可空）
  notes: string; // 附加说明（禁忌/使用备注）
  isDefault: boolean; // 试跑默认选中的画像（全局至多一条）
  source: PersonaSource;
  rawCard?: unknown; // 导入时的原始 JSON（roundtrip 参考）
  createdAt: number;
  updatedAt: number;
}

// ---------- 应用配置（localStorage 持久，不进 Dexie） ----------
export interface ModelEndpoint {
  baseURL: string; // 如 https://api.deepseek.com
  model: string;
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AppConfig {
  writer: ModelEndpoint; // 创作模型（RP/大纲草稿）
  analyzer: ModelEndpoint; // 分析模型（抽取/判断/整理）
  // v3.1-⑤：全局 userName 已删除——用户名取决于所用画像（persona）的名字
}

// ---------- AI 通用 ----------
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
