// 站内 RP 组装器（ST 默认标准）冒烟测试
import { applyMacros, rpMessages, rpSystemPrompt } from "../../dist-test/flow/rp.js";

const SETTINGS = { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true };

function mkEntry(over = {}) {
  return {
    id: "l_" + Math.random().toString(36).slice(2),
    projectId: "p1",
    uid: Math.floor(Math.random() * 1e6),
    comment: "",
    content: "词条正文",
    keys: [],
    secondaryKeys: [],
    constant: false,
    selective: false,
    caseSensitive: false,
    matchWholeWord: false,
    position: "before_char",
    order: 0,
    depth: null,
    sticky: null,
    cooldown: null,
    probability: 100,
    useProbability: false,
    group: "",
    groupOverride: false,
    groupWeight: 0,
    excludeRecursion: false,
    preventRecursion: false,
    enabled: true,
    extensions: {},
    ...over,
  };
}

const BASE = {
  charName: "凛",
  userName: "小美",
  description: "黑长直魔女，契约者是小美。",
  personality: "外冷内热。",
  scenario: "雨夜荒庙。",
  personaBlock: "名字：小美\n身份/背景：路人旅人",
  authorNote: "本场目标：把匕首伏笔落下。",
  loreEntries: [],
  loreSettings: SETTINGS,
};

export default async function (t) {
  // 1. 宏替换
  t.eq(applyMacros("{{char}}与{{USER}}还有{{ char }}", "凛", "小美"), "凛与小美还有凛", "1. 宏替换大小写/空格宽容");

  // 2. system 结构：主指令 → 世界书前 → 人物 → 画像 → 世界书后 → 作者注（置尾）
  const sys = rpSystemPrompt(BASE, "神庙旧事。", "追加禁忌。");
  const iBefore = sys.indexOf("【世界书·背景】");
  const iCard = sys.indexOf("【人物设定】");
  const iPersona = sys.indexOf("【小美（由用户扮演）】");
  const iAfter = sys.indexOf("【世界书·补充】");
  const iNote = sys.indexOf("【作者注释");
  t.ok(sys.startsWith("（这是一个虚构的文学角色扮演"), "2. 主指令开头");
  t.ok(-1 < iBefore && iBefore < iCard, "2. before_char 在人物卡之前");
  t.ok(iCard < iPersona, "2. 画像在人物卡之后");
  t.ok(iPersona < iAfter, "2. after_char 在画像之后");
  t.ok(iNote > iAfter && sys.trim().endsWith(BASE.authorNote), "2. 作者注在末尾");
  t.ok(!sys.includes("{{char}}") && !sys.includes("{{user}}"), "2. 产物无残留宏");

  // 3. rpMessages：历史映射 + 系统条唯一
  const turns = [
    { role: "char", name: "凛", content: "（撑伞而立）你也来避雨？" },
    { role: "user", name: "小美", content: "（看见她脚边的匕首）……这把刀？" },
  ];
  const r = rpMessages(BASE, turns);
  t.eq(r.messages[0].role, "system", "3. 首条是 system");
  t.eq(r.messages[1].role, "assistant", "3. char→assistant");
  t.eq(r.messages[2].role, "user", "3. user→user");
  t.eq(r.messages[1].content, turns[0].content, "3. 正文不附加名字前缀（ST chat 默认）");
  t.eq(r.injected.length, 0, "3. 无词条则零注入");

  // 4. 世界书每轮重扫：constant 必中；keyword 命中才进
  const setup2 = {
    ...BASE,
    loreEntries: [
      mkEntry({ comment: "always", content: "【设定】荒庙立于古战场。", constant: true, order: 1 }),
      mkEntry({ comment: "sword", content: "【设定】匕首是魔女的契约之物。", keys: ["匕首"], order: 2 }),
      mkEntry({ comment: "far", content: "【设定】龙裔王朝秘史。", keys: ["龙裔"], order: 3 }),
    ],
  };
  const hit = rpMessages(setup2, turns);
  const sysHit = hit.messages[0].content;
  t.eq(hit.injected.length, 2, "4. constant+关键词 命中 2 条");
  t.ok(sysHit.includes("古战场"), "4. constant 注入 system");
  t.ok(sysHit.includes("契约之物"), "4. 命中的关键词词条注入 system");
  t.ok(!sysHit.includes("龙裔王朝"), "4. 未命中关键词不注入");
  const miss = rpMessages(setup2, [turns[0], { role: "user", name: "小美", content: "这里塌了半边。" }]);
  t.eq(miss.injected.length, 1, "4. 换一轮无关键词 → 只剩 constant（每轮重扫）");

  // 5. 空历史：只有 system
  const only = rpMessages(BASE, []);
  t.eq(only.messages.length, 1, "5. 空历史只剩 system 一条");

  // 6. 预算裁切：dropped 有值且不注入
  const setup3 = {
    ...BASE,
    loreEntries: [mkEntry({ content: "很长的必中设定。".repeat(30), constant: true })],
    loreSettings: { ...SETTINGS, tokenBudget: 10 },
  };
  const tight = rpMessages(setup3, turns);
  t.eq(tight.injected.length, 0, "6. 超预算不注入");
  t.eq(tight.dropped.length, 1, "6. 超预算进 dropped");
}
