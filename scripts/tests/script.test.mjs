// 剧场剧本副本与推进测试（script.ts：快照/同步检测/进展/副本块/章选/定时）
import {
  buildScriptSnapshot,
  detectMainScriptUpdate,
  mergeProgressOnSync,
  storyAdvance,
  scriptBlock,
  progressMemoText,
  planLedgerCadence,
  scenesOfChapters,
  roomScope,
} from "../../dist-test/flow/script.js";

const scene = (over) => ({
  id: "s1", projectId: "p1", parentId: "c1", level: "scene", order: 0, title: "祭坛之夜",
  intent: "确认背叛", beats: [{ id: "b1", text: "匕首失踪", done: false }, { id: "b2", text: "对质", done: false }],
  cast: [], foreshadows: [{ id: "f1", setup: "匕首去向", status: "planted", payoffIn: null }],
  status: "draft", revision: 1, createdAt: 10, updatedAt: 10, ...over,
});
const chapter = (over) => ({
  id: "c1", projectId: "p1", parentId: "v1", level: "chapter", order: 0, title: "第一章",
  intent: "", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 5, updatedAt: 5, ...over,
});
const volume = (over) => ({
  id: "v1", projectId: "p1", parentId: null, level: "volume", order: 0, title: "卷一",
  intent: "", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 1, updatedAt: 1, ...over,
});

