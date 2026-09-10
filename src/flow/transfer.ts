// ============================================================
// v7-A3 迁移桥：全库转储 / 恢复（纯函数，依赖注入表句柄）
//
// 背景：IndexedDB 按应用身份隔离——浏览器版书稿带不进桌面壳，桌面版升级
// 换 identifier 也会"看不见"旧数据。导出 = 全部表逐条 JSON 转储；导入 =
// 按主键 upsert（幂等：重复导入覆盖同 id，不产生副本）。
// 表句柄用最小面接口注入（toArray/bulkPut/clear），Dexie.Table 天然满足——
// 本模块因此可进 Node 逻辑测试白名单（flow/** 已整体在白名单内）。
// ============================================================

/** 转储格式版本（≠ Dexie schema 版本；格式演进时才动它） */
export const DUMP_FORMAT = 1;

/** 与 store/db.ts 的表清单一一对应（新增表必须同步这里 + wiring 映射，verifyDump 会兜底报生） */
export const TABLE_NAMES = [
  "projects",
  "outlineNodes",
  "characters",
  "loreEntries",
  "sessions",
  "ledger",
  "meta",
  "personas",
] as const;

export type TableName = (typeof TABLE_NAMES)[number];

/** 表句柄最小面：Dexie.Table 结构上满足（方法双变）；测试注入内存数组假表。
 *  刻意不含 primaryKey——Dexie 该属性是字符串，与自定义对象形不两立，且本模块用不到。 */
export interface TableLike {
  toArray(): Promise<unknown[]>;
  bulkPut(rows: unknown[]): Promise<unknown>;
  clear(): Promise<void>;
}

export interface FullDump {
  /** 识别戳：防把别的 JSON 误当转储导入 */
  app: "story-studio";
  format: number;
  /** 导出时的 Dexie schema 版本（只做提示，不做硬闸——高版本导入低版本应用才危险） */
  schemaVersion: number;
  exportedAt: number;
  tables: Record<string, unknown[]>;
}

export type TableMap = Record<TableName, TableLike>;

/** 全库转储：逐表 toArray（键序固定按 TABLE_NAMES，字节稳定便于对账/diff） */
export async function dumpAll(tables: TableMap, schemaVersion: number): Promise<FullDump> {
  const out: Record<string, unknown[]> = {};
  for (const name of TABLE_NAMES) {
    out[name] = await tables[name].toArray();
  }
  return { app: "story-studio", format: DUMP_FORMAT, schemaVersion, exportedAt: Date.now(), tables: out };
}

export interface DumpReport {
  ok: boolean;
  errors: string[];
  /** 各表行数（校验通过时也填，供 UI 对账展示） */
  counts: Record<string, number>;
  total: number;
  /** 转储里出现但本应用不认识的数据表名（只警示不拦——前向兼容） */
  unknownTables: string[];
}

/** 校验转储结构（不碰数据库）：识别戳/format/表齐全/行是对象或合法值 */
export function verifyDump(dump: unknown): DumpReport {
  const errors: string[] = [];
  const counts: Record<string, number> = {};
  const unknownTables: string[] = [];
  const rep = (ok: boolean): DumpReport => ({
    ok,
    errors,
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    unknownTables,
  });
  if (!dump || typeof dump !== "object" || Array.isArray(dump)) {
    errors.push("转储文件不是一个 JSON 对象");
    return rep(false);
  }
  const d = dump as Record<string, unknown>;
  if (d.app !== "story-studio") {
    errors.push("识别戳不符（app ≠ story-studio）：这不是 Story Studio 的全库转储");
    return rep(false);
  }
  if (d.format !== DUMP_FORMAT) {
    errors.push(`转储格式版本 ${String(d.format)} 不被本应用认识（期望 ${DUMP_FORMAT}）`);
    return rep(false);
  }
  if (!d.tables || typeof d.tables !== "object" || Array.isArray(d.tables)) {
    errors.push("tables 字段缺失或形态非法");
    return rep(false);
  }
  const src = d.tables as Record<string, unknown>;
  for (const name of Object.keys(src)) {
    const rows = src[name];
    if (!Array.isArray(rows)) {
      errors.push(`表 ${name} 不是数组`);
      continue;
    }
    counts[name] = rows.length;
    if (!(TABLE_NAMES as readonly string[]).includes(name)) unknownTables.push(name);
  }
  for (const name of TABLE_NAMES) {
    if (!(name in src)) errors.push(`缺少表 ${name}（转储不完整或应用表清单落后）`);
  }
  return rep(errors.length === 0);
}

export interface RestoreResult {
  counts: Record<string, number>;
  total: number;
  /** 高版本 Dexie schema 的转储灌进低版本应用：不拦但如实警示（索引可能对不上） */
  schemaWarning: string;
}

/**
 * 恢复：按主键 upsert（bulkPut=幂等覆盖，重复导入不产生副本）。
 * mode="replace" 先 clear 该表（整库回滚到转储时刻）；默认 "merge"。
 * 逐表进行；任何一表抛错原样上抛（调用方提示中途失败——已灌表不回滚，
 * merge 模式重跑幂等，replace 模式重跑同样收敛）。
 */
export async function restoreAll(
  tables: TableMap,
  dump: FullDump,
  opts: { mode?: "merge" | "replace"; currentSchemaVersion?: number } = {},
): Promise<RestoreResult> {
  const mode = opts.mode ?? "merge";
  const counts: Record<string, number> = {};
  let total = 0;
  for (const name of TABLE_NAMES) {
    const rows = Array.isArray(dump.tables[name]) ? dump.tables[name] : [];
    if (mode === "replace") await tables[name].clear();
    if (rows.length > 0) await tables[name].bulkPut(rows);
    counts[name] = rows.length;
    total += rows.length;
  }
  const cur = opts.currentSchemaVersion ?? 0;
  const schemaWarning =
    cur > 0 && dump.schemaVersion > cur
      ? `转储出自更新的存储结构（v${dump.schemaVersion} > 应用 v${cur}）：部分新表/索引可能未被本版本认识`
      : "";
  return { counts, total, schemaWarning };
}

/** 页面一步式：unknown（来自文件）→ 校验（不过则抛错，错误逐条并陈）→ 恢复 */
export async function restoreDump(
  tables: TableMap,
  dump: unknown,
  opts: { mode?: "merge" | "replace"; currentSchemaVersion?: number } = {},
): Promise<RestoreResult & { unknownTables: string[] }> {
  const v = verifyDump(dump);
  if (!v.ok) throw new Error(`转储校验未通过：${v.errors.join("；")}`);
  const r = await restoreAll(tables, dump as FullDump, opts);
  return { ...r, unknownTables: v.unknownTables };
}

/** 序列化成下载文件用的字符串（缩进 1 空格：体积比 2 小、可读性够用） */
export function dumpToJson(dump: FullDump): string {
  return JSON.stringify(dump, null, 1);
}

/** 解析导入文件文本 → 对象（坏 JSON 抛出清晰错误；不进 verify 职责） */
export function parseDumpJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("文件不是合法 JSON（Story Studio 全库转储应是 .json 文本）");
  }
}
