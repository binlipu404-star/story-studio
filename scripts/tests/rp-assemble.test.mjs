// flow/rp.ts N2 组装管线 v2 冒烟测试（预算队列/保护段/摘要/滚动规划）
import { estimateTokens } from "../../dist-test/ai/tokenizer.js";
import {
  planRollingSummary,
  rpAssemble,
  rpSystemPrompt,
  rpSystemSections,
  turnsTranscript,
} from "../../dist-test/flow/rp.js";

function lore(partial = {}) {
  return {
    id: partial.id ?? `id-${partial.uid ?? 0}`,
    projectId: "p1",
    uid: 0,
    comment: "",
    content: "default content",
    keys: ["x"],
    secondaryKeys: [],
    constant: false,
    selective: false,
    caseSensitive: false,
    matchWholeWord: false,
    position: "before_char",
    order: 100,
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
    ...partial,
  };
}

const LORE_SETTINGS = { scanDepth: 2, tokenBudget: 1e9, recursiveScanning: false };

function setup(over = {}) {
  return {
    charName: "薇薇安",
    userName: "黎明",
    description: "守灯人，冷峻寡言。",
    personality: "外冷内热。",
    scenario: "废弃灯塔。",
    exampleDialogue: "<START>\n薇薇安：灯不能灭。\n黎明：我不会让它灭。",
    personaBlock: "名字：黎明\n身份：旅人",
    authorNote: "保持悬疑基调。",
    systemExtra: "本幕目标：找到地窖入口。",
    loreEntries: [lore({ uid: 1, constant: true, content: "灯塔建于1899年。" })],
    loreSettings: LORE_SETTINGS,
    ...over,
  };
}

const t0 = (role, content) => ({ role, name: role === "user" ? "黎明" : "薇薇安", content });

