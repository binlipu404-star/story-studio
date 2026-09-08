// 拖拽落点计划 moveNodePlan + 草稿差值 draftDiff 冒烟测试（v6 P1）
import { moveNodePlan, draftDiff } from "../../dist-test/flow/outline.js";

const N = (p) => ({
  id: "n",
  projectId: "p",
  parentId: null,
  level: "scene",
  order: 0,
  title: "t",
  intent: "",
  beats: [],
  cast: [],
  foreshadows: [],
  status: "draft",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  ...p,
});

// 树形：卷 v1>v2>v3（根级 0/1/2）；v1 下章 c1(0) c2(1)；v2 下章 c3(0)；
// c1 下幕 s1(0) s2(1)；c3 下幕 s3(0)
const NODES = () => [
  N({ id: "v1", level: "volume", order: 0 }),
  N({ id: "v2", level: "volume", order: 1 }),
  N({ id: "v3", level: "volume", order: 2 }),
  N({ id: "c1", level: "chapter", parentId: "v1", order: 0 }),
  N({ id: "c2", level: "chapter", parentId: "v1", order: 1 }),
  N({ id: "c3", level: "chapter", parentId: "v2", order: 0 }),
  N({ id: "s1", level: "scene", parentId: "c1", order: 0 }),
  N({ id: "s2", level: "scene", parentId: "c1", order: 1 }),
  N({ id: "s3", level: "scene", parentId: "c3", order: 0 }),
];

/** 模拟落库：把 updates 应用到 nodes 上，便于对结果结构做断言 */
const apply = (nodes, updates) => {
  const map = new Map(nodes.map((n) => [n.id, n]));
  for (const u of updates) {
    const n = map.get(u.id);
    n.order = u.order;
    if (u.parentId !== undefined) n.parentId = u.parentId;
  }
  return nodes;
};

/** 某组按 order（平票按 id）排序后的 order 串，如 "0,1,2" */
const ordersOf = (nodes, parentId) =>
  nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((n) => n.order)
    .join(",");

/** 某组按 order（平票按 id）排序后的 id 串 */
const idsOf = (nodes, parentId) =>
  nodes
    .filter((n) => (n.parentId ?? null) === parentId)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((n) => n.id)
    .join(",");

const ids = (res) => res.updates.map((u) => u.id).join(",");

