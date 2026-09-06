// ============================================================
// story-studio M0 — Repositories：Dexie CRUD 门面
// 页面层读写 IndexedDB 的唯一入口：
//   - 全部函数返回 Promise；
//   - id 由 uid() 生成，createdAt/updatedAt/revision 由本层统一维护；
//   - 先读后写有分配语义的写入（order 追加、uid 取号、级联删除）放进
//     Dexie 事务，保证原子性与并发标签页下不重号。
// ============================================================
import { db } from "./db";
import { DEFAULT_BIBLE_FIELDS, DEFAULT_LOREBOOK_SETTINGS } from "./templates";
import { filterVisible } from "../flow/library";
import type {
  Character,
  CharacterProfile,
  ID,
  LedgerRecord,
  LedgerStatus,
  LoreEntry,
  OutlineLevel,
  OutlineNode,
  OutlineStatus,
  Persona,
  Project,
  RPSession,
} from "../core/types";

// ---------- 入参补丁类型：剔除 id / 系统维护字段 ----------
export type ProjectPatch = Partial<Omit<Project, "id" | "createdAt" | "updatedAt">>;
export type OutlineNodePatch = Partial<
  Omit<OutlineNode, "id" | "projectId" | "createdAt" | "updatedAt" | "revision">
>;
export type CharacterPatch = Partial<Omit<Character, "id" | "projectId" | "createdAt" | "updatedAt">>;
export type LoreEntryPatch = Partial<Omit<LoreEntry, "id" | "projectId">>;
export type PersonaPatch = Partial<Omit<Persona, "id" | "createdAt" | "updatedAt">>;

// ---------- 主键 ----------

/**
 * 生成主键：优先 crypto.randomUUID；
 * 降级链：randomUUID → getRandomValues 手拼 v4 →（非安全上下文/老环境）Math.random。
 * 后两级碰撞概率对本工具（单机本地库）足够，且主键冲突会被 Dexie add 直接报错暴露。
 */
