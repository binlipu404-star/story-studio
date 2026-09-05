// ============================================================
// story-studio M0 — Dexie(IndexedDB) 存储层
// 约定：
//   - dexie 的运行时 import 只出现在本文件与 repos.ts；
//   - 类型一律 `import type` 自 ../core/types（共享契约，禁止改动）。
// ============================================================
import Dexie, { type Table } from "dexie";
import type {
  Character,
  LedgerRecord,
  LoreEntry,
  OutlineNode,
  Persona,
  Project,
  RPSession,
} from "../core/types";

/**
 * 主数据库：表名与 core/types 域实体一一对应。
 *
 * 字段用 `declare` 而非 `x!: Table<...>`：本 tsconfig 开启了
 * useDefineForClassFields:true，子类中未初始化的 `!` 字段可能编译成
 * defineProperty(x, undefined)，把 Dexie 在构造期装好的表属性覆掉（常见坑）。
 * `declare` 只做类型声明、运行时零发射，表属性完全交给 Dexie 基类安装。
 *
 * 这些 `Table<T, string>` 字段即对外的类型化表访问器（db.projects 等），
 * 页面层不直接用它们，统一经 repos.ts 门面。
 */
export class StoryStudioDB extends Dexie {
  declare projects: Table<Project, string>;
  declare outlineNodes: Table<OutlineNode, string>;
  declare characters: Table<Character, string>;
  declare loreEntries: Table<LoreEntry, string>;
  declare sessions: Table<RPSession, string>;
  declare ledger: Table<LedgerRecord, string>;
  declare meta: Table<{ key: string; value: unknown }, string>;
  declare personas: Table<Persona, string>;

  constructor() {
    super("story-studio");
    // 复合索引说明：
    //   [projectId+parentId] / [projectId+level]：大纲树按作品取子级、按层取节点；
    //     注意 IndexedDB 复合键不接受 null——根节点(parentId=null)不入
    //     [projectId+parentId] 索引，取根走 [projectId+level]="volume"（见 repos.childrenOf）。
    //   [projectId+uid]：世界书按 ST 语义的整型 uid 排序/取号。
    //   [projectId+status]：台账按状态过滤（proposed/confirmed/rejected）。
    this.version(1).stores({
      projects: "id, updatedAt",
      outlineNodes: "id, projectId, [projectId+parentId], [projectId+level]",
      characters: "id, projectId",
      loreEntries: "id, projectId, [projectId+uid]",
      sessions: "id, projectId",
      ledger: "id, projectId, [projectId+status]",
    });
    // v2：用户画像库（全局跨作品，无 projectId）
    this.version(2).stores({ personas: "id, updatedAt" });
    // v3：剧场独立化——台账按剧组绑定（roomId 稀疏索引：作品级行无此键，不入索引）；
    //     会话按 kind 过滤剧场剧组。新增均为可选字段，老数据无需迁移。
    this.version(3).stores({
      sessions: "id, projectId, kind",
      ledger: "id, projectId, [projectId+status], roomId",
    });
    // v4：元数据表（剧场自动写盘的目录句柄等；句柄作纯 value，勿建索引）
    this.version(4).stores({ meta: "key" });
  }
}

/** 全局唯一 Dexie 实例（浏览器 IndexedDB 连接本就单库单连接）。 */
export const db = new StoryStudioDB();
