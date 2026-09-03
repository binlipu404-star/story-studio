// ST 聊天记录导入解析测试（chatlog.ts：parseStChat / toTranscript）
import { parseStChat, toTranscript } from "../../dist-test/st/chatlog.js";

// ---------- fixture：JSONL（元数据头 + 普通消息 + swipe-only 消息 + 坏行 + System 行） ----------
const JSONL = [
  JSON.stringify({ chat_metadata: { chat_id: "c1", user_name: "旅行者", title: "试跑" }, last_mes: 2 }),
  JSON.stringify({ name: "旅行者", mes: "你好，摩根娜。", is_user: true, swipes: ["你好，摩根娜。"], swipe_id: 0 }),
  JSON.stringify({ name: "摩根娜", mes: "", is_user: false, swipes: ["初次回复：雨落了。", "改写后的回复：雨更大了。"], swipe_id: 1 }),
  "{{{坏行这不是JSON",
  "",
  JSON.stringify({ name: "System", mes: "（会话已切换）", is_user: false }),
  JSON.stringify({ name: "旅行者", mes: "第二句", is_user: true, extra: { type: "ooc" } }),
].join("\n");

// ---------- fixture：{"messages":[...]} 单对象 ----------
const WRAPPED = JSON.stringify({
  chat_metadata: { chat_id: "x" },
  user_name: "旅行者",
  messages: [
    { user_name: "旅行者" }, // 带 user_name 键的条目 → 跳过
    { name: "摩根娜", mes: "你终于来了。", is_user: false },
    { name: "旅行者", mes: "我来了。", is_user: true },
    { name: "旁白", mes: "（系统注入）", is_user: false, is_system: true },
  ],
});

// ---------- fixture：顶层数组 ----------
const AS_ARRAY = JSON.stringify([
  { name: "旅行者", mes: "a", is_user: true },
  { name: "摩根娜", mes: "b" },
  { chat_metadata: {} }, // 元数据条目 → 跳过
  { name: "System", mes: "c", is_system: true },
]);

// ---------- fixture：宽容规则混合（is_system 优先/无名兜底/字符串布尔/swipe 兜底） ----------
const MIXED = [
  JSON.stringify({ name: "旁白", mes: "系统文本", is_system: true, is_user: true }),
  JSON.stringify({ mes: "裸用户消息", is_user: true }),
  JSON.stringify({ mes: "裸角色消息" }),
  JSON.stringify({ name: "U2", mes: "m", is_user: "1" }),
  JSON.stringify({ name: "A", mes: "", swipes: ["零号回复", "一号"], swipe_id: 0 }),
].join("\n");

