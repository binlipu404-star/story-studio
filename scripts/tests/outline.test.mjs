// 大纲树纯逻辑测试
import {
  validatePlacement,
  canTransition,
  childrenOf,
  preorder,
  lineageOf,
  subtreeIds,
  sceneSequence,
  masterToNodes,
  beatsFromStrings,
  treeToMarkdown,
  applyRecapToNode,
  reweaveBeats,
} from "../../dist-test/flow/outline.js";

let seq = 0;
const uid = () => `id${++seq}`;

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

const MASTER = {
  logline: "匕首认主，旧仇将醒",
  volumes: [
    {
      title: "卷一·雨",
      intent: "建置",
      chapters: [
        {
          title: "第一章",
          intent: "相遇",
          scenes: [
            { title: "荒庙", intent: "相认", location: "荒庙", timepoint: "雨夜", cast: ["A", "幽灵"], beats: ["发现匕首", "对峙"] },
            { title: "山道", intent: "结伴", cast: ["A", "B"], beats: ["下山"] },
          ],
        },
      ],
    },
    { title: "卷二·火", chapters: [] },
  ],
};

export default async function (t) {
  // 放置校验
  t.eq(validatePlacement({ level: "volume" }, null), null, "卷挂根合法");
  t.ok(validatePlacement({ level: "volume" }, { id: "x", level: "volume" }), "卷不能挂卷下");
  t.eq(validatePlacement({ level: "scene" }, { id: "x", level: "chapter" }), null, "幕挂章下合法");
  t.eq(validatePlacement({ level: "scene" }, { id: "x", level: "volume" }), null, "幕跳级挂卷下允许（结构不禁止）");
  t.ok(validatePlacement({ level: "chapter" }, { id: "x", level: "chapter" }), "章不能挂章下");
  t.ok(validatePlacement({ level: "scene" }, null), "幕必须有上级");
  t.ok(validatePlacement({ id: "a", level: "beat" }, { id: "b", level: "scene" }, (pid) => pid === "b"), "拒绝移入自身子树");

  // 状态机
  t.ok(canTransition("tested", "locked"), "tested→locked");
  t.ok(!canTransition("draft", "locked"), "draft 不能直接锁定");
  t.ok(canTransition("locked", "refined"), "解锁自由");

  // 总纲映射
  const chars = { A: "charA", B: "charB" };
  const m = masterToNodes(MASTER, "p1", { charactersByName: chars, uid, now: () => 100 });
  t.eq(m.nodes.length, 1 + 1 + 2 + 1, "节点数=2卷+1章+2幕");
  const byTitle = Object.fromEntries(m.nodes.map((n) => [n.title, n]));
  t.eq(byTitle["荒庙"].cast, ["charA"], "cast 按名解析为 id，幽灵被警告");
  t.ok(m.warnings.some((w) => w.includes("幽灵") && w.includes("荒庙")), "未知角色给警告不丢弃");
  t.eq(byTitle["荒庙"].beats.length, 2, "beats 映射");
  t.eq(byTitle["荒庙"].location, "荒庙", "location 映射");
  t.eq(byTitle["第一章"].parentId, byTitle["卷一·雨"].id, "父子链正确");
  t.eq(m.logline, "匕首认主，旧仇将醒", "logline 提取");
  t.ok(m.nodes.every((n) => n.status === "draft" && n.projectId === "p1"), "初始状态=draft");
  let threw = false;
  try {
    masterToNodes({ foo: 1 }, "p", { uid });
  } catch {
    threw = true;
  }
  t.ok(threw, "非法形态抛错");
  const m2 = masterToNodes(MASTER, "p1", { uid });
  t.eq(m2.warnings.length, 4, "没有人物库时 cast 全部警告（2+2）");

  // 遍历
  const tree = m.nodes;
  t.eq(
    preorder(tree).map((n) => n.title),
    ["卷一·雨", "第一章", "荒庙", "山道", "卷二·火"],
    "前序=上演顺序",
  );
  t.eq(lineageOf(tree, byTitle["荒庙"].id).map((n) => n.title), ["卷一·雨", "第一章", "荒庙"], "血缘链");
  t.eq(subtreeIds(tree, byTitle["第一章"].id).length, 3, "子树含自身");
  t.eq(sceneSequence(tree).map((n) => n.title), ["荒庙", "山道"], "幕序列");
  t.eq(childrenOf(tree, byTitle["卷一·雨"].id).map((n) => n.title), ["第一章"], "childrenOf");

  // markdown 导出
  const md = treeToMarkdown(tree);
  t.ok(md.startsWith("# 卷·卷一·雨"), "卷为一级标题");
  t.ok(md.includes("## 章·第一章"), "章为二级标题");
  t.ok(md.includes("### 幕·荒庙") && md.includes("1. 发现匕首"), "幕与节拍进 markdown");
  t.ok(treeToMarkdown(tree, byTitle["荒庙"].id).startsWith("# 幕·荒庙"), "单节点导出");

  // 回写映射
  const scene = N({
    id: "s1",
    title: "荒庙",
    beats: [
      { id: "b1", text: "发现匕首" },
      { id: "b2", text: "对峙" },
      { id: "b3", text: "结盟" },
    ],
  });
  const recap = {
    summary: "两人对峙后不欢而散",
    beatStatus: [
      { beat: "发现匕首", status: "hit", evidence: "A 在神像下摸到匕首" },
      { beat: "对峙", status: "partial", evidence: "只交锋两句" },
      { beat: "结盟", status: "missed" },
    ],
    divergences: [
      { desc: "B 提前暴露身份", severity: "major", suggestion: "update_outline" },
      { desc: "雨势描写更凶", severity: "minor", suggestion: "accept" },
    ],
  };
  const app = applyRecapToNode(scene, recap);
  t.eq(app.beatUpdates, [
    { id: "b1", done: true },
    { id: "b2", done: false },
    { id: "b3", done: false },
  ], "仅 hit 标 done");
  t.eq(app.hitRate, 0.5, "命中率 partial 计半：(1+0.5)/3");
  t.eq(app.suggestedStatus, "tested", "建议状态 tested");
  t.eq(app.majorCount, 1, "重大偏差计数");
  t.ok(app.divergenceReport[0].includes("重大偏差") && app.divergenceReport[0].includes("update_outline"), "偏差报告格式");
  const noBeat = applyRecapToNode(N({ beats: [] }), recap);
  t.eq(noBeat.hitRate, null, "无节拍场景 hitRate=null");
  const weird = applyRecapToNode(scene, { beatStatus: [{ beat: "不存在的拍", status: "hit" }] });
  t.eq(weird.beatUpdates, [], "比对不上的节拍忽略");

  // 反向修纲草案
  const rewoven = reweaveBeats(scene, recap);
  t.eq(rewoven[0].done, true, "hit 节拍保留并标 done");
  t.ok(rewoven[1].text.includes("实际：只交锋两句"), "未中节拍附实际走向");
  t.eq(rewoven[2].text, "结盟", "missed 且无 evidence 的保持原文");

  // beatsFromStrings
  const bs = beatsFromStrings([" 甲 ", "", 42, "乙"], uid);
  t.eq(bs.map((b) => b.text), ["甲", "乙"], "trim+过滤非串");
}
