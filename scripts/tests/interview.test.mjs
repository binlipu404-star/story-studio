// 构思档案更新状态机测试
import { mergeBibleUpdates, firstFocus, bibleProgress } from "../../dist-test/flow/interview.js";

const F = (p) => ({ key: "k", label: "K", group: "组", value: "", status: "empty", deps: [], ...p });

const CHAIN = () => [
  F({ key: "genre", label: "题材", status: "confirmed", value: "东方玄幻复仇" }),
  F({ key: "world", label: "世界规则", deps: ["genre"], status: "rough", value: "灵力复苏" }),
  F({ key: "premise", label: "主线一句话", deps: ["world", "genre"], status: "rough", value: "主角复仇发现仇人是恩人" }),
  F({ key: "ending", label: "结局意向", deps: ["premise"], status: "confirmed", value: "悲剧净透" }),
  F({ key: "pov", label: "叙事视角", status: "empty" }),
];

export default async function (t) {
  // 上游改动 → 下游传递标 stale
  const r1 = mergeBibleUpdates(CHAIN(), [{ key: "genre", value: "都市怪异", status: "confirmed" }]);
  const g = Object.fromEntries(r1.fields.map((f) => [f.key, f]));
  t.eq(g.genre.status, "confirmed", "直接更新生效");
  t.eq([g.world.status, g.premise.status, g.ending.status], ["stale", "stale", "stale"], "传递闭包全标 stale");
  t.eq(r1.staleKeys, ["world", "premise", "ending"], "staleKeys 记录（按依赖发现序）");
  t.eq(r1.changedKeys, ["genre"], "changedKeys");
  t.eq(r1.ignored, [], "无忽略项");

  // 本轮同步更新的下游不标 stale；空字段不标
  const r2 = mergeBibleUpdates(CHAIN(), [
    { key: "genre", value: "都市怪异" },
    { key: "premise", value: "新主线", status: "rough" },
    { key: "pov", value: "第一人称" }, // 本轮刚填的空字段
  ]);
  const h = Object.fromEntries(r2.fields.map((f) => [f.key, f]));
  t.eq(h.premise.status, "rough", "本轮更新的下游保留新状态");
  t.eq(h.pov.status, "confirmed", "未标 status 默认 confirmed");
  t.eq(h.ending.status, "stale", "更下游照常 stale");
  t.ok(r2.staleKeys.includes("world") && r2.staleKeys.includes("ending") && !r2.staleKeys.includes("premise"), "world/ending 标 stale，premise 本轮已更新不标");

  // 忽略项与无变化
  const r3 = mergeBibleUpdates(CHAIN(), [
    { key: "不存在", value: "x" },
    { key: "genre", value: "   " },
    { key: "genre", value: "东方玄幻复仇", status: "confirmed" }, // 原样
  ]);
  t.eq(r3.ignored, ["不存在", "genre"], "未知 key 与空值被忽略");
  t.eq(r3.changedKeys, [], "无变化不记改动");
  t.eq(mergeBibleUpdates(CHAIN(), null).fields.length, 5, "null 更新不炸");
  const src = CHAIN();
  mergeBibleUpdates(src, [{ key: "genre", value: "X" }]);
  t.eq(src[0].value, "东方玄幻复仇", "不修改入参（纯函数）");

  // firstFocus：empty > rough > stale，同级按序
  t.eq(firstFocus(CHAIN())?.key, "pov", "先找空缺");
  t.eq(firstFocus([F({ key: "a", status: "rough", value: "v" }), F({ key: "b", status: "stale", value: "v" })])?.key, "a", "粗略优先于待复查");
  t.eq(firstFocus([F({ key: "c", status: "confirmed", value: "v" })]), null, "全确认无焦点");

  // 进度
  t.eq(bibleProgress(CHAIN()), 0.6, "1+0.5+0.5+1+0 = 3/5");
  t.eq(bibleProgress([]), 0, "空档案 0");
  t.eq(bibleProgress([F({ status: "stale", value: "x" })]), 0.25, "stale 计 0.25");
}
