// 节拍词条化（L3）冒烟测试
import { BEAT_GROUP, beatBookJson, beatsToEntries, extractBeatKeys } from "../../dist-test/flow/beats2book.js";

const BEATS = [
  { id: "b1", text: "A 在神像下发现「匕首」" },
  { id: "b2", text: "B 冒雨闯入，与 A 对峙", done: true },
  { id: "b3", text: "摩根娜认出了他，然后离开" },
  { id: "b4", text: "He finds the dagger at the altar" },
  { id: "b5", text: "他离开了" },
];
const CAST = ["摩根娜", "A", "B"];

export default async function (t) {
  // 1. 触发词抽取
  const k1 = extractBeatKeys("A 在神像下发现「匕首」", CAST);
  t.ok(k1.includes("匕首"), "1. 引号短语优先：" + JSON.stringify(k1));
  const k2 = extractBeatKeys("他终于拔出了匕首", CAST);
  t.ok(k2.includes("匕首"), "1. 短句尾词兜底：" + JSON.stringify(k2));
  const k3 = extractBeatKeys("双方突然", CAST);
  t.ok(!k3.includes("突然"), "1. 动词/虚词尾停用：" + JSON.stringify(k3));
  const k4 = extractBeatKeys("He finds the dagger", []);
  t.ok(k4.includes("dagger") && !k4.includes("the"), "1. 英文词抽取：" + JSON.stringify(k4));
  const k5 = extractBeatKeys("摩根娜离开了", CAST);
  t.ok(k5.length === 1 && k5[0] === "摩根娜", "1. 人名仅在全空时兜底：" + JSON.stringify(k5));
  t.eq(extractBeatKeys("他离开了", CAST).length, 0, "1. 人名不在文本中 → 空");
  t.ok(extractBeatKeys("「甲」「乙」「丙」「丁」", CAST).length <= 3, "1. 触发词数量上限 3");

  // 2. 条目字段预设
  const { entries, keysByBeat } = beatsToEntries(BEATS, CAST);
  t.eq(entries.length, 4, "2. done 节拍默认剔除（5-1=4 条）");
  const e1 = entries[0];
  t.eq(e1.depth, 1, "2. depth=1 深度注入");
  t.eq(e1.sticky, 4, "2. sticky=4");
  t.eq(e1.cooldown, 6, "2. cooldown=6");
  t.eq(e1.position, "after_char", "2. after_char");
  t.eq(e1.group, BEAT_GROUP, "2. 同组互斥（同轮只出一条）");
  t.ok(e1.comment.startsWith("节拍 1/5·"), "2. 全幕编号注释：" + e1.comment);
  t.ok(e1.content.includes("第 1/5 拍"), "2. 指令文本含编号");
  // 权重：靠前拍高
  const w = entries.filter((e) => e.group === BEAT_GROUP).map((e) => e.groupWeight);
  t.ok(w.every((x, i) => i === 0 || x < w[i - 1]), "2. groupWeight 按拍序递减：" + w.join(","));
  // 兜底：b5「他离开了」无触发词 → constant
  const fb = entries[entries.length - 1];
  t.ok(fb.constant && fb.keys.length === 0 && fb.group === "", "2. 无触发词 → 蓝灯 constant 不入组");
  t.eq(keysByBeat.length, 4, "2. keysByBeat 与条目对齐");

  // 3. includeDone
  t.eq(beatsToEntries(BEATS, CAST, { includeDone: true }).entries.length, 5, "3. includeDone 全量成条");

  // 4. 导出 JSON = ST 全局 world info 形态
  const { json } = beatBookJson(BEATS, CAST);
  const raw = JSON.parse(json);
  const uids = Object.keys(raw.entries);
  t.ok(uids.join(",") === "1,2,3,4", "4. uid 数字字符串键：" + uids.join(","));
  const first = raw.entries["1"];
  t.eq(first.sticky, 4, "4. sticky 完整导出（数字）");
  t.eq(first.cooldown, 6, "4. cooldown 完整导出");
  t.eq(first.depth, 1, "4. depth 完整导出");
  t.ok(Array.isArray(first.key) && first.key.includes("匕首"), "4. key 数组导出：" + JSON.stringify(first.key));
  t.eq(first.disable, false, "4. disable=false");
}