export default async function (t) {
  // ===== JSONL 主路径 =====
  const msgs = parseStChat(JSONL, "chat.jsonl");
  t.eq(msgs.length, 4, "JSONL：元数据行与坏行被跳过，剩 4 条消息");
  t.eq(msgs.map((m) => m.role), ["user", "char", "system", "user"], "JSONL：角色判定与顺序");
  t.eq(msgs.map((m) => m.isUser), [true, false, false, true], "JSONL：isUser 逐条一致");
  t.eq(msgs[0], { name: "旅行者", content: "你好，摩根娜。", isUser: true, role: "user" }, "JSONL：首条消息全字段");
  t.eq(msgs[1], { name: "摩根娜", content: "改写后的回复：雨更大了。", isUser: false, role: "char" }, "mes 空 → swipes[swipe_id]");
  t.eq(msgs[2].role, "system", "name=System → role system");
  t.eq(msgs[2].isUser, false, "system 行 isUser=false");
  t.eq(msgs[3].content, "第二句", "带 extra 的消息正常解析");
  t.eq(parseStChat(JSONL).length, 4, "缺省 fileName 时同一 JSONL 结果一致");

  // ===== toTranscript =====
  const tr = toTranscript(msgs);
  t.eq(tr, "旅行者：你好，摩根娜。\n摩根娜：改写后的回复：雨更大了。\n旅行者：第二句", "转写：名字：内容 每行、跳过 system");
  t.ok(!tr.includes("会话已切换") && !tr.includes("System"), "转写不含 system 内容");
  t.eq(toTranscript([]), "", "空数组 → 空串");

  // ===== {"messages":[...]} 单对象 =====
  const wrapped = parseStChat(WRAPPED, "chat.json");
  t.eq(wrapped.length, 3, "{messages}：取内层列表，user_name 条目被跳过");
  t.eq(wrapped.map((m) => m.role), ["char", "user", "system"], "{messages}：角色判定");
  t.eq(wrapped[2].name, "旁白", "is_system=true → system（名字保留）");
  t.eq(parseStChat(WRAPPED).length, 3, "{messages} 缺省 fileName 也能识别");
  t.eq(parseStChat(WRAPPED, "lying.jsonl").length, 3, ".jsonl 文件名提示下 {messages} 单行仍能整体解析");

  // ===== 顶层数组 =====
  const arr = parseStChat(AS_ARRAY);
  t.eq(arr.length, 3, "顶层数组：元数据条目被跳过");
  t.eq(arr.map((m) => m.role), ["user", "char", "system"], "顶层数组：角色判定与顺序");

  // ===== 宽容规则混合 =====
  const mixed = parseStChat(MIXED, "mixed.jsonl");
  t.eq(mixed.length, 5, "混合：5 条全部有效");
  t.eq(mixed[0].role, "system", "is_system 优先于 is_user");
  t.eq(mixed[0].isUser, false, "is_system 压过 is_user → isUser=false");
  t.eq(mixed[1].name, "用户", "缺 name 的 user → 兜底名「用户」");
  t.eq(mixed[2].name, "角色", "缺 name 的 char → 兜底名「角色」");
  t.eq(mixed[2].role, "char", "无 is_user → char");
  t.eq(mixed[3].isUser, true, 'is_user:"1" 字符串宽容为真');
  t.eq(mixed[4].content, "零号回复", "mes 空且缺省 swipe_id → swipes[0]");

  // ===== swipe 兜底与坏消息 =====
  t.eq(parseStChat('{"name":"A","mes":"   ","swipes":["兜底"]}', "s.jsonl").map((m) => m.content), ["兜底"], "mes 纯空白 → swipe 兜底");
  t.eq(parseStChat('{"name":"A","mes":"","swipes":["x"],"swipe_id":5}', "s.jsonl"), [], "swipe_id 越界 → 无内容消息跳过");
  t.eq(parseStChat('{"name":"A","mes":"","swipes":[]}', "s.jsonl"), [], "无内容且空 swipes → 跳过");
  t.eq(parseStChat('{"name":"A"}', "s.jsonl"), [], "无 mes 无 swipes → 跳过");

  // ===== 坏输入/空输入：一律 [] 不抛 =====
  t.eq(parseStChat("坏行\n更坏\n{{{"), [], "全部坏行 → []");
  t.eq(parseStChat(""), [], "空串 → []");
  t.eq(parseStChat("   \n\t\n "), [], "纯空白 → []");
  t.eq(parseStChat("\uFEFF"), [], "仅 BOM → []");
  t.eq(parseStChat("[]"), [], "空数组文本 → []");
  t.eq(parseStChat('{"messages":[]}'), [], "{messages:[]} → []");
  t.eq(parseStChat('{"chat_metadata":{"user_name":"x"}}'), [], "仅元数据对象 → []");
  t.eq(parseStChat(JSONL, "chat.jsonl").length, 4, "重复解析结果稳定（纯函数）");

  // ===== BOM + 首尾空白容错 =====
  t.eq(parseStChat("\uFEFF  " + JSONL + "\n\n").length, 4, "BOM 与首尾空白不影响解析");
}
