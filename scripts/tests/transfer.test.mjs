// v7-A3 迁移桥纯函数测试：假表=内存数组 + 主键 id（meta 用 key）
import {
  DUMP_FORMAT,
  TABLE_NAMES,
  dumpAll,
  dumpToJson,
  parseDumpJson,
  restoreAll,
  restoreDump,
  verifyDump,
} from "../../dist-test/flow/transfer.js";

function fakeTable(pk = "id") {
  const rows = [];
  return {
    rows,
    primaryKey: { name: pk },
    async toArray() {
      return rows.map((r) => ({ ...r }));
    },
    async bulkPut(inRows) {
      for (const r of inRows) {
        const k = r[pk];
        const i = rows.findIndex((x) => x[pk] === k);
        if (i >= 0) rows[i] = { ...r };
        else rows.push({ ...r });
      }
    },
    async clear() {
      rows.length = 0;
    },
  };
}

function fakeTables() {
  const m = {};
  for (const n of TABLE_NAMES) m[n] = fakeTable(n === "meta" ? "key" : "id");
  return m;
}

export default async (t) => {
  // ---------- dumpAll：逐表收全、键序固定 ----------
  {
    const tb = fakeTables();
    tb.projects.rows.push({ id: "p1", title: "书A" });
    tb.outlineNodes.rows.push({ id: "n1" }, { id: "n2" });
    tb.meta.rows.push({ key: "dirHandle", value: 1 });
    const dump = await dumpAll(tb, 4);
    t.eq(dump.app, "story-studio", "识别戳");
    t.eq(dump.format, DUMP_FORMAT, "format 戳=当前格式版本");
    t.eq(dump.schemaVersion, 4, "schemaVersion 透传");
    t.eq(Object.keys(dump.tables).join(","), TABLE_NAMES.join(","), "表键序=TABLE_NAMES 固定序");
    t.eq(dump.tables.outlineNodes.length, 2, "行数如实");
    t.eq(dump.tables.projects[0].title, "书A", "行内容原样");
    t.ok(dump.exportedAt > 0, "exportedAt 有时戳");
  }

  // ---------- verifyDump：识别与结构 ----------
  {
    const tb = fakeTables();
    const dump = await dumpAll(tb, 4);
    const ok = verifyDump(dump);
    t.ok(ok.ok, "自家转储校验通过");
    t.eq(ok.total, 0, "空库 total=0");
    t.eq(verifyDump(null).ok, false, "null 拒");
    t.ok(verifyDump({}).errors[0].includes("识别戳"), "缺戳报错点名识别戳");
    t.ok(verifyDump({ app: "other", tables: {} }).errors[0].includes("识别戳"), "别家 app 拒");
    t.ok(
      verifyDump({ ...dump, format: 99 }).errors.some((e) => e.includes("格式版本")),
      "未知 format 拒",
    );
    {
      const missing = { ...dump, tables: { ...dump.tables } };
      delete missing.tables.ledger;
      const v = verifyDump(missing);
      t.eq(v.ok, false, "缺表不完整");
      t.ok(v.errors.some((e) => e.includes("ledger")), "报错点名缺的表");
    }
    {
      const extra = { ...dump, tables: { ...dump.tables, futureTable: [{ id: "z" }] } };
      const v = verifyDump(extra);
      t.ok(v.ok, "多出的未来表只警示不拦（前向兼容）");
      t.eq(v.unknownTables.join(","), "futureTable", "unknownTables 列出生疏表名");
    }
    t.ok(verifyDump({ app: "story-studio", format: DUMP_FORMAT, tables: [] }).errors.some((e) => e.includes("tables")), "tables 为数组也拒");
  }

  // ---------- restoreAll：merge 幂等 / replace 回滚 / schema 警示 ----------
  {
    const src = fakeTables();
    src.characters.rows.push({ id: "c1", name: "甲" }, { id: "c2", name: "乙" });
    const dump = await dumpAll(src, 4);

    const dst = fakeTables();
    dst.characters.rows.push({ id: "c2", name: "旧乙" });
    const r1 = await restoreAll(dst, dump, { currentSchemaVersion: 4 });
    t.eq(r1.counts.characters, 2, "merge 报告源行数");
    t.eq(dst.characters.rows.length, 2, "merge：同 id 覆盖不追加");
    t.eq(dst.characters.rows.find((x) => x.id === "c2").name, "乙", "同 id 行被转储值覆盖");

    const r2 = await restoreAll(dst, dump, { currentSchemaVersion: 4 });
    t.eq(dst.characters.rows.length, 2, "重复导入幂等（不产生副本）");
    t.eq(r2.total, 2, "total 汇总各表");

    const dst2 = fakeTables();
    dst2.personas.rows.push({ id: "ghost", name: "转储里没有的人" });
    await restoreAll(dst2, dump, { mode: "replace", currentSchemaVersion: 4 });
    t.eq(dst2.personas.rows.length, 0, "replace 模式：转储外的行清除");

    const warn = await restoreAll(fakeTables(), { ...dump, schemaVersion: 9 }, { currentSchemaVersion: 4 });
    t.ok(warn.schemaWarning.includes("v9"), "高版本转储 → schemaWarning 点名版本");
    const nowarn = await restoreAll(fakeTables(), dump, { currentSchemaVersion: 4 });
    t.eq(nowarn.schemaWarning, "", "同版本无警示");
  }

  // ---------- restoreDump 一步式：坏件抛错 / 好件带 unknownTables ----------
  {
    const tb = fakeTables();
    let threw = "";
    try {
      await restoreDump(tb, { app: "story-studio", format: 999 });
    } catch (e) {
      threw = e.message;
    }
    t.ok(threw.includes("校验未通过"), "坏件抛清晰错误（校验未通过前缀）");
    const good = await restoreDump(tb, await dumpAll(fakeTables(), 4), { currentSchemaVersion: 4 });
    t.eq(good.unknownTables.length, 0, "好件 unknownTables 空");
  }

  // ---------- JSON 往返 ----------
  {
    const tb = fakeTables();
    tb.ledger.rows.push({ id: "l1", content: "含中文与\u2028行分隔符" });
    const dump = await dumpAll(tb, 4);
    const text = dumpToJson(dump);
    const back = parseDumpJson(text);
    const v = verifyDump(back);
    t.ok(v.ok, "序列化→解析→校验 往返无损");
    t.eq(v.counts.ledger, 1, "往返后行数不变");
    let threw = "";
    try {
      parseDumpJson("{坏");
    } catch (e) {
      threw = e.message;
    }
    t.ok(threw.includes("JSON"), "坏 JSON 抛点名的错");
  }
};