export default async function (t) {
  // 1. 兼容：无 ledger/summary 时 system 组装内容与既有标记一致
  {
    const sys = rpSystemPrompt(setup());
    for (const probe of ["（这是一个虚构的文学角色扮演", "本幕目标", "【当前场景】", "你是 薇薇安。", "身份：旅人", "【对话范例", "【作者注释"]) {
      t.ok(sys.includes(probe), "1. system 含段：" + probe.slice(0, 8));
    }
    t.ok(sys.indexOf("身份：旅人") < sys.indexOf("【对话范例"), "1. 画像在范例之前");
  }

  // 2. ledgerBlock 注入位置：画像后、范例前；缺省不出现
  {
    const sys = rpSystemPrompt(setup({ ledgerBlock: "【台账快照】\n- [事件] A烧了信" }));
    t.ok(sys.includes("【台账快照·正典事实】") && sys.includes("A烧了信"), "2. 台账段出现");
    t.ok(sys.indexOf("身份：旅人") < sys.indexOf("【台账快照·正典事实】") && sys.indexOf("【台账快照·正典事实】") < sys.indexOf("【对话范例"), "2. 位于画像后范例前");
    t.ok(!rpSystemPrompt(setup()).includes("台账"), "2. 缺省无台账段");
  }

  // 2b. userNameHint（v3.1 用户实名段）：出现于画像之后、宏已替换、缺省不出现
  {
    const sys = rpSystemPrompt(setup({ userNameHint: "【玩家实名】一律用「{{user}}」称呼玩家。" }));
    t.ok(sys.includes("【玩家实名】") && sys.includes("「黎明」称呼玩家"), "2b. 实名段出现且宏替换");
    t.ok(sys.indexOf("身份：旅人") < sys.indexOf("【玩家实名】"), "2b. 位于画像之后");
    t.ok(!rpSystemPrompt(setup()).includes("玩家实名"), "2b. 缺省无实名段");
  }

  // 2c. bibleBlock（v3.2 构思档案段）：位置在世界书·背景之前（稳定前缀区）、缺省不出现
  {
    // 位置契约要经 rpAssemble 验（世界书·背景段只在扫描命中后才存在，须带 constant 词条的 setup 走全程）
    const fat = rpAssemble(setup({ bibleBlock: "【构思档案·作品定位】\n- 题材与类型：蒸汽朋克悬疑" }), [t0("char", "开场白"), t0("user", "你好")]);
    const sys = fat.messages[0].content;
    t.ok(sys.includes("蒸汽朋克悬疑"), "2c. 档案段出现");
    t.ok(sys.indexOf("蒸汽朋克悬疑") < sys.indexOf("【世界书·背景】"), "2c. 位于世界书之前（可缓存前缀区）");
    const keys = fat.sections.map((s) => s.key);
    t.ok(keys.indexOf("bible") < keys.indexOf("loreBefore"), "2c. 分段序：bible 紧邻 loreBefore 之前");
    t.ok(!rpSystemPrompt(setup()).includes("构思档案"), "2c. 缺省无档案段");
    // 裁序：档案(4) 比对话范例(5) 更低，先被裁
    const a = rpAssemble(setup({ bibleBlock: "【构思档案·作品定位】\n- 题材：ZZZ" }), [t0("char", "开场白"), t0("user", "你好")], { budgetTokens: 350, reserveTokens: 100 });
    const byKey = new Map(a.sections.map((s) => [s.key, s]));
    t.ok(!byKey.get("bible").kept, "2c. 预算吃紧档案段最先裁（先于范例）");
    t.ok(!a.messages[0].content.includes("ZZZ"), "2c. 被裁档案不进 messages");
  }

  // 3. rpAssemble 默认预算：全保留，历史逐条映射
  {
    const turns = [t0("char", "开场白"), t0("user", "你好"), t0("char", "嗯"), t0("user", "地窖在哪")];
    const a = rpAssemble(setup(), turns);
    t.ok(!a.overflow && a.droppedTurns === 0, "3. 默认预算不裁");
    t.ok(a.messages[0].content.includes("【世界书·背景】") && a.messages[0].content.includes("灯塔建于1899年"), "3. constant 词条进背景段");
    t.eq(a.messages.length, 1 + 4, "3. system + 4 条历史");
    t.eq(a.messages[1].role, "assistant", "3. char→assistant");
    t.eq(a.messages[4].role, "user", "3. 末条 user");
    const hist = a.sections.find((s) => s.key === "history");
    t.eq(hist.tokens, turns.reduce((n, x) => n + estimateTokens(x.content), 0), "3. 历史 token = 逐条和");
  }

  // 4. 预算队列裁序：examples(5) 先裁，保护段永裁
  {
    const a = rpAssemble(setup(), [t0("char", "开场白"), t0("user", "你好")], { budgetTokens: 350, reserveTokens: 100 });
    const byKey = new Map(a.sections.map((s) => [s.key, s]));
    t.ok(!byKey.get("examples").kept, "4. 对话范例最先被裁");
    for (const k of ["roleDirective", "extra", "card", "authorNote"]) {
      t.ok(byKey.get(k).kept, "4. 保护段保留：" + k);
    }
    const sysSent = a.messages[0].content;
    t.ok(!sysSent.includes("【对话范例"), "4. 被裁段不进 messages");
    t.ok(sysSent.includes("本幕目标"), "4. 本幕指引仍在");
    t.eq(byKey.get("examples").note, "已裁：超预算，低优先级", "4. 被裁原因可见");
  }

  // 5. 摘要为保护段；历史有 keepTurns 兜底（极端小预算下面试确定性断言）
  {
    const long = [t0("char", "开场".repeat(50))];
    for (let i = 0; i < 12; i++) long.push(i % 2 ? t0("char", "回复".repeat(60)) : t0("user", "行动".repeat(60)));
    const a = rpAssemble(setup(), long, { budgetTokens: 10, reserveTokens: 0, keepTurns: 4, summary: "A 烧了信，来到灯塔。" });
    t.ok(a.messages[1].content.includes("【前情摘要】"), "5. 摘要紧跟 system");
    t.eq(a.messages.length - 2, 4, "5. 预算再怎么极端也保 keepTurns=4 条最近历史");
    t.eq(a.droppedTurns, 9, "5. 裁掉其余 9 条旧历史");
    t.ok(a.overflow === true, "5. 裁无可裁如实报 overflow");
    t.ok(a.messages[0].content.includes("守灯人") && a.messages[0].content.includes("角色扮演"), "5. 保护段全部在场");
    t.ok(a.sections.find((s) => s.key === "history").note.includes("已裁"), "5. 历史段有裁切注记");
    // 宽松预算下：不裁历史、全段在场
    const b = rpAssemble(setup(), long, { budgetTokens: 100000 });
    t.eq(b.droppedTurns, 0, "5. 预算充足不裁历史");
    t.ok(b.sections.every((s) => s.kept), "5. 预算充足全保留");
  }

  // 6. planRollingSummary：阈值/收尾对齐/keep 下限
  {
    const turns = [];
    turns.push(t0("char", "很长的开场白".repeat(40)));
    for (let i = 0; i < 8; i++) turns.push(i % 2 ? t0("char", "答".repeat(30)) : t0("user", "问".repeat(30)));
    t.eq(planRollingSummary(turns, { thresholdTokens: 1e9, keepTurns: 4 }), null, "6. 未达阈值不折叠");
    const plan = planRollingSummary(turns, { thresholdTokens: 50, keepTurns: 4 });
    t.ok(plan, "6. 达阈值给出折叠计划");
    t.eq(plan.rollup[plan.rollup.length - 1].role, "char", "6. 折叠段以 char 收尾");
    t.ok(plan.keep.length >= 4 && plan.rollup.length + plan.keep.length === turns.length, "6. 不丢回合");
    // 末条是 user 时：折叠边界回退，keep 以 user 开头无碍
    const plan2 = planRollingSummary([...turns, t0("user", "新行动")], { thresholdTokens: 50, keepTurns: 4 });
    t.ok(plan2 && plan2.keep[plan2.keep.length - 1].role === "user", "6. 用户待发回合必在 keep 侧");
  }

  // 7. turnsTranscript：跳过 system 与空条
  {
    const s = turnsTranscript([t0("char", "甲"), { role: "system", name: "", content: "旁路" }, t0("user", ""), t0("user", "乙")]);
    t.ok(s.includes("甲") && s.includes("乙") && !s.includes("旁路"), "7. 转写过滤正确");
  }

  // 8. composeAuthorNote：base+纠偏列表重建（N3 注入纠偏的核）
  {
    const { composeAuthorNote } = await import("../../dist-test/flow/rp.js");
    t.eq(composeAuthorNote(undefined, []), "", "8. 全空=空串");
    const one = composeAuthorNote("基调悬疑。", ["薇薇安先不说话"]);
    t.ok(one.startsWith("基调悬疑。") && one.endsWith("【纠偏】薇薇安先不说话"), "8. base 在前纠偏在后");
    const two = composeAuthorNote("基调悬疑。", ["旧令", "新令"].slice(-1));
    t.ok(!two.includes("旧令") && two.includes("【纠偏】新令"), "8. 限流由列表负责，重建无残留");
  }
}
