// v4 全局资产库可见集纯逻辑测试（flow/library.ts）
// 覆盖：可见集（自有∪选用）/ 全局视角 / 悬空容忍 / 不重排契约 / 开关幂等 / 剔除 / 计数。
import {
  filterVisible,
  toggleSelected,
  pruneSelection,
  usedSelectedCount,
  toggleBookIds,
  bookSelState,
} from "../../dist-test/flow/library.js";

export default async function (t) {
  const rows = [
    { id: "a", projectId: "p1" },
    { id: "b", projectId: "p2" },
    { id: "c", projectId: "" },
    { id: "d", projectId: "p1" },
  ];

  // 1. 旧数据（选用列表缺失）⇔ 只用自有
  t.eq(
    filterVisible(rows, "p1", undefined).map((r) => r.id).join(","),
    "a,d",
    "1. 无选用列表 = 仅自有（按原序）",
  );
  // 2. 自有 ∪ 选用（选用外部 + 全局直建），保持入参顺序
  t.eq(
    filterVisible(rows, "p1", ["c", "b"]).map((r) => r.id).join(","),
    "a,b,c,d",
    "2. 自有∪选用，顺序 = 入参序",
  );
  // 3. 悬空容忍：列表里的 id 没有对应行 → 忽略，不报错
  t.eq(
    filterVisible(rows, "p1", ["ghost", "c"]).map((r) => r.id).join(","),
    "a,c,d",
    "3. 悬空 id 静默忽略",
  );
  // 4. 全局视角（null）= 全部行
  t.eq(filterVisible(rows, null, undefined).length, 4, "4. null = 全库");
  // 5. 不重排 + 不改入参（契约：repos 门面负责稳定排序，本层只过滤）
  const input = [...rows];
  const out = filterVisible(rows, "p2", ["a"]);
  t.eq(out.map((r) => r.id).join(","), "a,b", "5. 输出顺序 = 入参顺序（a 在 b 前）");
  t.eq(rows, input, "5. 入参未被改动");
  t.eq(rows.map((r) => r.id).join(","), "a,b,c,d", "5. 入参数组本身未变");

  // 6. toggle：追加/移除/幂等，不改入参
  const base = ["x", "y"];
  t.eq(toggleSelected(base, "z").join(","), "x,y,z", "6. 未选 → 追加");
  t.eq(toggleSelected(base, "x").join(","), "y", "6. 已选 → 移除");
  t.eq(base.join(","), "x,y", "6. 入参数组未被改动");
  t.eq(toggleSelected(undefined, "x").join(","), "x", "6. undefined → [id]");

  // 7. pruneSelection：剔除悬空、保序、幂等
  t.eq(pruneSelection(["a", "ghost", "c"], ["a", "b", "c"]).join(","), "a,c", "7. 剔除悬空保序");
  t.eq(pruneSelection(undefined, ["a"]).length, 0, "7. undefined → []");
  const ids = ["a", "b"];
  t.eq(pruneSelection(ids, ids).length, 2, "7. 全存活 = 原样");

  // 8. usedSelectedCount：只数存活的选用
  t.eq(usedSelectedCount(["c", "ghost"], ["a", "c", "d"]), 1, "8. 悬空不计数");
  t.eq(usedSelectedCount(undefined, ["a"]), 0, "8. 无选用 = 0");

  // 9. v8-D3 整本勾选：toggleBookIds 并入/移出，结果 id 升序（顺序契约）
  t.eq(toggleBookIds(["e2"], ["e1", "e3"], true).join(","), "e1,e2,e3", "9. 整本并入且升序");
  t.eq(toggleBookIds(["e1", "e2", "e3"], ["e1", "e3"], false).join(","), "e2", "9. 整本移出");
  t.eq(toggleBookIds(["e1"], ["e1"], true).join(","), "e1", "9. 重复并入幂等");
  t.eq(toggleBookIds([], [], true).length, 0, "9. 空书并入空操作");

  // 10. v8-D3 bookSelState 三态：UI 画 indeterminate 的依据
  const sel = new Set(["e1", "e2"]);
  t.eq(bookSelState(["e1", "e2"], sel), "all", "10. 全中=all");
  t.eq(bookSelState(["e2", "e3"], sel), "some", "10. 半中=some");
  t.eq(bookSelState(["e3", "e4"], sel), "none", "10. 不中=none");
}
