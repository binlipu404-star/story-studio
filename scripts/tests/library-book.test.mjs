// v5 世界书「整本书」可见集纯逻辑测试（flow/library.ts 新增段）
// 覆盖：按书归属/按书序拼接/跨书可见集/未迁移回落/旧书合并/自动选用。
import {
  assignLegacyBook,
  entriesOfBook,
  entriesOfBooks,
  hasUnbookedEntries,
  keepBooksEnabled,
  legacySelection,
  visibleByBooks,
} from "../../dist-test/flow/library.js";

export default async function (t) {
  const rows = [
    { id: "a", projectId: "p1", bookId: "B1" },
    { id: "b", projectId: "p2", bookId: "B2" },
    { id: "c", projectId: "", bookId: "B1" },
    { id: "d", projectId: "p1" }, // 无书（旧散装）
    { id: "e", projectId: "", bookId: "B2" },
    { id: "f", projectId: "p2", bookId: "B3" },
  ];

  // 1. entriesOfBook：取某书词条，保持入参序
  t.eq(entriesOfBook(rows, "B1").map((r) => r.id).join(","), "a,c", "1. 取 B1 词条保序");
  t.eq(entriesOfBook(rows, "ghost").length, 0, "1. 悬空书 = 空");

  // 2. entriesOfBooks：按「选中书序」拼接，书内保序
  t.eq(entriesOfBooks(rows, ["B2", "B1"]).map((r) => r.id).join(","), "b,e,a,c", "2. 按书序拼接：B2 前 B1 后");
  t.eq(entriesOfBooks(rows, ["B1", "B3"]).map((r) => r.id).join(","), "a,c,f", "2. B1 后 B3");
  t.eq(entriesOfBooks(rows, undefined).length, 0, "2. 无选中书 = 空");
  t.eq(entriesOfBooks(rows, ["ghost"]).length, 0, "2. 全是悬空书 = 空");

  // 3. visibleByBooks：定义书列表 → 按书序拼接 + 自有未归书兜底
  t.eq(visibleByBooks(rows, "p1", ["B1"]).map((r) => r.id).join(","), "a,c,d", "3. 选 B1 + 自有兜底 d");
  t.eq(visibleByBooks(rows, "p2", ["B2", "B3"]).map((r) => r.id).join(","), "b,e,f", "3. p2 选 B2+B3 按书序");
  t.eq(visibleByBooks(rows, "p1", []).map((r) => r.id).join(","), "d", "3. 不选书 = 仅自有兜底");

  // 4. visibleByBooks：未迁移（bookIds 未定义）→ 回落 v4 自有语义
  const unbookedOnly = [
    { id: "a", projectId: "p1" },
    { id: "b", projectId: "p2" },
  ];
  t.eq(visibleByBooks(unbookedOnly, "p1", undefined).map((r) => r.id).join(","), "a", "4. 未迁移回落 v4 自有");

  // 5. hasUnbookedEntries：判定是否还有散装词条
  t.eq(hasUnbookedEntries(rows), true, "5. 存在无书词条 → true");
  t.eq(hasUnbookedEntries(entriesOfBook(rows, "B1")), false, "5. 某书内部无散装 → false");

  // 6. assignLegacyBook：散装全部归入旧书，打上书 id，不改非散装
  const { entries: migrated, merged } = assignLegacyBook(rows, "LEG");
  t.eq(migrated.every((r) => r.bookId !== undefined), true, "6. 迁移后全部有书");
  t.eq(migrated.find((r) => r.id === "d").bookId, "LEG", "6. 散装 d 归入 LEG");
  t.eq(migrated.find((r) => r.id === "a").bookId, "B1", "6. 已属书 a 不被改");
  t.eq(merged.length, 1, "6. 只合并了原本无书的一条");
  t.eq(rows.length, migrated.length, "6. 行数不变（不改入参）");

  // 7. legacySelection：旧选中/含自有 → 自动把旧书放选用开头
  t.eq(legacySelection({ loreIds: ["x"], loreBookIds: undefined }, true, "LEG").join(","), "LEG", "7. 有旧勾选 → 自动选旧书");
  t.eq(legacySelection({ loreIds: undefined, loreBookIds: undefined }, true, "LEG").join(","), "LEG", "7. 旧书里有自有 → 自动选");
  t.eq(legacySelection({ loreIds: undefined, loreBookIds: undefined }, false, "LEG").length, 0, "7. 无关作品不自动选");
  t.eq(legacySelection({ loreIds: ["x"], loreBookIds: ["OTHER"] }, true, "LEG").join(","), "LEG,OTHER", "7. 旧书放最前、保留已有选用");
  t.eq(legacySelection({ loreIds: undefined, loreBookIds: ["LEG"] }, false, "LEG").join(","), "LEG", "7. 已选旧书幂等（不重复加）");

  // 8. 不重排 + 不改入参（v5 契约同 v4）
  const input = rows.map((r) => ({ ...r }));
  const out = visibleByBooks(rows, "p2", ["B3", "B2"]);
  t.eq(out.map((r) => r.id).join(","), "f,b,e", "8. 按选择序（B3 前 B2 后）");
  t.eq(rows.map((r) => r.id).join(","), "a,b,c,d,e,f", "8. 入参数组未被改动");
  t.eq(input.map((r) => r.id).join(","), "a,b,c,d,e,f", "8. 入参对象未变");

  // 9. keepBooksEnabled：整本停用剔除；未归书词条兜底保留；null=全保留
  t.eq(keepBooksEnabled(rows, new Set(["B1", "B3"])).map((r) => r.id).join(","), "a,c,d,f", "9. 停用 B2 → 剔除 b,e，保留 d（无主兜底，数组原序）");
  t.eq(keepBooksEnabled(rows, null).length, 6, "9. null = 全保留（不重排）");
  t.eq(keepBooksEnabled(rows, new Set()).length, 1, "9. 空启用集 = 只剩无主词条 d");
  const keepIn = rows.map((r) => ({ ...r }));
  keepBooksEnabled(rows, new Set(["B1"]));
  t.eq(rows.map((r) => r.id).join(","), "a,b,c,d,e,f", "9. 不改入参");
  t.eq(keepIn.map((r) => r.id).join(","), "a,b,c,d,e,f", "9. 入参对象未变");

  // 10. 组合：整本停用 ∧ 选中书序 → 停用书整体不出现在注入序列
  t.eq(
    visibleByBooks(keepBooksEnabled(rows, new Set(["B3"])), "p1", ["B1", "B3"]).map((r) => r.id).join(","),
    "f,d",
    "10. B1 停用 → 虽选中但整体剔除，只剩 B3 的 f + 自有 d",
  );
}
