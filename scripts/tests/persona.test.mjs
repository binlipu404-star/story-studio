// 用户画像兼容层冒烟测试
import { existsSync, readFileSync } from "node:fs";
import {
  characterToPersonaSeed,
  importPersonaBytes,
  parsePersonaJsonText,
  personaSeedToPersona,
} from "../../dist-test/st/persona.js";
import { parseCardJsonText, parsedCardToCharacter } from "../../dist-test/st/card.js";

const REAL_PERSONA = "D:\\program films\\SillyTavern-1.18.0\\卡书\\personas_20260703.json";

export default async function (t) {
  // 1. ST 画像导出文件（personas + persona_descriptions + default_persona）
  const stFile = JSON.stringify({
    personas: { "user-default.png": "Lipu", "hero.png": "" },
    persona_descriptions: {
      "user-default.png": { description: "我是{{user}}，男性，21岁。", position: 0 },
      "hero.png": { description: "披风剑士。" },
    },
    default_persona: "hero.png",
  });
  const seeds = parsePersonaJsonText(stFile);
  t.eq(seeds.length, 2, "1. 画像文件解析出 2 条");
  const lipu = seeds.find((s) => s.name === "Lipu");
  t.ok(lipu && lipu.description.includes("21岁"), "1. 头像名兜底 + 描述读取");
  t.eq(seeds.find((s) => s.name === "hero")?.isDefault, true, "1. default_persona 命中项 isDefault=true");
  t.eq(lipu?.isDefault, false, "1. 非默认项 isDefault=false");

  // 2. 裸对象（画像备份/手写）
  const plain = parsePersonaJsonText(JSON.stringify({ name: "阿明", description: "大学生", appearance: "黑发" }))[0];
  t.eq(plain.name, "阿明", "2. 裸对象 name");
  t.eq(plain.appearance, "黑发", "2. 裸对象 appearance 保留");

  // 3. 角色卡形态（v2 卡）→ 画像：背景进正文，外貌/性格单列
  const card = JSON.stringify({
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "凛",
      description: "背景：道场长大。\n外貌：黑长直。\n性格：傲娇。",
      personality: "",
      scenario: "修学旅行",
      first_mes: "……看什么看。",
    },
  });
  const fromCard = parsePersonaJsonText(card)[0];
  t.eq(fromCard.name, "凛", "3. 卡→画像 name");
  t.ok(fromCard.description.includes("道场"), "3. 卡 description 背景进画像正文");
  t.ok(fromCard.appearance.includes("黑长直"), "3. 卡外貌进画像 appearance");
  t.ok(fromCard.notes.includes("修学旅行"), "3. scenario 进备注");

  // 4. 数组（多条裸对象）
  const arr = parsePersonaJsonText(JSON.stringify([{ name: "A" }, { name: "B", description: "b" }]));
  t.eq(arr.length, 2, "4. 数组解析 2 条");

  // 5. importPersonaBytes：JSON 文本字节
  const seeds2 = await importPersonaBytes("p.json", new TextEncoder().encode(stFile).buffer);
  t.eq(seeds2.length, 2, "5. importPersonaBytes(JSON) 走画像文件分支");
  // 6. importPersonaBytes：卡 JSON 字节（非画像文件）→ 卡兜底
  const seeds3 = await importPersonaBytes("c.json", new TextEncoder().encode(card).buffer);
  t.eq(seeds3[0].name, "凛", "6. importPersonaBytes 卡文件兜底");

  // 7. personaSeedToPersona 落库形态
  const persona = personaSeedToPersona(fromCard);
  t.eq(persona.source, "st-import", "7. source=st-import");
  t.ok(typeof persona.id === "string" && persona.id.length > 0, "7. 生成 id");
  t.ok(persona.rawCard != null, "7. 卡导入保留 rawCard");

  // 8. characterToPersonaSeed 直连
  const seedDirect = characterToPersonaSeed(parsedCardToCharacter(parseCardJsonText(card), ""));
  t.eq(seedDirect.name, "凛", "8. characterToPersonaSeed 直连");

  // 9. 一无所获抛清晰错误
  let err = null;
  try {
    parsePersonaJsonText(JSON.stringify({ foo: 1 }));
  } catch (e) {
    err = e;
  }
  t.ok(err !== null, "9. 无画像信息时抛错");

  // 10. 真实 ST 画像导出文件（存在才测）
  if (!existsSync(REAL_PERSONA)) {
    t.skip("真实画像文件不存在：" + REAL_PERSONA);
  } else {
    const buf = readFileSync(REAL_PERSONA);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const real = await importPersonaBytes("personas.json", ab);
    t.ok(real.length >= 1 && real[0].name.length > 0, "10. 真实 ST 画像解析：" + real.map((s) => s.name).join(","));
    t.ok(real.some((s) => s.description.length > 50), "10. 真实画像含长描述");
  }
}