export default async function (t) {
  // 1. after 基本形：c1 拖到 c2 之后（同组换序）
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "c1", "c2", "after");
    t.ok(r && r.updates, "1. after 基本形返回 updates");
    t.eq(ids(r), "c1,c2", "1. 交换=最小两行改动");
    t.eq(r.updates[0].id, "c1", "1. drag 记录排最前");
    t.eq("parentId" in r.updates[0], false, "1. 同组换序不带 parentId（写库波及面最小）");
    apply(nodes, r.updates);
    t.eq(idsOf(nodes, "v1"), "c2,c1", "1. 落库后兄弟序=c2,c1");
    t.eq(ordersOf(nodes, "v1"), "0,1", "1. 兄弟 order 连续 0..n-1");
  }

  // 2. before 基本形（=移到组首）：c2 拖到 c1 之前
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "c2", "c1", "before");
    t.eq(ids(r), "c2,c1", "2. before 首行=移到组首");
    t.eq("parentId" in r.updates[1], false, "2. 非 drag 行只带 order");
    apply(nodes, r.updates);
    t.eq(idsOf(nodes, "v1"), "c2,c1", "2. 落库后 c2 在组首");
    t.eq(ordersOf(nodes, "v1"), "0,1", "2. 目标组其余行同步重排");
  }

  // 3. child = 追加为目标末尾子级
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "c3", "v1", "child");
    t.eq(ids(r), "c3", "3. 空源组无需补位：只动 drag 一行");
    t.eq(r.updates[0].parentId, "v1", "3. 父变化才附 parentId");
    t.eq(r.updates[0].order, 2, "3. child=尾插（order=目标组长度）");
    apply(nodes, r.updates);
    t.eq(idsOf(nodes, "v1"), "c1,c2,c3", "3. child 落库后在组尾");
    t.eq(ordersOf(nodes, "v1"), "0,1,2", "3. 目标组 order 连续");
  }

  // 4. 跨章移动：s1 投为 c3 的子级 → 源组补位重编号
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "s1", "c3", "child");
    t.eq(ids(r), "s1,s2", "4. 跨章：源组 s2 补位 1→0");
    t.eq(r.updates.filter((u) => u.parentId !== undefined).length, 1, "4. parentId 变化行恰 1 条（drag 自己）");
    apply(nodes, r.updates);
    t.eq(ordersOf(nodes, "c1"), "0", "4. 源组补位后连续");
    t.eq(idsOf(nodes, "c3"), "s3,s1", "4. 目标组尾插");
  }

  // 4b. 跨父 before：s2 拖到 c3 组里 s3 之前（新父=目标行的 parentId）
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "s2", "s3", "before");
    t.eq(ids(r), "s2,s3", "4b. before 跨父：drag 最前 + 目标组重排");
    t.eq(r.updates[0].parentId, "c3", "4b. before 的新父=目标行的 parentId");
    apply(nodes, r.updates);
    t.eq(idsOf(nodes, "c3"), "s2,s3", "4b. 落库后 s2 在 s3 前");
    t.eq(ordersOf(nodes, "c3"), "0,1", "4b. 目标组重编号连续");
  }

  // 5. 拖到自身/自家子树 → error
  t.ok(String(moveNodePlan(NODES(), "v1", "v1", "child").error).includes("不能拖到自己或自己的子树上"), "5. 拖到自身 → error");
  t.ok(String(moveNodePlan(NODES(), "v1", "c1", "child").error).includes("不能拖到自己或自己的子树上"), "5. 拖到亲儿子 → error");
  t.ok(String(moveNodePlan(NODES(), "v1", "s1", "before").error).includes("不能拖到自己或自己的子树上"), "5. 拖到孙辈（隔代子树）→ error");

  // 6. 层级递进校验（validatePlacement 原样透传）
  t.ok(String(moveNodePlan(NODES(), "v2", "c1", "child").error).includes("卷是最外层"), "6. 卷→章 child 非法");
  t.ok(String(moveNodePlan(NODES(), "c2", "c1", "child").error).includes("层级必须更细"), "6. 章→章 child 非法");
  t.ok(String(moveNodePlan(NODES(), "s1", "s2", "child").error).includes("幕不能挂在幕下"), "6. 幕→幕 child 非法");
  t.ok(String(moveNodePlan(NODES(), "s1", "v2", "before").error).includes("上级"), "6. 幕 before 卷=新父为空 → 必须有上级");

  // 7. 根级空白区（targetId=null 只允许 child=卷尾追加）
  {
    const nodes = NODES();
    const r = moveNodePlan(nodes, "v1", null, "child");
    t.eq(ids(r), "v1,v2,v3", "7. 卷投 null：全根级重排");
    t.eq("parentId" in r.updates[0], false, "7. 根内换序（父未变）不带 parentId");
    apply(nodes, r.updates);
    t.eq(idsOf(nodes, null), "v2,v3,v1", "7. 卷投 null=追加到根级卷列表末尾");
    t.eq(ordersOf(nodes, null), "0,1,2", "7. 根级 order 连续");
  }
  t.ok(String(moveNodePlan(NODES(), "c1", null, "child").error).includes("上级"), "7. 章投 targetId=null → error");
  t.ok(String(moveNodePlan(NODES(), "v1", null, "before").error).includes("空白区只接受把「卷」投为新的根级卷"), "7. 空白区 before → 专属 error 文案");
  t.ok(String(moveNodePlan(NODES(), "v1", null, "after").error).includes("空白区"), "7. 空白区 after 同样拒绝");

  // 8. 原地 no-op → null（合法但无变化，UI 静默忽略）
  t.eq(moveNodePlan(NODES(), "v2", "v1", "after"), null, "8. v2 本就紧跟 v1 之后：after no-op → null");
  t.eq(moveNodePlan(NODES(), "c2", "c1", "after"), null, "8. c2 本就紧跟 c1 之后：after no-op → null");

  // 9. 平票组（同组 order 全 0）拖一次 → 全组连续 0..n-1
  {
    const nodes = NODES();
    nodes.push(N({ id: "c4", level: "chapter", parentId: "v1", order: 0 })); // 三章平票 order 全 0
    const r = moveNodePlan(nodes, "c4", "c1", "after");
    t.eq(ids(r), "c4,c2", "9. 平票组：c1 保持 0，c4→1、c2→2");
    apply(nodes, r.updates);
    t.eq(ordersOf(nodes, "v1"), "0,1,2", "9. 拖一次整组消除平票变连续");
    t.eq(idsOf(nodes, "v1"), "c1,c4,c2", "9. 落库后组序按新 order");
  }

  // 10. 悬空 id → null；悬空新父 → 专属 error
  t.eq(moveNodePlan(NODES(), "ghost", "v1", "after"), null, "10. dragId 悬空 → null");
  t.eq(moveNodePlan(NODES(), "v1", "ghost", "after"), null, "10. targetId 悬空 → null");
  {
    const nodes = NODES();
    nodes.push(N({ id: "o1", level: "chapter", parentId: "ghost", order: 0 })); // 孤儿行（新父悬空）
    t.ok(String(moveNodePlan(nodes, "c1", "o1", "after").error).includes("目标上级不存在"), "10. 新父 id 悬空 → 目标上级不存在");
  }

  // 11. 根行 parentId=undefined 与 null 等价（不判成跨父）
  {
    const nodes = NODES();
    nodes[2] = N({ id: "v3", level: "volume", order: 2, parentId: undefined }); // 老数据：根行 parentId 缺失
    const r = moveNodePlan(nodes, "v3", "v1", "after");
    t.eq(ids(r), "v3,v2", "11. undefined≈null 根：v3→1、v2→2，v1 不动");
    t.eq("parentId" in r.updates[0], false, "11. undefined→null 不算父变化，不带 parentId");
  }

  // 12. draftDiff：三层节点总数差值
  const VOL = (chs) => ({ title: "v", chapters: chs });
  const CH = (n) => ({ title: "c", scenes: Array.from({ length: n }, (_, i) => ({ title: "s" + i })) });
  const A = { logline: "a", volumes: [VOL([CH(2), CH(1)]), VOL([CH(3)])] }; // 2卷/3章/6幕
  const eq3 = (d) => [d.volumes, d.chapters, d.scenes].join(",");
  t.eq(eq3(draftDiff(null, A)), "2,3,6", "12. null→新稿：全正");
  t.eq(eq3(draftDiff(A, A)), "0,0,0", "12. 等值草稿：全 0（防空口宣称）");
  t.eq(eq3(draftDiff(A, { volumes: [A.volumes[0]] })), "-1,-1,-3", "12. 删一卷：三项皆负");
  t.eq(eq3(draftDiff(A, { volumes: [VOL([CH(2), CH(1), CH(1)]), VOL([CH(3)])] })), "0,1,1", "12. 卷数不变章增加：分项正确");
  t.eq(eq3(draftDiff(A, null)), "-2,-3,-6", "12. 清空草稿：全负");
  t.eq(eq3(draftDiff({ volumes: "坏数据" }, { volumes: [{ title: "x" }, { chapters: [{}] }] })), "2,1,0", "12. 非数组/缺 chapters 按 0 容错");
  t.eq(eq3(draftDiff(null, null)), "0,0,0", "12. 双 null → 全 0");
}
