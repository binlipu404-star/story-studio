// 真实 ST 样本探针：卡书目录 → 兼容层（识别率统计，供人工复核）
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { extractPngCardJson, parseCardJsonText, parsedCardToCharacter } from "../dist-test/st/card.js";
import { importPersonaBytes } from "../dist-test/st/persona.js";
import { normalizeLorebook } from "../dist-test/st/lorebook.js";

const DIR = "D:\\program films\\SillyTavern-1.18.0\\卡书";
if (!existsSync(DIR)) {
  console.log("样本目录不存在，跳过：", DIR);
  process.exit(0);
}
const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const files = readdirSync(DIR);

const pngs = files.filter((f) => f.toLowerCase().endsWith(".png"));
const jsons = files.filter((f) => f.toLowerCase().endsWith(".json"));

console.log(`== PNG 卡 ×${pngs.length} ==`);
let parsed = 0;
let appFilled = 0;
const rows = [];
for (const f of pngs) {
  const ab = toAB(readFileSync(path.join(DIR, f)));
  const jt = extractPngCardJson(ab);
  if (jt === null) {
    rows.push([f.slice(0, 40), "无内嵌卡", "", "", "", ""]);
    continue;
  }
  let ch;
  try {
    ch = parsedCardToCharacter(parseCardJsonText(jt), "probe");
  } catch (e) {
    rows.push([f.slice(0, 40), "解析炸裂:" + e.message.slice(0, 30), "", "", "", ""]);
    continue;
  }
  parsed++;
  const p = ch.profile;
  if (p.appearance.trim()) appFilled++;
  const data = (() => { try { const j = JSON.parse(jt); return j.data ?? j; } catch { return {}; } })();
  const src = /外貌|外形|外观|外表|长相|容貌|形象|[Aa]ppearance|visual|physique|looks/i.test(parseCardJsonText(jt).description)
    ? "标签"
    : typeof data.appearance === "string" && data.appearance.trim()
      ? "非标字段"
      : "无";
  rows.push([
    (ch.name || "?").slice(0, 18),
    `app:${p.appearance.trim().length} pers:${p.personality.trim().length} bg:${p.background.trim().length} sp:${p.speechStyle.trim().length} 例:${p.exampleLines.length}`,
    src,
    p.appearance.trim().slice(0, 36).replace(/\n/g, " "),
  ]);
}
for (const r of rows) console.log(r.map((x) => String(x ?? "").padEnd(2)).join(" | "));
console.log(`PNG：解析成功 ${parsed}/${pngs.length}，外貌识别 ${appFilled}/${parsed}`);

console.log("\n== 画像文件 ==");
for (const f of jsons.filter((x) => /persona/i.test(x))) {
  try {
    const seeds = await importPersonaBytes(f, toAB(readFileSync(path.join(DIR, f))));
    for (const s of seeds) {
      console.log(`  ${f} → name=${JSON.stringify(s.name)} desc=${s.description.length}字 isDefault=${s.isDefault}`);
    }
  } catch (e) {
    console.log(`  ${f} 失败: ${e.message}`);
  }
}

console.log("\n== 世界书 JSON 稳健性 ==");
for (const f of jsons) {
  if (/persona/i.test(f)) continue;
  let n = "?";
  let warn = "";
  try {
    const raw = JSON.parse(readFileSync(path.join(DIR, f), "utf8").replace(/^\uFEFF/, ""));
    const book = normalizeLorebook(raw);
    n = book.entries.length;
    if (n === 0) warn = "（0 条——可能是非世界书文件，如模型预设）";
  } catch (e) {
    warn = "炸裂: " + e.message.slice(0, 50);
  }
  console.log(`  ${f.slice(0, 52).padEnd(54)} 词条=${n} ${warn}`);
}
