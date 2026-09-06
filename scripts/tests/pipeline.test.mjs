// 跨模块集成冒烟：M1→M3→M4 全链条（无 UI、无网络、无浏览器）
// 真实素材 → 卡解析 → 人物入库形态 → 总纲映射（cast 名解析）→ 树导出
// → 试跑包组装（含卡/世界书 JSON 与匹配引擎产物）→ 导回回写 → 卡 roundtrip
import { readFileSync, existsSync } from "node:fs";
import { parseCardJsonText, importCardBytes, parsedCardToCharacter, exportCardV2 } from "../../dist-test/st/card.js";
import { normalizeLorebook, toLoreEntries, exportLorebookGlobal, lorebookDefaults } from "../../dist-test/st/lorebook.js";
import { matchLore, buildLoreInjection } from "../../dist-test/st/matcher.js";
import { masterToNodes, treeToMarkdown, applyRecapToNode, reweaveBeats, sceneSequence } from "../../dist-test/flow/outline.js";
import { buildTrialPack } from "../../dist-test/flow/trialpack.js";
import { sessionRecapPrompt, masterOutlinePrompt } from "../../dist-test/ai/prompts.js";

// 同 st-card.test.mjs：环境变量 SS_TEST_PNG 或仓库内 docs/fixtures/morgana-spec-v2.png，缺失即回退内嵌卡
const PNG = process.env.SS_TEST_PNG ?? "docs/fixtures/morgana-spec-v2.png";

let seq = 0;
const uid = () => `u${++seq}`;
const est = (s) => Math.ceil(s.length / 4);

export default async function (t) {
  // ── 1. 真实卡 → Character（入库形态）──
  if (!existsSync(PNG)) {
    t.skip("真实 PNG 卡不存在，跳过后使用内嵌 v2 卡");
    const fallback = {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: { name: "Morgana", description: "占位", first_mes: "夜晚好。", character_book: { entries: [{ keys: ["魔女"], content: "魔女善用幻术。", insertion_order: 10, constant: true }] } },
    };
    t.eq(parseCardJsonText(JSON.stringify(fallback)).name, "Morgana", "回退卡可解析");
  }
  let parsed;
  if (existsSync(PNG)) {
    const bytes = readFileSync(PNG);
    parsed = await importCardBytes(PNG, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } else {
    parsed = parseCardJsonText(JSON.stringify({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Morgana", description: "占位" } }));
  }
  const char = parsedCardToCharacter(parsed, "proj1");
  t.ok(char.id && char.createdAt > 0 && char.source === "st-import", "Character 基础字段");
  const cardName = parsed.name;
  t.ok(cardName.length > 0, `卡名解析：${cardName}`);

  // ── 2. 内嵌世界书 → LoreEntry → 全局导出回导入 ──
  const book = parsed.embeddedBook ?? normalizeLorebook({ entries: [{ keys: [cardName], content: `${cardName}是个谜。`, constant: false }] }, "embedded");
  const entries = toLoreEntries(book, "proj1", 1);
  t.ok(entries.length >= 1 && entries.every((e) => e.projectId === "proj1"), "内嵌书转规范词条");
  const globalJson = exportLorebookGlobal(entries);
  const reEntries = toLoreEntries(normalizeLorebook(globalJson, "global"), "proj1", 1);
  t.eq(exportLorebookGlobal(reEntries), globalJson, "世界书全局导出往返字节稳定");

  // ── 3. 匹配引擎产出试跑用 loreBlock ──
  const settings = lorebookDefaults();
  const hit = matchLore(entries, settings, { history: [{ name: "旁白", content: `她望向${cardName}的居所` }] }, est);
  const loreBlock = buildLoreInjection(hit);
  t.ok(entries.some((e) => e.constant) ? loreBlock.length > 0 : true, "constant 词条进 loreBlock");

  // ── 4. 总纲 JSON（模拟 AI 产物）→ 节点，cast 用真卡角色名 ──
  const masterJson = {
    logline: `${cardName}的旧约到期之夜`,
    volumes: [{
      title: "卷一", intent: "建置",
      chapters: [{
        title: "第一章", intent: "相遇",
        scenes: [{
          title: "塔顶对峙", intent: "摊牌", location: "黑塔", timepoint: "午夜",
          cast: [cardName, "旅行者"],
          beats: [`${cardName}烧掉契约`, "旅行者拔剑", "契约灰烬复活"],
        }],
      }],
    }],
  };
  const mapping = masterToNodes(masterJson, "proj1", { charactersByName: { [char.name]: char.id }, uid });
  const nodes = mapping.nodes;
  t.eq(nodes.length, 3, "卷+章+幕");
  const scene = sceneSequence(nodes)[0];
  t.eq(scene.cast, [char.id], "cast 按卡名解析成 id");
  t.ok(mapping.warnings.some((w) => w.includes("旅行者")), "未入库角色给警告");
  const md = treeToMarkdown(nodes);
  t.ok(md.includes("幕·塔顶对峙") && md.includes("契约灰烬复活"), "大纲 markdown 可读导出");

  // ── 5. 试跑包：卡 JSON + 世界书 JSON + 匹配引擎 loreBlock ──
  const pack = buildTrialPack({
    packName: "塔顶对峙", scene, chapter: nodes.find((n) => n.level === "chapter"),
    castNames: [char.name], userName: "旅行者", prevSummary: undefined, loreBlock,
    cardJson: exportCardV2(char), lorebookJson: globalJson,
  });
  t.eq(pack.files.map((f) => f.name).includes("worldbook.json"), true, "五件套齐");
  const outCard = JSON.parse(pack.files.find((f) => f.name === "card.json").content);
  t.eq(parseCardJsonText(JSON.stringify(outCard)).name, char.name, "包内卡可被 ST/本工具再解析（roundtrip）");
  t.ok(pack.greeting.includes("塔顶对峙") && pack.greeting.includes("烧掉契约"), "greeting 携带戏剧目标与节拍");

  // ── 6. 导回分析（模拟 recap JSON）→ 回写 ──
  const recapMessages = "旅行者：你果然烧了它。\n" + char.name + "：灰烬里会有答案。";
  t.ok(sessionRecapPrompt(recapMessages, scene).length === 2, "recap 提示词就绪（真实调用留给 UI 层）");
  const recap = {
    summary: `${char.name}当众焚契`,
    beatStatus: [
      { beat: `${char.name}烧掉契约`, status: "hit", evidence: "火焰吞没羊皮纸" },
      { beat: "旅行者拔剑", status: "missed" },
      { beat: "契约灰烬复活", status: "partial", evidence: "灰烬发光但未完形" },
    ],
    divergences: [{ desc: "缺少塔外雷暴铺垫", severity: "minor", suggestion: "accept" }],
    proposals: [{ type: "event", content: `${char.name}焚毁契约`, actors: [char.name] }],
  };
  const app = applyRecapToNode(scene, recap);
  t.eq(app.beatUpdates.filter((b) => b.done).length, 1, "仅 hit 打勾");
  t.eq(app.suggestedStatus, "tested", "建议转已试跑");
  const rewoven = reweaveBeats(scene, recap);
  t.ok(rewoven[2].text.includes("灰烬发光但未完形"), "partial 节拍留下实际走向注记");

  // ── 7. 提示词与节点树互通（M3 下一幕链路可用性）──
  const ns = masterOutlinePrompt([{ key: "genre", label: "题材", group: "定位", value: "暗黑奇幻", status: "confirmed", deps: [] }], { structure: "hero" });
  t.ok(ns.map((m) => m.content).join("\n").includes("英雄之旅"), "结构骨架切换");
}
