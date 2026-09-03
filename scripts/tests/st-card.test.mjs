// st 兼容层冒烟测试：先编译（npm run build:logic 或等效 tsc 命令），
// 再 node scripts/run-tests.mjs。fixture 内联构造，贴近真实 ST 导出形态。
import { existsSync, readFileSync } from "node:fs";
import {
  exportEmbeddedBook,
  exportLorebookGlobal,
  lorebookDefaults,
  normalizeLorebook,
  toLoreEntries,
} from "../../dist-test/st/lorebook.js";
import {
  exportCardV2,
  extractPngCardJson,
  importCardBytes,
  parseCardJsonText,
  parsedCardToCharacter,
} from "../../dist-test/st/card.js";

const PNG_PATH =
  "D:\\deepseek harness\\station(dsh)\\素材\\main_morgana-she-summoned-you-a95cfc0121e1_spec_v2.png";

// ---------- fixtures ----------

// v2 卡：description 为 st-novel-tool 标签行格式；内嵌 character_book(v2) 2 条
const V2_LABEL_DESC =
  "外貌：银白长发、琥珀竖瞳的魔女。\n" +
  "性格：慵懒、毒舌，但对契约者绝对忠诚。\n" +
  "背景：被都市召唤阵意外唤醒的高位魔女，失去部分记忆。\n" +
  "说话风格：短句，喜用反问与昵称。";

const V2_CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: {
    name: "摩根娜",
    description: V2_LABEL_DESC,
    personality: "慵懒、毒舌，但对契约者绝对忠诚。",
    scenario: "现代都市，深夜的旧图书馆。",
    first_mes: "*月光穿过彩窗* ……是你把我唤醒的？那么，契约成立。",
    mes_example:
      "<START>\n{{user}}: 你是谁？\n{{char}}: 连救命恩人的脸都敢忘？呵。\n<START>\n{{user}}: 今晚想吃什么？\n摩根娜: 你负责买，我负责点评。",
    creator_notes: "测试卡",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: ["*打哈欠* 又是新的一天，新的麻烦。"],
    tags: ["fantasy", "romance"],
    creator: "story-studio-test",
    character_version: "1.0",
    extensions: { depth_prompt: { depth: 2, prompt: "以文学化笔法描写。" }, locale: "zh-CN" },
    character_book: {
      name: "morgana-book",
      description: "内嵌世界书",
      scan_depth: 3,
      token_budget: 1024,
      recursive_scanning: false,
      extensions: {},
      entries: [
        {
          keys: ["摩根娜", "morgana"],
          secondary_keys: ["契约"],
          content: "摩根娜是本作女主，高位魔女。",
          constant: true,
          selective: true,
          insertion_order: 10,
          case_sensitive: false,
          name: "摩根娜",
          enabled: true,
          position: 0,
          id: 0,
          extensions: { ttl: true },
        },
        {
          keys: "旧图书馆,library",
          secondary_keys: [],
          content: "故事发生地的旧图书馆。",
          constant: false,
          selective: false,
          insertion_order: 20,
          case_sensitive: null,
          name: "旧图书馆",
          enabled: true,
          position: 1,
          id: 1,
          extensions: {},
        },
      ],
    },
  },
};

// v1 扁平卡（无 spec）
const V1_CARD = {
  name: "老卡角色",
  description: "一个 v1 扁平卡。",
  personality: "谨慎",
  scenario: "",
  first_mes: "你好，旅行者。",
  mes_example: "<START>\n旅行者: 你好\n老卡角色: 小心脚下的路。",
  creator_notes: "",
  system_prompt: "",
  post_history_instructions: "",
  tags: [{ name: "legacy", category: "char" }],
  character_version: "3",
  extensions: {},
};

// v3 卡：带未知字段（assets/variables/顶层未知键）
const V3_CARD = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "V3 角色",
    description: "d",
    personality: "p",
    scenario: "s",
    first_mes: "f",
    mes_example: "",
    creator_notes: "n",
    system_prompt: "",
    post_history_instructions: "",
    alternate_greetings: [],
    tags: [],
    creator: "c",
    character_version: "1",
    extensions: { v3: true },
    assets: [{ type: "icon", uri: "https://example.com/i.png", checksum: "abcd" }],
    variables: {},
    nickname: "",
  },
  other_top_level: { whatever: 1 },
};

