// v7.1-W3 合并计划 planDraftMerge 纯逻辑测试
// 语义基线：草稿为准（命中=更新）· 不重复（同名识别）· 不删减（未提及的旧节点保留）
import { planDraftMerge, normTitle } from "../../dist-test/flow/outlineMerge.js";

let seq = 0;
const uid = () => `u${++seq}`;

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

// 草稿工厂：形态同总纲 JSON（coach 契约：beats 恒空）
const D = (volumes) => ({ volumes });

export default async function (t) {
  // ---------- normTitle ----------
  t.eq(normTitle(" 第一章 "), normTitle("第一章"), "空白差异不影响匹配键");
  t.eq(normTitle("第１章"), normTitle("第1章"), "全角数字归一半角");
  t.eq(normTitle("《归去来》"), normTitle("归去来"), "成对书名号剥离");
  t.eq(normTitle("   "), "", "纯空白归空串（永不匹配）");
  t.eq(normTitle(undefined), "", "undefined 归空串");

  // ---------- 1. 空树应用 = 全新建 ----------
  {
    const draft = D([
      { title: "卷一", chapters: [{ title: "第一章", scenes: [{ title: "幕A" }, { title: "幕B" }] }] },
    ]);
    const p = planDraftMerge([], draft, { projectId: "p", uid });
    t.eq(p.creates.length, 4, "空树：1卷+1章+2幕全进 creates");
    t.eq(p.fieldUpdates.length, 0, "空树：无字段更新");
    t.eq(p.orderUpdates.length, 0, "空树：无排序写集");
    const vol = p.creates.find((n) => n.level === "volume");
    const ch = p.creates.find((n) => n.level === "chapter");
    t.eq(ch.parentId, vol.id, "章挂在新建卷下");
    t.eq(p.newEmptySceneIds.length, 2, "两个新建空幕都进节拍候选");
    t.eq(p.stats.created, 4, "stats.created=4");
    t.eq(p.stats.kept, 0, "stats.kept=0");
  }

  // ---------- 2. 重复章节合并（核心诉求：不再长出第二个第一章） ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章", intent: "旧意图" }),
      N({ id: "s1", level: "scene", parentId: "c1", order: 0, title: "幕A", beats: [{ id: "b1", text: "已有节拍" }] }),
    ];
    const draft = D([
      { title: "卷一", chapters: [{ title: "第一章", intent: "新意图", scenes: [{ title: "幕A", intent: "幕新图" }] }] },
    ]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.eq(p.creates.length, 0, "同名卷章幕零新建（重复应用的日常）");
    t.eq(p.fieldUpdates.filter((u) => u.id === "c1").length, 1, "旧第一章被认领更新");
    t.eq(p.fieldUpdates.find((u) => u.id === "c1").patch.intent, "新意图", "intent 以草稿为准");
    t.eq(p.fieldUpdates.find((u) => u.id === "s1").patch.intent, "幕新图", "命中幕 intent 更新");
    t.ok(!("beats" in p.fieldUpdates.find((u) => u.id === "s1").patch), "既有节拍不被覆盖");
    t.eq(p.stats.updated, 2, "stats.updated=2（章+幕）");
    t.ok(p.orderUpdates.length === 0, "结构未变则零排序写集（id 稳定、最小写集）");
  }

  // ---------- 3. 草稿未提到的旧节点：保留 + 垫组尾 ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章" }),
      N({ id: "c2", level: "chapter", parentId: "v1", order: 1, title: "第二章（草稿没提）" }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第一章", scenes: [{ title: "幕A" }] }] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.eq(p.stats.kept, 1, "kept=1（旧第二章）");
    t.ok(!p.creates.some((n) => n.title.includes("没提")), "保留节点不产生任何新建替身");
    t.ok(!p.fieldUpdates.some((u) => u.id === "c2"), "保留节点零字段写");
    // 新幕 c1 下新建；第二章仍挂在卷下、被排到组尾之后
    const newCh = p.creates.filter((n) => n.level === "scene");
    t.eq(newCh.length, 1, "草稿新增一幕");
    const keepMove = p.orderUpdates.find((u) => u.id === "c2");
    t.ok(!keepMove || keepMove.order >= 1, "旧第二章不被删除，最多被挪序垫尾");
  }

  // ---------- 4. beats/status 保护 · 草稿空字段保留旧值 ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({
        id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章", intent: "手写的别冲掉",
        status: "tested", beats: [{ id: "b1", text: "拍子", done: true }],
      }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第一章" }] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.eq(p.fieldUpdates.length, 0, "草稿空字段零写集（intent/status/beats 全保）");
    t.eq(p.stats.updated, 0, "stats.updated=0");
    t.eq(p.newEmptySceneIds.length, 0, "非幕节点不进节拍候选");
  }

  // ---------- 5. 同名多旧节点：只合并第一个，其余原样保留 ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "ca", level: "chapter", parentId: "v1", order: 0, title: "第一章", intent: "前" }),
      N({ id: "cb", level: "chapter", parentId: "v1", order: 1, title: "第一章", intent: "后" }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第一章", intent: "合", scenes: [{ title: "幕A" }] }] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    const upd = p.fieldUpdates.filter((u) => u.id === "ca" || u.id === "cb");
    t.eq(upd.length, 1, "两个同名旧章只合并一个");
    t.eq(upd[0].id, "ca", "按组内序先到先得");
    t.eq(p.stats.kept, 1, "另一个同名章保留（计入 kept）");
  }

  // ---------- 6. 标题归一后匹配（全角/空格/书名号差异） ----------
  {
    const existing = [N({ id: "v1", level: "volume", order: 0, title: "《 归去来 》" })];
    const draft = D([{ title: "归去来", chapters: [] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.eq(p.creates.length, 0, "书名号+空格差异仍识别为同一卷");
  }

  // ---------- 7. 层级不许错配（同名不同 level = 各自存在） ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "s9", level: "scene", parentId: "v1", order: 0, title: "第一章" }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第一章", scenes: [] }] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.eq(p.creates.filter((n) => n.level === "chapter").length, 1, "旧的是幕、草稿是章 → level 不同按新建");
    t.eq(p.stats.kept, 1, "旧同名幕保留");
  }

  // ---------- 8. 节拍勾选候选 = 新建空幕 ∪ 命中的旧空幕 ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章" }),
      N({ id: "sOld", level: "scene", parentId: "c1", order: 0, title: "旧空幕" }),
      N({ id: "sBusy", level: "scene", parentId: "c1", order: 1, title: "有拍幕", beats: [{ id: "b", text: "x" }] }),
    ];
    const draft = D([
      { title: "卷一", chapters: [{ title: "第一章", scenes: [{ title: "旧空幕" }, { title: "有拍幕" }, { title: "新幕" }] }] },
    ]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    t.ok(p.newEmptySceneIds.includes("sOld"), "命中的旧空幕进候选");
    t.ok(!p.newEmptySceneIds.includes("sBusy"), "有节拍的幕不进候选");
    t.eq(p.newEmptySceneIds.length, 2, "候选=旧空幕+新幕");
  }

  // ---------- 9. 草稿乱序：命中按草稿序重排，未提旧节点垫尾 ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章" }),
      N({ id: "c2", level: "chapter", parentId: "v1", order: 1, title: "第二章" }),
      N({ id: "c3", level: "chapter", parentId: "v1", order: 2, title: "第三章" }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第三章", scenes: [] }, { title: "第一章", scenes: [] }] }]);
    const p = planDraftMerge(existing, draft, { projectId: "p", uid });
    const o1 = p.orderUpdates.find((u) => u.id === "c1");
    const o3 = p.orderUpdates.find((u) => u.id === "c3");
    const o2 = p.orderUpdates.find((u) => u.id === "c2");
    t.ok(o3 && o3.order === 0, "草稿第一=第三章 → 排 0");
    t.ok(o1 && o1.order === 1, "第一章跟随草稿序 → 排 1");
    t.ok(!o2 || o2.order === 2, "草稿没提的第二章垫尾");
    t.eq(p.stats.kept, 1, "第二章计入 kept");
  }

  // ---------- 10. 非法草稿 → 空计划不抛 ----------
  {
    for (const bad of [null, undefined, {}, { volumes: [] }, { volumes: "x" }]) {
      const p = planDraftMerge([N({ id: "v1", level: "volume", title: "v" })], bad, { projectId: "p", uid });
      t.eq(p.creates.length + p.fieldUpdates.length + p.orderUpdates.length, 0, "非法草稿零写集");
      t.eq(p.stats.kept, 1, "非法草稿 kept=全部");
    }
  }

  // ---------- 11. cast 名→id 映射透传（masterToNodes 行为） ----------
  {
    const existing = [
      N({ id: "v1", level: "volume", order: 0, title: "卷一" }),
      N({ id: "c1", level: "chapter", parentId: "v1", order: 0, title: "第一章" }),
      N({ id: "s1", level: "scene", parentId: "c1", order: 0, title: "幕A" }),
    ];
    const draft = D([{ title: "卷一", chapters: [{ title: "第一章", scenes: [{ title: "幕A", cast: ["阿明"] }] }] }]);
    const p = planDraftMerge(existing, draft, {
      projectId: "p", uid, charactersByName: { 阿明: "char1" },
    });
    const upd = p.fieldUpdates.find((u) => u.id === "s1");
    t.ok(upd && upd.patch.cast?.[0] === "char1", "cast 按名映射成 id 写入补丁");
  }
}