export function uid(): string {
  try {
    if (typeof crypto !== "undefined") {
      if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
      if (typeof crypto.getRandomValues === "function") {
        const b = crypto.getRandomValues(new Uint8Array(16));
        b[6] = (b[6] & 0x0f) | 0x40; // version 4
        b[8] = (b[8] & 0x3f) | 0x80; // variant 10x
        let hex = "";
        for (const byte of b) hex += byte.toString(16).padStart(2, "0");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      }
    }
  } catch {
    // 非安全上下文等异常：落到 Math.random 降级
  }
  const seg = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${seg()}${seg()}-${seg()}-4${seg().slice(1)}-a${seg().slice(1)}-${seg()}${seg()}${seg()}`;
}

// ============================================================
// 项目
// ============================================================

/** 新建作品：内嵌全新 bible（DEFAULT_BIBLE_FIELDS 深拷贝 + 空 revisions）、默认 lorebook、schema=1。 */
export async function createProject(title: string, synopsis: string): Promise<Project> {
  const now = Date.now();
  const project: Project = {
    id: uid(),
    title,
    synopsis,
    bible: {
      fields: DEFAULT_BIBLE_FIELDS.map((f) => ({ ...f, deps: [...f.deps] })),
      revisions: [],
    },
    lorebook: { ...DEFAULT_LOREBOOK_SETTINGS },
    createdAt: now,
    updatedAt: now,
  };
  await db.projects.add(project);
  return project;
}

/** 作品列表：按 updatedAt 倒序（最近更新在前）。 */
export async function listProjects(): Promise<Project[]> {
  return db.projects.orderBy("updatedAt").reverse().toArray();
}

export async function getProject(id: ID): Promise<Project | undefined> {
  return db.projects.get(id);
}

/** 局部更新作品；updatedAt 自动刷新。返回更新后的整条（不存在则 undefined）。 */
export async function updateProject(id: ID, patch: ProjectPatch): Promise<Project | undefined> {
  await db.projects.update(id, { ...patch, updatedAt: Date.now() });
  return db.projects.get(id);
}

/** 级联删除：作品 + 大纲/会话/台账。
 *  v4：人物卡/世界书是**全局资产库**，不随作品消亡——删作品只解除选用关系
 *  （Project 行本身消失，其 castIds/loreIds 随之消失），资产行保留在全局库。
 *  资产被删时由 removeCharacter/removeLoreEntry 负责跨作品摘除选用引用。 */
export async function deleteProjectCascade(id: ID): Promise<void> {
  await db.transaction(
    "rw",
    [db.projects, db.outlineNodes, db.sessions, db.ledger],
    async () => {
      await db.outlineNodes.where("projectId").equals(id).delete();
      await db.sessions.where("projectId").equals(id).delete();
      await db.ledger.where("projectId").equals(id).delete();
      await db.projects.delete(id);
    },
  );
}

// ============================================================
// 大纲树
// ============================================================

const LEVEL_RANK: Record<OutlineLevel, number> = { volume: 0, chapter: 1, scene: 2, beat: 3 };

/**
 * 新增大纲节点，order 追加到同级（同父）尾部。
 * 结构约束：parentId 为空时 level 必须是 "volume"（卷=根），反之 volume 不允许有父。
 */
export async function addNode(
  projectId: ID,
  parentId: ID | null,
  level: OutlineLevel,
  title: string,
): Promise<OutlineNode> {
  if (parentId === null && level !== "volume") {
    throw new Error(`addNode: 根节点（parentId=null）的 level 必须是 volume，收到 "${level}"`);
  }
  if (parentId !== null && level === "volume") {
    throw new Error("addNode: volume 是根级别，不能挂在父节点下");
  }
  return db.transaction("rw", db.outlineNodes, async () => {
    const siblings = await childrenOf(projectId, parentId); // 已按 order 升序
    const order = siblings.length > 0 ? siblings[siblings.length - 1].order + 1 : 0;
    const now = Date.now();
    const node: OutlineNode = {
      id: uid(),
      projectId,
      parentId,
      level,
      order,
      title,
      intent: "",
      beats: [],
      cast: [],
      foreshadows: [],
      status: "idea",
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await db.outlineNodes.add(node);
    return node;
  });
}

/**
 * 直接子节点，按 order 升序。
 * 注意：IndexedDB 复合键不接受 null，parentId=null 的根节点不进
 * [projectId+parentId] 索引；取根改走 [projectId+level]（根 ⇔ volume，
 * 由 addNode 的双向约束保证等价）。
 */
export async function childrenOf(projectId: ID, parentId: ID | null): Promise<OutlineNode[]> {
  const rows =
    parentId === null
      ? await db.outlineNodes.where("[projectId+level]").equals([projectId, "volume"]).toArray()
      : await db.outlineNodes.where("[projectId+parentId]").equals([projectId, parentId]).toArray();
  return rows.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
}

/** 某作品全部大纲节点（统计/全局视图用）：按层级→同级 order 排。 */
export async function listNodes(projectId: ID): Promise<OutlineNode[]> {
  const rows = await db.outlineNodes.where("projectId").equals(projectId).toArray();
  return rows.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.order - b.order || a.createdAt - b.createdAt,
  );
}

/** BFS 收集 rootId 及其全部后代 id（含 rootId 本身）。 */
export async function subtreeIds(projectId: ID, rootId: ID): Promise<string[]> {
  const result: string[] = [];
  const queue: ID[] = [rootId];
  while (queue.length > 0) {
    const cur = queue.shift() as ID;
    result.push(cur);
    const kids = await db.outlineNodes.where("[projectId+parentId]").equals([projectId, cur]).toArray();
    for (const kid of kids) queue.push(kid.id);
  }
  return result;
}

/** 局部更新节点：revision+1、updatedAt 刷新。返回更新后整条（不存在则 undefined）。 */
export async function updateNode(id: ID, patch: OutlineNodePatch): Promise<OutlineNode | undefined> {
  const current = await db.outlineNodes.get(id);
  if (!current) return undefined;
  await db.outlineNodes.update(id, { ...patch, revision: current.revision + 1, updatedAt: Date.now() });
  return db.outlineNodes.get(id);
}

/** 仅流转状态（idea/draft/…）：动 updatedAt 不动 revision（状态不算内容修订）。 */
export async function setNodeStatus(id: ID, status: OutlineStatus): Promise<OutlineNode | undefined> {
  await db.outlineNodes.update(id, { status, updatedAt: Date.now() });
  return db.outlineNodes.get(id);
}

/** 删除节点连同其整棵子树（subtreeIds BFS 后批量删）。 */
export async function removeNodeCascade(projectId: ID, id: ID): Promise<void> {
  await db.transaction("rw", db.outlineNodes, async () => {
    const ids = await subtreeIds(projectId, id);
    await db.outlineNodes.bulkDelete(ids);
  });
}

// ============================================================
// 人物（v4：全局资产库。projectId=主场作品（''=全局直建），
// 作品可见集 = 自有 ∪ Project.castIds 选用，见 flow/library.ts）
// ============================================================

function emptyProfile(): CharacterProfile {
  return { appearance: "", personality: "", background: "", speechStyle: "", exampleLines: [] };
}

/** 新增人物：ownerProjectId='' 表示从全局卡库直建（无主场作品）。
 *  默认空 profile、source="manual"、cardFormat="internal"；partial 覆盖默认。 */
export async function addCharacter(ownerProjectId: ID, partial: CharacterPatch = {}): Promise<Character> {
  const now = Date.now();
  const character: Character = {
    name: "",
    profile: emptyProfile(),
    source: "manual",
    cardFormat: "internal",
    ...partial,
    id: uid(),
    projectId: ownerProjectId,
    createdAt: now,
    updatedAt: now,
  };
  character.profile = { ...emptyProfile(), ...(partial.profile ?? {}) }; // 防残缺 profile
  await db.characters.add(character);
  return character;
}

function sortCharacters(rows: Character[]): Character[] {
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, "zh-CN"));
}

/** 全局卡库全量（顶层「人物卡」页）：按创建时间稳定排序。 */
export async function listAllCharacters(): Promise<Character[]> {
  return sortCharacters(await db.characters.toArray());
}

/** 作品可见卡 = 自有（projectId 命中）∪ 选用（castIds 命中）。
 *  所有作品侧页面唯一读入口；选用列表缺失（旧数据）⇔ 只用自有。悬空 id 自动忽略。 */
export async function listCharacters(projectId: ID): Promise<Character[]> {
  const [rows, project] = await Promise.all([db.characters.toArray(), db.projects.get(projectId)]);
  return filterVisible(sortCharacters(rows), projectId, project?.castIds);
}

/** 选用/取消选用一张全局卡（不校验存在性：读侧悬空容忍）。 */
export async function selectCharacter(projectId: ID, characterId: ID, on: boolean): Promise<void> {
  const p = await db.projects.get(projectId);
  if (!p) return;
  const cur = p.castIds ?? [];
  const next = on ? (cur.includes(characterId) ? cur : [...cur, characterId]) : cur.filter((x) => x !== characterId);
  await db.projects.update(projectId, { castIds: next, updatedAt: Date.now() });
}

/** 局部更新人物：updatedAt 刷新。返回更新后整条（不存在则 undefined）。 */
export async function updateCharacter(id: ID, patch: CharacterPatch): Promise<Character | undefined> {
  await db.characters.update(id, { ...patch, updatedAt: Date.now() });
  return db.characters.get(id);
}

/** 删除全局卡：同事务从所有作品的选用列表摘除引用（读侧本就悬空容忍，这里只是不留垃圾）。 */
export async function removeCharacter(id: ID): Promise<void> {
  await db.transaction("rw", [db.characters, db.projects], async () => {
    await db.characters.delete(id);
    for (const p of await db.projects.toArray()) {
      if (p.castIds?.includes(id)) {
        await db.projects.update(p.id, { castIds: p.castIds.filter((x) => x !== id) });
      }
    }
  });
}

// ============================================================
// 世界书（v4：全局资产库，语义同「人物」段——主场 + 选用列表）
// ============================================================

/** 全局库 uid 取号：全库最大值 +1（uid 是 ST 语义整型号，全局一条序列防撞）。
 *  零迁移：schema v4 只有 [projectId+uid] 复合索引，全表扫取最大（词条量级 ≤ 数千，可接受）。 */
export async function nextUid(): Promise<number> {
  const rows = await db.loreEntries.toArray();
  return rows.reduce((m, e) => Math.max(m, e.uid), 0) + 1;
}

/**
 * 新增词条：默认全字段（order 追加到**同主场**尾部、uid 全库取号、probability=100、enabled=true…），
 * partial 可覆盖任意非系统字段（如 ST 导入时显式给 uid/order）。取号+追加在事务内。
 * ownerProjectId='' 表示从全局词条库直建。
 */
export async function addLoreEntry(ownerProjectId: ID, partial: LoreEntryPatch = {}): Promise<LoreEntry> {
  return db.transaction("rw", db.loreEntries, async () => {
    const existing = await db.loreEntries.where("projectId").equals(ownerProjectId).toArray();
    const maxOrder = existing.reduce((m, e) => Math.max(m, e.order), -1);
    const entry: LoreEntry = {
      comment: "",
      content: "",
      keys: [],
      secondaryKeys: [],
      constant: false,
      selective: false,
      caseSensitive: false,
      matchWholeWord: false,
      position: "before_char",
      depth: null,
      sticky: null,
      cooldown: null,
      probability: 100,
      useProbability: false,
      group: "",
      groupOverride: false,
      groupWeight: 100,
      excludeRecursion: false,
      preventRecursion: false,
      enabled: true,
      extensions: {},
      ...partial,
      id: uid(),
      projectId: ownerProjectId,
      uid: await nextUid(),
      order: maxOrder + 1,
    };
    if (partial.uid !== undefined) entry.uid = partial.uid; // 显式 uid（导入场景）优先
    if (partial.order !== undefined) entry.order = partial.order;
    await db.loreEntries.add(entry);
    return entry;
  });
}

function sortLore(rows: LoreEntry[]): LoreEntry[] {
  return rows.sort((a, b) => a.order - b.order || a.uid - b.uid);
}

/** 全局词条库全量（顶层「世界书」页）：按 order 升序（insertion_order）。 */
export async function listAllLoreEntries(): Promise<LoreEntry[]> {
  return sortLore(await db.loreEntries.toArray());
}

/** 作品可见词条 = 自有 ∪ 选用（loreIds）。悬空 id 自动忽略。 */
export async function listLoreEntries(projectId: ID): Promise<LoreEntry[]> {
  const [rows, project] = await Promise.all([db.loreEntries.toArray(), db.projects.get(projectId)]);
  return filterVisible(sortLore(rows), projectId, project?.loreIds);
}

/** 选用/取消选用一条全局词条。 */
export async function selectLoreEntry(projectId: ID, entryId: ID, on: boolean): Promise<void> {
  const p = await db.projects.get(projectId);
  if (!p) return;
  const cur = p.loreIds ?? [];
  const next = on ? (cur.includes(entryId) ? cur : [...cur, entryId]) : cur.filter((x) => x !== entryId);
  await db.projects.update(projectId, { loreIds: next, updatedAt: Date.now() });
}

/** 局部更新词条（LoreEntry 契约无时间戳字段，故不动任何时间）。返回更新后整条。 */
export async function updateLoreEntry(id: ID, patch: LoreEntryPatch): Promise<LoreEntry | undefined> {
  await db.loreEntries.update(id, patch);
  return db.loreEntries.get(id);
}

/** 删除全局词条：同事务从所有作品的选用列表摘除引用。 */
export async function removeLoreEntry(id: ID): Promise<void> {
  await removeLoreEntries([id]);
}

/** 批量删除全局词条（全局页「删除视图内词条」用）：同事务摘除全部选用引用。 */
export async function removeLoreEntries(ids: ID[]): Promise<void> {
  const idSet = new Set(ids);
  await db.transaction("rw", [db.loreEntries, db.projects], async () => {
    await db.loreEntries.bulkDelete(ids);
    for (const p of await db.projects.toArray()) {
      if (p.loreIds?.some((x) => idSet.has(x))) {
        await db.projects.update(p.id, { loreIds: p.loreIds.filter((x) => !idSet.has(x)) });
      }
    }
  });
}

// ============================================================
// 台账
// ============================================================

/**
 * 批量落提案：addProposals 语义即"AI 产出先进提案区"，
 * 故强制 status="proposed"；缺失的 id/createdAt 由本层补齐。
 */
export async function addProposals(records: LedgerRecord[]): Promise<LedgerRecord[]> {
  const now = Date.now();
  const rows: LedgerRecord[] = records.map((r) => ({
    ...r,
    id: r.id || uid(),
    status: "proposed" as const,
    createdAt: r.createdAt > 0 ? r.createdAt : now,
  }));
  if (rows.length === 0) return rows;
  await db.ledger.bulkPut(rows);
  return rows;
}

/** 台账列表：可按状态过滤（走 [projectId+status] 复合索引）；按 createdAt 升序。
 *  roomId 给定 → 只返回绑定该剧组的（room-scoped 正典）；roomId==="*" → 只返回作品级（roomId 缺失）。 */
export async function listLedger(projectId: ID, status?: LedgerStatus, roomId?: ID | "*"): Promise<LedgerRecord[]> {
  const rows = status
    ? await db.ledger.where("[projectId+status]").equals([projectId, status]).toArray()
    : await db.ledger.where("projectId").equals(projectId).toArray();
  const scoped =
    roomId === "*" ? rows.filter((r) => !r.roomId) : roomId ? rows.filter((r) => r.roomId === roomId) : rows;
  return scoped.sort((a, b) => a.createdAt - b.createdAt);
}

/** 剧组正典直写：剧场场记/定时写入用，落 confirmed 且绑定 roomId（该剧组独立正典，不污染作品级台账）。 */
export async function addRoomCanon(records: LedgerRecord[]): Promise<LedgerRecord[]> {
  const now = Date.now();
  const rows: LedgerRecord[] = records.map((r) => ({
    ...r,
    id: r.id || uid(),
    status: "confirmed" as const,
    createdAt: r.createdAt > 0 ? r.createdAt : now,
  }));
  if (rows.length === 0) return rows;
  await db.ledger.bulkPut(rows);
  return rows;
}

/** 提案裁决：确认/驳回。返回更新后整条（不存在则 undefined）。 */
export async function decide(
  id: ID,
  decision: Extract<LedgerStatus, "confirmed" | "rejected">,
): Promise<LedgerRecord | undefined> {
  await db.ledger.update(id, { status: decision });
  return db.ledger.get(id);
}

/** 台账编辑：修正文/相关者（不动状态——裁决与修订分离）。 */
export async function editLedger(
  id: ID,
  patch: { content?: string; actors?: string[] },
): Promise<LedgerRecord | undefined> {
  await db.ledger.update(id, patch);
  return db.ledger.get(id);
}

/** 删除单条台账（剧组正典面板清理误写事实用；作品级台账慎用，UI 层负责 confirm）。 */
export async function deleteLedger(id: ID): Promise<void> {
  await db.ledger.delete(id);
}

// ============================================================
// 元数据（剧场自动写盘目录句柄等；句柄作纯 value，勿建索引）
// ============================================================

export async function metaGet<T>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key);
  return row?.value as T | undefined;
}

export async function metaPut(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

// ============================================================
// RP 会话
// ============================================================

/** 整条 put（消息内嵌，覆盖式保存）；updatedAt 由本层刷新。返回实际落库的整条。 */
export async function saveSession(session: RPSession): Promise<RPSession> {
  const now = Date.now();
  const row: RPSession = { ...session, createdAt: session.createdAt > 0 ? session.createdAt : now, updatedAt: now };
  await db.sessions.put(row);
  return row;
}

/**
 * v3.1-⑥ 事务内读-改-写（原子）：f 拿到的是**事务里最新的整行**，返回要落库的整行。
 * 场记/聊天/配置多路并发写同一剧组时，所有调用方都走这里就不会互相覆盖
 * （谁先谁后取决于调用序；行内容永远基于最新库态合并）。
 */
export async function updateSession(
  id: ID,
  f: (cur: RPSession) => RPSession,
): Promise<RPSession | undefined> {
  return db.transaction("rw", db.sessions, async () => {
    const cur = await db.sessions.get(id);
    if (!cur) return undefined;
    const next: RPSession = { ...f(cur), updatedAt: Date.now() };
    await db.sessions.put(next);
    return next;
  });
}

/** 会话列表：最近活跃在前。 */
export async function listSessions(projectId: ID): Promise<RPSession[]> {
  const rows = await db.sessions.where("projectId").equals(projectId).toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 全部会话（剧场左栏跨作品列表）：最近活跃在前。 */
export async function listAllSessions(): Promise<RPSession[]> {
  const rows = await db.sessions.toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 单条会话（剧场按 id 载入，跨作品）。 */
export async function getSession(id: ID): Promise<RPSession | undefined> {
  return db.sessions.get(id);
}

/** 删除会话（剧场剧组删除；连带清掉该剧组绑定的台账行，正典随剧组消亡）。单事务原子。 */
export async function deleteSession(id: ID): Promise<void> {
  await db.transaction("rw", [db.sessions, db.ledger], async () => {
    await db.sessions.delete(id);
    await db.ledger.where("roomId").equals(id).delete();
  });
}

/** 清空本剧组正典（剧场「重新开始」整组重来；不动作品级台账、不动剧组行本身）。返回删除条数。 */
export async function clearRoomCanon(roomId: ID): Promise<number> {
  const keys = await db.ledger.where("roomId").equals(roomId).primaryKeys();
  await db.ledger.bulkDelete(keys);
  return keys.length;
}

// ============================================================
// 用户画像（全局，跨作品；{{user}} 形象管理）
// ============================================================

/** 画像表守卫：页面若还跑着 v2 之前的旧存储层（Dexie 单例是模块级旧实例），
 *  给出可操作提示，而不是裸的 undefined.reading 'add'。 */
function personasTable(): typeof db.personas {
  const t = db.personas as typeof db.personas | undefined;
  if (!t) {
    throw new Error(
      "画像表（v2）未加载：本页仍运行旧版存储层。请按 F5 刷新；若仍失败，关闭其它打开 story-studio 的浏览器标签页后再刷新。",
    );
  }
  return t;
}

/** 新增画像：默认空字段、source="manual"、isDefault=false；partial 覆盖默认。 */
export async function addPersona(partial: PersonaPatch = {}): Promise<Persona> {
  const now = Date.now();
  const persona: Persona = {
    name: "",
    description: "",
    appearance: "",
    personality: "",
    notes: "",
    isDefault: false,
    source: "manual",
    ...partial,
    id: uid(),
    createdAt: now,
    updatedAt: now,
  };
  await personasTable().add(persona);
  return persona;
}

/** 设为默认画像：先全表清 default，再置目标（单事务）。 */
export async function setDefaultPersona(id: ID): Promise<void> {
  const P = personasTable();
  await db.transaction("rw", P, async () => {
    await P.where("id").noneOf([id]).modify({ isDefault: false });
    await P.update(id, { isDefault: true, updatedAt: Date.now() });
  });
}

/** 画像列表：最近更新在前。 */
export async function listPersonas(): Promise<Persona[]> {
  const rows = await personasTable().toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 局部更新画像：updatedAt 刷新；返回更新后整条（不存在则 undefined）。 */
export async function updatePersona(id: ID, patch: PersonaPatch): Promise<Persona | undefined> {
  const P = personasTable();
  await P.update(id, { ...patch, updatedAt: Date.now() });
  return P.get(id);
}

export async function removePersona(id: ID): Promise<void> {
  await personasTable().delete(id);
}