export default async function (t) {
  // 1. 快照构建：全路径/节拍引用/takenAt 基准
  {
    const nodes = [volume(), chapter(), scene()];
    const snap = buildScriptSnapshot("灯塔", nodes, [scene()], 100);
    t.eq(snap.sourceTitle, "灯塔", "1. 标题");
    t.eq(snap.scenes.length, 1, "1. 一幕");
    t.eq(snap.scenes[0].path, "卷一 › 第一章 › 祭坛之夜", "1. 全路径");
    t.eq(snap.scenes[0].beats.length, 2, "1. 两拍");
    t.eq(snap.nodesUpdatedAt, 10, "1. 基准=节点最大 updatedAt");
  }

  // 2. 主纲变化检测
  {
    const snap = buildScriptSnapshot("T", [volume(), chapter(), scene()], [scene()], 100);
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter(), scene()], 200), false, "2. 未变 → false");
    const moved = scene({ updatedAt: 500 });
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter(), moved], 200), true, "2. 幕被改 → true");
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter()], 200), false, "2. 幕被删 → false（不是变化信号）");
    const sandbox = buildScriptSnapshot("T", [], [], 100);
    t.eq(detectMainScriptUpdate(sandbox, [scene()], 200), false, "2. 沙盒房永不提示");
  }

  // 3. 同步时标记合并：孤儿标记清理、有效标记保留
  {
    const snap = buildScriptSnapshot("T", [volume(), chapter(), scene()], [scene()], 100);
    const merged = mergeProgressOnSync(snap, { b1: "done", bX: "skipped" });
    t.eq(JSON.stringify(merged), JSON.stringify({ b1: "done" }), "3. 保留 b1 丢弃孤儿");
  }

  // 4. 推进状态
  {
    const snap = buildScriptSnapshot("T", [volume(), chapter(), scene()], [scene()], 100);
    const a0 = storyAdvance(snap, {});
    t.eq(a0.currentSceneIndex, 0, "4. 初始第 0 幕");
    t.eq(a0.currentBeatId, "b1", "4. 下一拍 b1");
    t.eq(a0.finished, false, "4. 未完");
    t.ok(a0.nextHint.includes("匕首失踪"), "4. 提示含下一拍");
    const a1 = storyAdvance(snap, { b1: "skipped", b2: "done" });
    t.eq(a1.finished, true, "4. 全标记 → 演尽");
    t.eq(a1.currentSceneIndex, null, "4. 无当前幕");
    const two = buildScriptSnapshot("T", [volume(), chapter(), scene(), scene({ id: "s2", title: "第二幕", beats: [{ id: "b3", text: "出海" }] })],
      [scene(), scene({ id: "s2", title: "第二幕", beats: [{ id: "b3", text: "出海" }] })], 100);
    const a2 = storyAdvance(two, { b1: "done", b2: "done" });
    t.eq(a2.currentSceneIndex, 1, "4. 第一幕完 → 第二幕");
    t.eq(a2.scenesDone, 1, "4. 一幕完");
    t.eq(a2.beatsDone, 2, "4. 两拍完");
    const empty = buildScriptSnapshot("T", [], [], 100);
    t.ok(storyAdvance(empty, {}).nextHint.includes("沙盒"), "4. 沙盒提示");
    // 4b. 进展备忘行（v3.1-⑦ 注入台面的当前进度一行）
    t.eq(progressMemoText(a0), "【进展备忘】第 1/1 幕 · 拍 0/2；下一拍：匕首失踪", "4b. 备忘行含幕/拍/下一拍");
    t.ok(progressMemoText(a1).includes("全部演完"), "4b. 演尽提示");
    t.eq(progressMemoText(storyAdvance(empty, {})), "", "4b. 沙盒无幕 → 空串");
  }

  // 5. 副本块注入文本：窗口裁剪 + 完成/跳过/当前 标号
  {
    const s1 = scene();
    const s2 = scene({ id: "s2", title: "B", beats: [{ id: "b3", text: "x" }] });
    const s3 = scene({ id: "s3", title: "C", beats: [{ id: "b4", text: "y" }] });
    const s4 = scene({ id: "s4", title: "D", beats: [{ id: "b5", text: "z" }] });
    const snap = buildScriptSnapshot("T", [volume(), chapter(), s1, s2, s3, s4], [s1, s2, s3, s4], 100);
    const full = scriptBlock(snap, { b1: "skipped" }, storyAdvance(snap, { b1: "skipped" }), 0, 0);
    t.ok(full.includes("祭坛之夜") && full.includes("D"), "5. 全量模式含首尾幕");
    t.ok(full.includes("[跳] 匕首失踪"), "5. skipped 标 [跳]");
    t.ok(full.includes("▶ 祭坛之夜"), "5. 当前幕标 ▶");
    const win = scriptBlock(snap, { b1: "done", b2: "skipped" }, storyAdvance(snap, { b1: "done", b2: "skipped" }), 0, 2);
    t.ok(!win.includes("祭坛之夜"), "5. 窗口裁剪：当前幕之前 0 幕 → A 消失");
    t.eq(scriptBlock(buildScriptSnapshot("T", [], [], 1), {}, storyAdvance(buildScriptSnapshot("T", [], [], 1), {})), "", "5. 沙盒无块");
  }

  // 6. 楼层定时
  t.eq(planLedgerCadence(3, 5), false, "6. 未到层数");
  t.eq(planLedgerCadence(5, 5), true, "6. 到层数触发");
  t.eq(planLedgerCadence(99, 0), false, "6. cadence=0 关闭");
  t.eq(planLedgerCadence(2, NaN), false, "6. 非法 cadence 关闭");

  // 7. 章选：只收所选章的幕，文档序
  {
    const nodes = [
      volume(),
      chapter(),
      chapter({ id: "c2", order: 1, title: "第二章" }),
      scene({ id: "s1", order: 0 }),
      scene({ id: "s2", parentId: "c1", order: 1, title: "幕二" }),
      scene({ id: "s9", parentId: "c2", order: 0, title: "他章幕" }),
    ];
    const got = scenesOfChapters(nodes, ["c1"]).map((n) => n.id);
    t.eq(got.join(","), "s1,s2", "7. 只收本章节，按 order");
    t.eq(scenesOfChapters(nodes, ["c2"]).map((n) => n.id).join(","), "s9", "7. 另一章");
    t.eq(scenesOfChapters(nodes, []).length, 0, "7. 空选择");
  }

  // 8. 老房间模式兜底
  t.eq(roomScope(undefined), "full", "8. 无字段按 full");
  t.eq(roomScope("chapters"), "chapters", "8. 显式保留");
}
