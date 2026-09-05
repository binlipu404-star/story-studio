// 场记 agent 纯逻辑测试（agent.ts：SSE 分片累积/七工具执行/权限面/指令块）
import {
  createToolCallAccumulator,
  runScriptTool,
  SCRIPT_TOOLS,
  SCRIPT_KIT_DIRECTIVE,
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
  // 1. 工具面 = 恰好 7 个，且没有任何改主纲的能力
  {
    const names = SCRIPT_TOOLS.map((s) => s.function.name);
    t.eq(names.join(","), "read_outline,get_progress,mark_beat,where_is_story,next_step,read_ledger,append_ledger", "1. 工具面锁定");
    t.ok(!names.some((n) => /outline_write|update_node|edit_node|set_status/i.test(n)), "1. 物理无主纲写工具");
    t.ok(SCRIPT_KIT_DIRECTIVE.includes("只作用于剧组副本"), "1. 指令块声明边界");
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

  // 3. mark_beat：合法/非法/未知 id/副作用回调
  {
    const marks = [];
    const ctx = { snapshot: snap, progress: {}, canon: [], onMarkBeat: (id, st, note) => marks.push([id, st, note].join("|")) };
    const ok = runScriptTool(ctx, "mark_beat", '{"beat_id":"b1","status":"done","note":"第12楼演到"}');
    t.ok(ok.result.includes("已记录") && ok.result.includes("主纲未受影响"), "3. 合法标记+免责说明");
    t.eq(marks[0], "b1|done|第12楼演到", "3. 副作用回调");
    const bad = runScriptTool(ctx, "mark_beat", '{"beat_id":"bX","status":"done"}');
    t.ok(bad.result.includes("副本里没有"), "3. 未知 id 纠错");
    t.eq(marks.length, 1, "3. 未知 id 不触发副作用");
    t.ok(runScriptTool(ctx, "mark_beat", "坏JSON").result.includes("不是合法 JSON"), "3. 坏 JSON 容错");
    t.ok(runScriptTool(ctx, "mark_beat", '{"beat_id":"b1","status":"炸"}').result.includes("不合法"), "3. 非法 status");
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