// ST 全局 world info（字符串键 map；key 为 "a,b" 字符串；disable 反义；position 数字；含 null 坏条目）
const GLOBAL_WORLD_INFO = {
  entries: {
    "0": {
      uid: 0,
      key: "摩根娜,morgana ",
      keysecondary: ["契约", ""],
      comment: "主角",
      content: "高位魔女，被召唤而至。",
      constant: true,
      selective: true,
      order: 5,
      position: 1,
      disable: true,
      sticky: 2,
      cooldown: 3,
      probability: 80,
      useProbability: true,
      group: "主角组",
      groupOverride: false,
      groupWeight: 120,
      scanDepth: null,
      caseSensitive: null,
      matchWholeWords: null,
      excludeRecursion: false,
      preventRecursion: true,
      role: 0,
      depth: 2,
      extensions: { ttl: true },
    },
    "1": {
      uid: 1,
      key: [],
      keysecondary: "旧图书馆",
      comment: "地点",
      text: "legacy 字段：text 代替 content。", // content 的 legacy 别名
      constant: false,
      selective: false,
      order: 8,
      position: 0,
      disable: false,
      probability: 100,
      useProbability: false,
      group: "",
      groupOverride: true,
      groupWeight: 100,
      depth: 4,
    },
    "2": null, // ST 导出里出现过的空洞：应跳过而非抛异常
  },
};

function bufToArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// ---------- 测试 ----------

