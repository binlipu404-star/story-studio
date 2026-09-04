// ============================================================
// story-studio M0 — Repositories：Dexie CRUD 门面
// 页面层读写 IndexedDB 的唯一入口：
//   - 全部函数返回 Promise；
//   - id 由 uid() 生成，createdAt/updatedAt/revision 由本层统一维护；
//   - 先读后写有分配语义的写入（order 追加、uid 取号、级联删除）放进
//     Dexie 事务，保证原子性与并发标签页下不重号。
// ============================================================
import Dexie from "dexie";
import { db } from "./db";
import { DEFAULT_BIBLE_FIELDS, DEFAULT_LOREBOOK_SETTINGS } from "./templates";
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
    schema: 1,
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

/** 级联删除：作品 + 大纲/人物/世界书/会话/台账全部关联数据，单事务原子完成。 */
export async function deleteProjectCascade(id: ID): Promise<void> {
  await db.transaction(
    "rw",
    [db.projects, db.outlineNodes, db.characters, db.loreEntries, db.sessions, db.ledger],
    async () => {
      await db.outlineNodes.where("projectId").equals(id).delete();
      await db.characters.where("projectId").equals(id).delete();
      await db.loreEntries.where("projectId").equals(id).delete();
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
// 人物
// ============================================================

function emptyProfile(): CharacterProfile {
  return { appearance: "", personality: "", background: "", speechStyle: "", exampleLines: [] };
}

/** 新增人物：默认空 profile/state、source="manual"、cardFormat="internal"；partial 覆盖默认。 */
export async function addCharacter(projectId: ID, partial: CharacterPatch = {}): Promise<Character> {
  const now = Date.now();
  const character: Character = {
    name: "",
    profile: emptyProfile(),
    state: "",
    source: "manual",
    cardFormat: "internal",
    ...partial,
    id: uid(),
    projectId,
    createdAt: now,
    updatedAt: now,
  };
  character.profile = { ...emptyProfile(), ...(partial.profile ?? {}) }; // 防残缺 profile
  await db.characters.add(character);
  return character;
}

/** 人物列表：按创建时间稳定排序。 */
export async function listCharacters(projectId: ID): Promise<Character[]> {
  const rows = await db.characters.where("projectId").equals(projectId).toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name, "zh-CN"));
}

/** 局部更新人物：updatedAt 刷新。返回更新后整条（不存在则 undefined）。 */
export async function updateCharacter(id: ID, patch: CharacterPatch): Promise<Character | undefined> {
  await db.characters.update(id, { ...patch, updatedAt: Date.now() });
  return db.characters.get(id);
}

export async function removeCharacter(id: ID): Promise<void> {
  await db.characters.delete(id);
}

// ============================================================
// 世界书
// ============================================================

/** 下一个 ST 语义整型 uid：现有最大值 +1（走 [projectId+uid] 索引取尾）。 */
export async function nextUid(projectId: ID): Promise<number> {
  const last = await db.loreEntries
    .where("[projectId+uid]")
    .between([projectId, Dexie.minKey], [projectId, Dexie.maxKey])
    .last();
  return (last?.uid ?? 0) + 1;
}

/**
 * 新增词条：默认全字段（order 追加到尾部、uid 自动取号、probability=100、enabled=true…），
 * partial 可覆盖任意非系统字段（如 ST 导入时显式给 uid/order）。取号+追加在事务内。
 */
export async function addLoreEntry(projectId: ID, partial: LoreEntryPatch = {}): Promise<LoreEntry> {
  return db.transaction("rw", db.loreEntries, async () => {
    const existing = await db.loreEntries.where("projectId").equals(projectId).toArray();
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
      projectId,
      uid: await nextUid(projectId),
      order: maxOrder + 1,
    };
    if (partial.uid !== undefined) entry.uid = partial.uid; // 显式 uid（导入场景）优先
    if (partial.order !== undefined) entry.order = partial.order;
    await db.loreEntries.add(entry);
    return entry;
  });
}

/** 词条列表：按 order（insertion_order）升序。 */
export async function listLoreEntries(projectId: ID): Promise<LoreEntry[]> {
  const rows = await db.loreEntries.where("projectId").equals(projectId).toArray();
  return rows.sort((a, b) => a.order - b.order || a.uid - b.uid);
}

/** 局部更新词条（LoreEntry 契约无时间戳字段，故不动任何时间）。返回更新后整条。 */
export async function updateLoreEntry(id: ID, patch: LoreEntryPatch): Promise<LoreEntry | undefined> {
  await db.loreEntries.update(id, patch);
  return db.loreEntries.get(id);
}

export async function removeLoreEntry(id: ID): Promise<void> {
  await db.loreEntries.delete(id);
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

/** 台账列表：可按状态过滤（走 [projectId+status] 复合索引）；按 createdAt 升序。 */
export async function listLedger(projectId: ID, status?: LedgerStatus): Promise<LedgerRecord[]> {
  const rows = status
    ? await db.ledger.where("[projectId+status]").equals([projectId, status]).toArray()
    : await db.ledger.where("projectId").equals(projectId).toArray();
  return rows.sort((a, b) => a.createdAt - b.createdAt);
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

/** 会话列表：最近活跃在前。 */
export async function listSessions(projectId: ID): Promise<RPSession[]> {
  const rows = await db.sessions.where("projectId").equals(projectId).toArray();
  return rows.sort((a, b) => b.updatedAt - a.updatedAt);
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
