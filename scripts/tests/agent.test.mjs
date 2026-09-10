// 场记 agent 纯逻辑测试（agent.ts：SSE 分片累积/工具执行/权限面/指令块）
// v8-A：自动节拍标记下线（AUTO_MARK_ENABLED=false，只摘线不删码）——断言随开关分支，翻牌即回。
import {
  createToolCallAccumulator,
  runScriptTool,
  SCRIPT_TOOLS,
  SCRIPT_KIT_DIRECTIVE,
  AUTO_MARK_ENABLED,
  toolLabel,
} from "../../dist-test/flow/agent.js";

const snap = {
  sourceTitle: "灯塔",
  takenAt: 1,
  nodesUpdatedAt: 1,
  scenes: [
    { nodeId: "s1", path: "卷 › 章 › 幕一", title: "幕一", intent: "立疑", beats: [{ id: "b1", text: "匕首失踪" }, { id: "b2", text: "对质" }], foreshadows: [{ id: "f1", setup: "钥匙" }] },
    { nodeId: "s2", path: "卷 › 章 › 幕二", title: "幕二", intent: "逃亡", beats: [{ id: "b3", text: "出海" }], foreshadows: [] },
  ],
};

export default async function (t) {
  // 1. 工具面锁定（v8-A：自动标记下线时物理剔除 mark_beat），且没有任何改主纲的能力
  {
    const names = SCRIPT_TOOLS.map((s) => s.function.name);
    const want = AUTO_MARK_ENABLED
      ? "read_outline,get_progress,mark_beat,where_is_story,set_brief,next_step,read_ledger,append_ledger"
      : "read_outline,get_progress,where_is_story,set_brief,next_step,read_ledger,append_ledger";
    t.eq(names.join(","), want, "1. 工具面锁定（随 AUTO_MARK_ENABLED 开关）");
    t.ok(!names.some((n) => /outline_write|update_node|edit_node|set_status/i.test(n)), "1. 物理无主纲写工具");
    t.ok(SCRIPT_KIT_DIRECTIVE.includes("只作用于剧组副本"), "1. 指令块声明边界");
    if (!AUTO_MARK_ENABLED) {
      t.ok(!SCRIPT_KIT_DIRECTIVE.includes("mark_beat"), "1. 下线时指令块不再宣传 mark_beat");
      t.ok(SCRIPT_KIT_DIRECTIVE.includes("手动故事指针"), "1. 下线时指令块指认新正源");
    }
  }

  // 2. SSE tool_calls 分片累积（首片 id+name，后续 arguments 拼接；多调用按 index）
  {
    const acc = createToolCallAccumulator();
    acc.feed({ content: "好" });
    acc.feed({ tool_calls: [{ index: 0, id: "c1", function: { name: "mark_be", arguments: '{"beat_' } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { name: "at", arguments: 'id":"b1","stat' } }] });
    acc.feed({ tool_calls: [{ index: 0, function: { arguments: 'us":"done"}' } }] });
    acc.feed({ tool_calls: [{ index: 1, id: "c2", function: { name: "where_is_story", arguments: "{}" } }] });
    const out = acc.result();
    t.eq(out.length, 2, "2. 两个调用");
    t.eq(out[0].function.name, "mark_beat", "2. name 分片拼接");
    t.eq(JSON.parse(out[0].function.arguments).beat_id, "b1", "2. arguments 分片拼回");
    t.eq(out[1].id, "c2", "2. 第二调用 id");
    const bad = createToolCallAccumulator();
    bad.feed({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }); // 无 id/name 残片
    bad.feed(null);
    bad.feed({ tool_calls: "垃圾" });
    t.eq(bad.result().length, 0, "2. 残片与垃圾不产出");
  }

  // 3. mark_beat：上线时=合法/非法/未知 id/副作用回调；下线时=拒止且零副作用
  {
    const marks = [];
    const ctx = { snapshot: snap, progress: {}, canon: [], onMarkBeat: (id, st, note) => marks.push([id, st, note].join("|")) };
    if (!AUTO_MARK_ENABLED) {
      const denied = runScriptTool(ctx, "mark_beat", '{"beat_id":"b1","status":"done"}');
      t.ok(denied.result.includes("停用") && denied.result.includes("故事指针"), "3. 下线 → 拒止并指认指针");
      t.eq(marks.length, 0, "3. 下线 → 零副作用");
    } else {
      const ok = runScriptTool(ctx, "mark_beat", '{"beat_id":"b1","status":"done","note":"第12楼演到"}');
      t.ok(ok.result.includes("已记录") && ok.result.includes("主纲未受影响"), "3. 合法标记+免责说明");
      t.eq(marks[0], "b1|done|第12楼演到", "3. 副作用回调");
      const bad = runScriptTool(ctx, "mark_beat", '{"beat_id":"bX","status":"done"}');
      t.ok(bad.result.includes("副本里没有"), "3. 未知 id 纠错");
      t.eq(marks.length, 1, "3. 未知 id 不触发副作用");
      t.ok(runScriptTool(ctx, "mark_beat", "坏JSON").result.includes("不是合法 JSON"), "3. 坏 JSON 容错");
      t.ok(runScriptTool(ctx, "mark_beat", '{"beat_id":"b1","status":"炸"}').result.includes("不合法"), "3. 非法 status");
    }
  }

  // 4. 读工具与推进（progress 变化反映到结果）
  {
    const ctx = { snapshot: snap, progress: { b1: "done" }, canon: [{ id: "g1", projectId: "p", type: "event", content: "A 烧了信", actors: ["A"], status: "confirmed", createdAt: 1 }] };
    t.ok(runScriptTool(ctx, "read_outline", '{"scope":"current"}').result.includes("[✓] 匕首失踪"), "4. current 窗口含已完成标记");
    const prog = runScriptTool(ctx, "get_progress", "{}");
    t.ok(prog.result.includes("拍 1/3"), "4. 推进计数");
    const nxt = runScriptTool(ctx, "next_step", "{}");
    t.ok(nxt.result.includes("对质"), "4. 下一拍=对质");
    t.ok(runScriptTool(ctx, "where_is_story", "{}").result.includes("幕一"), "4. 位置在幕一");
    t.ok(runScriptTool(ctx, "read_ledger", '{"query":"烧"}').result.includes("A 烧了信"), "4. 台账过滤命中");
    t.ok(runScriptTool(ctx, "read_ledger", '{"query":"不存在的词"}').result.includes("暂无匹配"), "4. 无匹配提示");
  }

  // 4b. v8-A：ctx.pointer 穿透——where_is_story/next_step 认作者指针
  {
    const allDone = { b1: "done", b2: "done", b3: "done" };
    // 指针指末幕（第 2 幕）→ 尽头语义随指针
    const atEnd = runScriptTool({ snapshot: snap, progress: allDone, canon: [], pointer: 1 }, "where_is_story", "{}");
    t.ok(atEnd.result.includes("作者指针") && atEnd.result.includes("幕二"), "4b. 位置=作者指针指认的幕二");
    const nxtEnd = runScriptTool({ snapshot: snap, progress: allDone, canon: [], pointer: 1 }, "next_step", "{}");
    t.ok(nxtEnd.result.includes("作者指针停在最后一幕"), "4b. next_step 尽头文案认指针");
    // 无指针 = 旧自动推导文案（逐字节不变）
    const auto = runScriptTool({ snapshot: snap, progress: allDone, canon: [] }, "where_is_story", "{}");
    t.ok(auto.result.includes("所有节拍已标记完成") && !auto.result.includes("作者指针"), "4b. 无指针=旧自动推导文案");
    const nxtAuto = runScriptTool({ snapshot: snap, progress: allDone, canon: [] }, "next_step", "{}");
    t.ok(nxtAuto.result.includes("副本节拍已全部标记完成"), "4b. next_step 无指针=旧文案");
    // 指针指中间幕且有未拍 → 正常"下一拍"语义（此 snap 仅两幕，中间幕=第 0 幕）
    const mid = runScriptTool({ snapshot: snap, progress: { b1: "done" }, canon: [], pointer: 0 }, "next_step", "{}");
    t.ok(mid.result.includes("幕一") && mid.result.includes("对质"), "4b. 指针幕的下一拍=该幕未标拍");
  }

  // 5. append_ledger 校验与副作用
  {
    const added = [];
    const ctx = { snapshot: snap, progress: {}, canon: [], onAppendLedger: (it) => added.push(it.type + ":" + it.content) };
    const ok = runScriptTool(ctx, "append_ledger", '{"type":"item","content":"匕首在靴筒","actors":["薇薇安",42,""]}');
    t.ok(ok.result.includes("已写入"), "5. 合法写入");
    t.eq(added[0], "item:匕首在靴筒", "5. actors 净化不阻碍写入");
    t.ok(runScriptTool(ctx, "append_ledger", '{"type":"xxx","content":"x"}').result.includes("不合法"), "5. 非法 type");
    t.ok(runScriptTool(ctx, "append_ledger", '{"type":"event","content":"  "}').result.includes("不合法"), "5. 空正文");
    t.eq(added.length, 1, "5. 非法不触发副作用");
  }

  // 5a. v8-C·T3-P3 台账防重：同文案（空白归一）拒止且零副作用
  {
    const added = [];
    const canon = [{ id: "g1", projectId: "p", type: "event", content: "A  烧了 信", actors: [], status: "confirmed", createdAt: 1 }];
    const ctx = { snapshot: snap, progress: {}, canon, onAppendLedger: (it) => added.push(it.content) };
    const dup = runScriptTool(ctx, "append_ledger", '{"type":"event","content":"A 烧了 信"}');
    t.ok(dup.result.includes("台账已有同条"), "5a. 同文案拒止（空白归一后比对）");
    t.eq(added.length, 0, "5a. 重复不触发副作用");
    t.ok(runScriptTool(ctx, "append_ledger", '{"type":"event","content":"B 到了"}').result.includes("已写入"), "5a. 新文案照写");
    t.eq(added.length, 1, "5a. 新文案副作用一次");
  }

  // 5b. v8-B set_brief：写入/超长截 150/空文拒止/副作用回调
  {
    const briefs = [];
    const ctx = { snapshot: snap, progress: {}, canon: [], onSetBrief: (t) => briefs.push(t) };
    t.ok(runScriptTool(ctx, "set_brief", '{"text":"薇薇安已起疑，下一拍让她搜査薇薇安的行踪；注意正典：匕首在靴筒"}').result.includes("已更新"), "5b. 合法简报");
    t.eq(briefs.length, 1, "5b. 副作用一次");
    runScriptTool(ctx, "set_brief", '{"text":"' + "长".repeat(200) + '"}');
    t.ok(briefs[1].length === 151 && briefs[1].endsWith("…"), "5b. 200 字截为 150+省略号");
    t.eq(runScriptTool(ctx, "set_brief", '{"text":"  "}').result.includes("不合法"), true, "5b. 空白简报拒止");
    t.eq(briefs.length, 2, "5b. 拒止不触发副作用");
    t.ok(toolLabel("set_brief", { text: "x" }).includes("导演简报"), "5b. 活动流标签");
  }

  // 6. 未知工具 / 沙盒
  {
    const ctx = { snapshot: { sourceTitle: "", takenAt: 0, nodesUpdatedAt: 0, scenes: [] }, progress: {}, canon: [] };
    t.ok(runScriptTool(ctx, "hack_main_outline", "{}").result.includes("未知工具"), "6. 未知工具拒止");
    t.ok(runScriptTool(ctx, "read_outline", "{}").result.includes("沙盒"), "6. 沙盒读取提示");
    t.ok(runScriptTool(ctx, "next_step", "{}").result.includes("沙盒"), "6. 沙盒无下一步");
  }

  // 7. 活动流标签
  t.eq(toolLabel("mark_beat", { beat_id: "b1", status: "done" }), "标记节拍 b1 → done", "7. 标记标签");
  t.eq(toolLabel("read_ledger", {}), "read_ledger", "7. 读类用原名");
}