export default async function (t) {
  // 1. v2 卡 + 内嵌 character_book(2 条)
  const p2 = parseCardJsonText(JSON.stringify(V2_CARD));
  t.eq(p2.format, "v2", "1. spec=chara_card_v2 → format v2");
  t.eq(p2.name, "摩根娜", "1. name 解析");
  t.eq(p2.firstMes, V2_CARD.data.first_mes, "1. first_mes → firstMes");
  t.eq(p2.description, V2_LABEL_DESC, "1. description 原样");
  t.eq(p2.embeddedBook !== null, true, "1. embeddedBook 非空");
  if (p2.embeddedBook) {
    const book = p2.embeddedBook;
    t.eq(book.entries.length, 2, "1. 内嵌书 2 条");
    const e0 = book.entries[0];
    t.eq(e0.keys, ["摩根娜", "morgana"], "1. embedded keys 数组透传");
    t.eq(e0.secondaryKeys, ["契约"], "1. secondary_keys 透传");
    t.eq(e0.position, "before_char", "1. position 0 → before_char");
    t.eq(e0.constant, true, "1. constant 透传");
    t.eq(e0.insertionOrder, 10, "1. insertion_order → insertionOrder");
    t.eq(e0.comment, "摩根娜", "1. embedded name 兜底 comment");
    t.eq(e0.enabled, true, "1. enabled 直读");
    t.eq(e0.uid, 0, "1. embedded id → uid");
    const e1 = book.entries[1];
    t.eq(e1.keys, ["旧图书馆", "library"], "1. keys 字符串按逗号拆分");
    t.eq(e1.position, "after_char", "1. position 1 → after_char");
    t.eq(book.scanDepth, 3, "1. scan_depth → scanDepth");
    t.eq(book.tokenBudget, 1024, "1. token_budget → tokenBudget");
    t.eq(book.recursiveScanning, false, "1. recursive_scanning 透传");
  }

  // 2. v1 扁平卡 + greeting 兜底 + 缺 spec 的 {data} 畸形
  const p1 = parseCardJsonText(JSON.stringify(V1_CARD));
  t.eq(p1.format, "v1", "2. 无 spec 扁平卡 → v1");
  t.eq(p1.name, "老卡角色", "2. v1 name");
  t.eq(p1.firstMes, "你好，旅行者。", "2. v1 first_mes");
  t.eq(p1.tags, ["legacy"], "2. v1 tags[{name}] → 字符串数组");
  t.eq(p1.embeddedBook, null, "2. 无 character_book → null");
  t.eq(p1.creatorNotes, undefined, "2. 空 creator_notes → undefined");
  const pg = parseCardJsonText(JSON.stringify({ name: "g", greeting: "hi", description: "d" }));
  t.eq(pg.firstMes, "hi", "2. legacy greeting 兜底 firstMes");
  t.eq(pg.tags, [], "2. 缺 tags → 空数组");
  const pf = parseCardJsonText(JSON.stringify({ data: { name: "缺spec" } }));
  t.eq(pf.format, "v2", "2. {data} 缺 spec 畸形卡按 v2 解析");
  t.eq(pf.name, "缺spec", "2. 畸形卡 data.name 可读");

  // 3. v3 卡带未知字段
  const p3 = parseCardJsonText(JSON.stringify(V3_CARD));
  t.eq(p3.format, "v3", "3. spec=chara_card_v3 → format v3");
  t.eq(p3.name, "V3 角色", "3. v3 name");
  t.eq(p3.extensions.v3, true, "3. v3 extensions");
  t.ok(Array.isArray(p3.raw.data.assets) && p3.raw.data.assets.length === 1, "3. raw 保留未知字段 assets");
  t.eq(p3.raw.other_top_level.whatever, 1, "3. raw 保留顶层未知键");
  t.eq(p3.embeddedBook, null, "3. v3 无书 → null");

  // 4. 全局 world info 规范化
  const g = normalizeLorebook(GLOBAL_WORLD_INFO);
  t.eq(g.entries.length, 2, "4. null 坏条目被跳过");
  const g0 = g.entries[0];
  t.eq(g0.keys, ["摩根娜", "morgana"], "4. key 字符串拆分+trim");
  t.eq(g0.secondaryKeys, ["契约"], "4. keysecondary 数组过滤空串");
  t.eq(g0.enabled, false, "4. disable:true → enabled:false");
  t.eq(g0.position, "after_char", "4. position 数字1 → after_char");
  t.eq(g0.comment, "主角", "4. comment");
  t.eq(g0.insertionOrder, 5, "4. order → insertionOrder");
  t.eq(g0.depth, 2, "4. depth");
  t.eq(g0.sticky, 2, "4. sticky");
  t.eq(g0.group, "主角组", "4. group");
  t.eq(g0.groupWeight, 120, "4. groupWeight");
  t.eq(g0.preventRecursion, true, "4. preventRecursion");
  t.eq(g0.probability, 80, "4. probability");
  const g1 = g.entries[1];
  t.eq(g1.content, "legacy 字段：text 代替 content。", "4. legacy text → content");
  t.eq(g1.enabled, true, "4. disable:false → enabled:true");
  t.eq(g1.position, "before_char", "4. position 数字0 → before_char");
  t.eq(g1.secondaryKeys, ["旧图书馆"], "4. keysecondary 字符串形态");
  t.eq(g1.keys, [], "4. 空数组 key → 空数组");
  t.eq(lorebookDefaults(), { scanDepth: 4, tokenBudget: 2048, recursiveScanning: true }, "4. lorebookDefaults");

  // 5. toLoreEntries → exportLorebookGlobal → 再规范化往返稳定
  const lore1 = toLoreEntries(g, "p1", 0);
  t.eq(lore1.length, 2, "5. toLoreEntries 条数");
  t.eq(lore1[0].uid, 0, "5. uid 保留");
  t.eq(lore1[0].matchWholeWord, false, "5. matchWholeWords null → false");
  t.eq(lore1[0].useProbability, true, "5. useProbability 透传");
  const expA = exportLorebookGlobal(lore1);
  t.ok(expA.entries && typeof expA.entries === "object", "5. 导出为 {entries: map}");
  t.eq(expA.entries["0"].disable, true, "5. enabled:false → disable:true");
  t.eq(expA.entries["0"].position, 1, "5. position after_char → 数字1");
  const lore2 = toLoreEntries(normalizeLorebook(expA), "p1", 0);
  const expB = exportLorebookGlobal(lore2);
  t.eq(JSON.stringify(expA), JSON.stringify(expB), "5. 全局导出往返字节级稳定");
  t.eq(lore2[0].keys, lore1[0].keys, "5. keys 往返一致");
  t.eq(lore2[0].content, lore1[0].content, "5. content 往返一致");
  t.eq(lore2[0].comment, lore1[0].comment, "5. comment 往返一致");
  t.eq(lore2[0].enabled, lore1[0].enabled, "5. enabled 往返一致");
  t.eq(lore2[0].position, lore1[0].position, "5. position 往返一致");
  t.eq(lore2[0].order, lore1[0].order, "5. order 往返一致");
  // 内嵌书导出 + 往返
  const emb = exportEmbeddedBook(lore1, lorebookDefaults());
  t.eq(emb.entries.length, 2, "5. exportEmbeddedBook 条数");
  t.eq(emb.entries[0].position, 1, "5. 内嵌 position 数字");
  t.eq(emb.scan_depth, 4, "5. scan_depth 来自 settings");
  const embBack = toLoreEntries(normalizeLorebook(emb, "embedded"), "p1", 0);
  t.eq(embBack[0].keys, ["摩根娜", "morgana"], "5. 内嵌书往返 keys 一致");
  t.eq(embBack[0].position, "after_char", "5. 内嵌书往返 position 一致");

  // 6. exportCardV2 roundtrip
  const ch = parsedCardToCharacter(p2, "proj1");
  t.eq(ch.source, "st-import", "6. source=st-import");
  t.eq(ch.cardFormat, "v2", "6. cardFormat=v2");
  t.eq(ch.greeting, V2_CARD.data.first_mes, "6. greeting=firstMes");
  t.eq(ch.profile.personality, "慵懒、毒舌，但对契约者绝对忠诚。", "6. 「性格：」标签 → profile.personality");
  t.ok(ch.profile.appearance.includes("银白长发"), "6. 「外貌：」标签 → profile.appearance");
  t.eq(ch.profile.exampleLines.length, 4, "6. exampleLines 拆行去 <START>/前缀");
  t.ok(!ch.profile.exampleLines.some((l) => l.includes("<START>")), "6. exampleLines 无 <START> 残留");
  const out = exportCardV2(ch, p2.embeddedBook);
  t.eq(out.spec, "chara_card_v2", "6. 导出 spec");
  t.eq(out.spec_version, "2.0", "6. 导出 spec_version");
  t.eq(JSON.stringify(out.data.extensions), JSON.stringify(V2_CARD.data.extensions), "6. 原 extensions 保留");
  t.eq(out.data.alternate_greetings[0], V2_CARD.data.alternate_greetings[0], "6. alternate_greetings 保留");
  t.eq(out.data.creator_notes, "测试卡", "6. creator_notes 等底卡字段保留");
  t.eq(out.data.character_book.entries.length, 2, "6. book 挂入 data.character_book");
  const re = parseCardJsonText(JSON.stringify(out));
  t.eq(re.name, "摩根娜", "6. 往返 name 一致");
  t.eq(re.description, V2_LABEL_DESC, "6. 往返 description 一致（标签行重建）");
  t.eq(re.firstMes, V2_CARD.data.first_mes, "6. 往返 first_mes 一致");
  t.eq(parsedCardToCharacter(re, "proj1").greeting, ch.greeting, "6. 往返 greeting 一致");
  t.eq(re.embeddedBook !== null && re.embeddedBook.entries.length, 2, "6. 往返内嵌书 2 条");
  // 非 v2 rawCard → 新骨架导出
  const outManual = exportCardV2(parsedCardToCharacter(p1, "proj1"));
  t.eq(outManual.spec, "chara_card_v2", "6. v1 卡导出为 v2 骨架");
  t.eq(outManual.data.name, "老卡角色", "6. v1 → v2 name");

  // 7. 真实 PNG 卡
  if (!existsSync(PNG_PATH)) {
    t.skip("PNG 测试卡不存在：" + PNG_PATH);
  } else {
    const ab = bufToArrayBuffer(readFileSync(PNG_PATH));
    const jsonText = extractPngCardJson(ab);
    t.ok(typeof jsonText === "string" && jsonText.length > 50, "7. extractPngCardJson 提取到 chara tEXt");
    const pngCard = parseCardJsonText(jsonText);
    t.ok(typeof pngCard.name === "string" && pngCard.name.length > 0, "7. PNG 卡 name 非空：" + pngCard.name);
    t.ok(["v1", "v2", "v3"].includes(pngCard.format), "7. PNG 卡 format 合法：" + pngCard.format);
    const viaImport = await importCardBytes("main_morgana.png", ab);
    t.eq(viaImport.name, pngCard.name, "7. importCardBytes(.png) 与直接提取一致");
    const pngChar = parsedCardToCharacter(pngCard, "proj-png");
    t.ok(typeof pngChar.id === "string" && pngChar.id.length > 0, "7. PNG 卡 → Character 有 id");
    t.ok(pngChar.rawCard != null, "7. rawCard 原样保留");
  }

  // 8. 畸形输入不抛异常
  const badInputs = [
    null,
    undefined,
    42,
    "string",
    [],
    {},
    { foo: "bar" },
    { entries: "nope" },
    { entries: { a: null, b: 3 } },
    [{ key: "k", content: "ok" }, null, "x", 7, {}],
  ];
  for (const bad of badInputs) {
    let err = null;
    let r = null;
    try {
      r = normalizeLorebook(bad);
    } catch (e) {
      err = e;
    }
    t.ok(
      err === null && r !== null && Array.isArray(r.entries),
      `8. normalizeLorebook 不抛异常（输入 ${JSON.stringify(bad) ?? String(bad)}）`,
    );
  }
  const mixed = normalizeLorebook([{ key: "k", content: "ok" }, null, "x", 7, {}]);
  t.eq(mixed.entries.length, 1, "8. 坏条目跳过、好条目保留");
  t.eq(mixed.entries[0].content, "ok", "8. 保留好条目内容");
  // importCardBytes 全失败 → 带文件名的清晰错误
  let impErr = null;
  try {
    await importCardBytes("garbage.png", new ArrayBuffer(16));
  } catch (e) {
    impErr = e;
  }
  t.ok(impErr !== null && String(impErr.message).includes("garbage.png"), "8. 导入失败错误信息含文件名");
  // .json 后缀但内容是 PNG 兜底 / .png 后缀但内容是 JSON 兜底
  const jsonBytes = new TextEncoder().encode(JSON.stringify(V1_CARD)).buffer;
  const swapped = await importCardBytes("misnamed.png", jsonBytes);
  t.eq(swapped.name, "老卡角色", "8. .png 后缀但 JSON 内容兜底成功");

  // 9. 宽容字段识别（数组字段 / 英文标签 / 【】包裹 / 非标 appearance）
  const looseCard = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "凛",
      description:
        "【外貌】黑长直，红瞳，左眼下有泪痣。\n" +
        "【性格】外冷内热，嘴硬心软。\n" +
        "从小在道场长大，剑术天才。\n" +
        "说话方式：短句为主，偶尔夹杂古语。",
      personality: ["傲娇", "认真", "不坦率"],
      scenario: "修学旅行之夜",
      first_mes: "……你这么盯着我看干什么。",
      mes_example: "",
      appearance: "（非标顶层字段）银灰色的猫耳与尾巴是她的特征。",
    },
  };
  const loose = parsedCardToCharacter(parseCardJsonText(JSON.stringify(looseCard)), "p9");
  t.ok(loose.profile.appearance.includes("黑长直"), "9. 【外貌】括号标签行 → appearance");
  t.ok(loose.profile.personality.includes("傲娇"), "9. personality 数组 → 拼接（宽容）");
  t.ok(loose.profile.personality.includes("外冷内热"), "9. 性格标签补充进 personality");
  t.ok(loose.profile.background.includes("道场"), "9. 未命中标签的正文进 background 不丢失");
  t.ok(!loose.profile.background.includes("黑长直"), "9. background 不含已归入外貌的内容");
  t.eq(loose.profile.speechStyle, "短句为主，偶尔夹杂古语。", "9. 「说话方式：」中文同义标签 → speechStyle");
  // 非标顶层 appearance 字段捞取（description 没有外貌标签时生效）
  const extOnly = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        name: "无标签角色",
        description: "一个 description 完全自由的野生卡。",
        appearance: "白发红裙，撑一把黑伞。",
      }),
    ),
    "p9",
  );
  t.ok(extOnly.profile.appearance.includes("黑伞"), "9. 非标顶层 appearance 字段被识别");
  t.ok(extOnly.profile.background.includes("野生卡"), "9. 自由 description 兜底进 background");
  // extensions 里的 appearance 兜底
  const extDeep = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        spec: "chara_card_v2",
        data: { name: "Ext", description: "自由文本。", extensions: { appearance: "机械义肢左臂。" } },
      }),
    ),
    "p9",
  );
  t.ok(extDeep.profile.appearance.includes("机械义肢"), "9. extensions.appearance 兜底识别");
  // 英文标签不分大小写
  const enCard = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        name: "EN",
        description: "Appearance: tall, silver hair.\nPersonality: calm.\nSpeech style: terse.",
      }),
    ),
    "p9",
  );
  t.ok(enCard.profile.appearance.includes("silver hair"), "9. 英文 Appearance 标签识别");
  t.ok(enCard.profile.personality.includes("calm"), "9. 英文 Personality 标签识别");
  t.ok(enCard.profile.speechStyle.includes("terse"), "9. 英文 Speech style 标签识别");
  // 完全无线索 → appearance 留空（不臆造）
  const bare = parsedCardToCharacter(parseCardJsonText(JSON.stringify({ name: "B", description: "普通描述。" })), "p9");
  t.eq(bare.profile.appearance, "", "9. 无线索时 appearance 留空（不臆造）");
  t.eq(bare.profile.background, "普通描述。", "9. 无线索时 description 全进 background");

  // 10. WLAB 内联格式 + 裸标签章节 + 线索词兜底（真实卡高频形态）
  const wlab = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        name: "W",
        description:
          "Personality:(stoic + loyal) Voice:(British + rough) Appearance:(short blonde hair + brown eyes + scars on face + muscular body)",
      }),
    ),
    "p10",
  );
  t.ok(wlab.profile.appearance.includes("blonde hair"), "10. WLAB 内联 Appearance:(...) 提取");
  t.ok(wlab.profile.appearance.includes("muscular body"), "10. WLAB appearance 多项完整");
  t.ok(!wlab.profile.appearance.includes("British"), "10. WLAB 不把 Voice 混进 appearance");
  t.ok(wlab.profile.speechStyle.includes("British"), "10. WLAB Voice:(...) → speechStyle");
  // 裸标签章节：`# Appearance:` 独占一行，后续无标签正文归它
  const sect = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        name: "S",
        description: "# Appearance:\nTall, gaunt, wears a tattered cloak.\n# Personality:\nCalm and dry-witted.",
      }),
    ),
    "p10",
  );
  t.ok(sect.profile.appearance.includes("tattered cloak"), "10. 裸标签章节正文归 appearance");
  t.ok(!sect.profile.appearance.includes("dry-witted"), "10. 下一个标签起新章节，不串味");
  // 线索词兜底：无标签的自由散文，靠外貌词把相关短句挑出来
  const prose = parsedCardToCharacter(
    parseCardJsonText(
      JSON.stringify({
        name: "P",
        description: "She is a famed swordsman. She has silver hair and piercing green eyes. She trusts no one.",
      }),
    ),
    "p10",
  );
  t.ok(prose.profile.appearance.includes("silver hair"), "10. 散文兜底：外貌词短句被挑出");
  t.ok(!prose.profile.appearance.includes("trusts no one"), "10. 散文兜底：非外貌句不误收");
}
