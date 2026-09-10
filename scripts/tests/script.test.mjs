// 剧场剧本副本与推进测试（script.ts：快照/同步检测/进展/副本块/章选/定时/v8-A手动指针）
import {
  buildScriptSnapshot,
  detectMainScriptUpdate,
  describeMainScriptUpdate,
  mergeProgressOnSync,
  storyAdvance,
  resolveScenePointerIndex,
  remapPointerOnSync,
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

  // 2. 主纲变化检测（v7.1-W2：detect 升级为含删幕/新增幕；describe 给明细）
  {
    const snap = buildScriptSnapshot("T", [volume(), chapter(), scene()], [scene()], 100);
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter(), scene()]), false, "2. 未变 → false");
    const moved = scene({ updatedAt: 500 });
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter(), moved]), true, "2. 幕被改 → true");
    // v7.1-W2 改契约：删幕如今是变化信号（副本引用的幕没了，该提示同步）
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter()]), true, "2. 幕被删 → true（v7.1 改）");
    // 新增副本外的幕 → 也是变化（边写大纲边 RP：加了新幕要能提示）
    const extra = scene({ id: "s2", title: "新幕", updatedAt: 8 });
    t.eq(detectMainScriptUpdate(snap, [volume(), chapter(), scene(), extra]), true, "2. 新增幕 → true");
    const sandbox = buildScriptSnapshot("T", [], [], 100);
    t.eq(detectMainScriptUpdate(sandbox, [scene()]), false, "2. 沙盒组永不提示");
    // describe 明细
    const d1 = describeMainScriptUpdate(snap, [volume(), chapter(), scene({ updatedAt: 500 })]);
    t.eq(d1.edited.length, 1, "2d. 改 1 幕");
    t.eq(d1.removed.length, 0, "2d. 无删");
    t.eq(d1.added, 0, "2d. 无增");
    const d2 = describeMainScriptUpdate(snap, [volume(), chapter()]);
    t.eq(d2.removed.length, 1, "2d. 删 1 幕入 removed");
    t.ok(d2.removed[0] === "祭坛之夜", "2d. removed 带幕题");
    const d3 = describeMainScriptUpdate(snap, [volume(), chapter(), scene(), scene({ id: "s9", title: "插叙", updatedAt: 8 })]);
    t.eq(d3.added, 1, "2d. 副本外新幕计入 added");
    t.eq(d3.changed, true, "2d. added>0 也算 changed");
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

  // 4c. v8-A 手动故事指针：作者亲指优先、无拍幕不谎报、越界回落
  {
    const scenes = [scene(), scene({ id: "s2", title: "第二幕", beats: [] }), scene({ id: "s3", title: "第三幕", beats: [{ id: "b9", text: "收尾" }] })];
    const snap = buildScriptSnapshot("T", [volume(), chapter(), ...scenes], scenes, 100);
    // 4c.1 零拍幕不再被谎报成"演完"
    const a0 = storyAdvance(snap, {});
    t.eq(a0.scenesDone, 0, "4c1. 零拍幕不计入 scenesDone");
    t.eq(a0.finished, false, "4c1. 全副本无拍 → 绝不 finished（旧行为：开局谎报演尽）");
    // 4c.2 指针优先且改变当前幕
    const p1 = storyAdvance(snap, {}, 1);
    t.eq(p1.currentSceneIndex, 1, "4c2. 指针=第二幕");
    t.ok(p1.pointerActive, "4c2. pointerActive 标记");
    t.ok(p1.nextHint.includes("作者指针"), "4c2. 提示词说明来源=作者指针");
    t.ok(!p1.finished, "4c2. 指针在中间幕=未完");
    // 4c.3 指针顶到最后一幕 = finished（且文案区别于自动推导）
    const pLast = storyAdvance(snap, {}, 2);
    t.ok(pLast.finished && pLast.currentSceneIndex === 2, "4c3. 指针=末幕 → finished 且末幕");
    t.ok(pLast.nextHint.includes("作者指针"), "4c3. 尽头提示词说明指针");
    // 4c.4 越界/非法回落自动推导（=旧行为）
    const noPtr = storyAdvance(snap, { b9: "done" });
    t.eq(noPtr.currentSceneIndex, 0, "4c4. 无指针 → 第一幕未演完");
    t.ok(!storyAdvance(snap, {}, 99).pointerActive, "4c4. 越界指针回落自动推导");
    t.eq(resolveScenePointerIndex(-1, snap.scenes), null, "4c4. 负数非法");
    t.eq(resolveScenePointerIndex(1.7, snap.scenes), 1, "4c4. 小数取整");
    t.eq(resolveScenePointerIndex(NaN, snap.scenes), null, "4c4. NaN 非法");
    t.eq(resolveScenePointerIndex(undefined, snap.scenes), null, "4c4. 未指=回落");
    // 4c.5 副本块的 ▶ 标记跟随指针
    t.ok(scriptBlock(snap, {}, p1, 0, 0).includes("▶ 第二幕"), "4c5. 副本块 ▶ 随指针走");
    t.ok(scriptBlock(snap, {}, p1, 0, 0).includes("· 第三幕"), "4c5. 零拍幕标 · 而非 ✓");
    // 4c.6 进展备忘行带指针字样
    t.ok(progressMemoText(p1).includes("作者指针指向第 2/3 幕"), "4c6. 备忘行含指针标注");
    t.ok(progressMemoText(p1).includes("本幕无预设节拍"), "4c6. 零拍幕备忘=作者留白");
    t.ok(progressMemoText(pLast).includes("作者指针停在最后一幕"), "4c6. 尽头备忘区别于自动演尽");
    t.ok(!progressMemoText(a0).includes("作者指针"), "4c6. 自动推导时不提指针");
  }

  // 4d. v8-A 同步时指针按幕题重定位
  {
    const scenes = [scene(), scene({ id: "s2", title: "第二幕", beats: [] })];
    const old = buildScriptSnapshot("T", [volume(), chapter(), ...scenes], scenes, 100);
    const same = buildScriptSnapshot("T", [volume(), chapter(), ...scenes], scenes, 200);
    t.eq(remapPointerOnSync(1, old.scenes, same.scenes), 1, "4d. 同序=原位");
    const reordered = buildScriptSnapshot("T", [volume(), chapter(), ...scenes], [scenes[1], scenes[0]], 200);
    t.eq(remapPointerOnSync(0, old.scenes, reordered.scenes), 1, "4d. 重排=跟幕题走");
    t.eq(remapPointerOnSync(1, old.scenes, [scenes[0]]), undefined, "4d. 幕被删 → 回落自动");
    t.eq(remapPointerOnSync(undefined, old.scenes, same.scenes), undefined, "4d. 无指针=不动");
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

  // 8. 老剧组模式兜底
  t.eq(roomScope(undefined), "full", "8. 无字段按 full");
  t.eq(roomScope("chapters"), "chapters", "8. 显式保留");
}
