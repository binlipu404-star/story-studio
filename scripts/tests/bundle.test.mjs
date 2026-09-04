// N5 项目包冒烟测试：stored-zip 结构自校验 + bundle 文件清单 + digest 净化
import { buildZip, crc32, safeZipName } from "../../dist-test/flow/zip.js";
import { bundleFiles, bundleZipBytes } from "../../dist-test/flow/bundle.js";
import { sanitizeDigest } from "../../dist-test/flow/snapshot.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

// 迷你 zip 读取器（只认本写入器生成的 stored 结构——写读对拍即自证）
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 66; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("EOCD 缺失");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // cd offset
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("中央目录签名错位 @".concat(p));
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    // 本地头复核
    if (dv.getUint32(off, true) !== 0x04034b50) throw new Error("本地头签名错位 " + name);
    const lnlen = dv.getUint16(off + 26, true);
    const lname = dec.decode(bytes.subarray(off + 30, off + 30 + lnlen));
    if (lname !== name) throw new Error("本地/中央名字不一致");
    const data = bytes.subarray(off + 30 + lnlen, off + 30 + lnlen + size);
    if (crc32(data) !== crc) throw new Error("CRC 不符: " + name);
    entries.push({ name, text: dec.decode(data) });
    p += 46 + nlen;
  }
  return entries;
}

const project = {
  id: "p1",
  title: "灯塔/暗流", // 含非法文件名字符 /，应被清洗
  synopsis: "s",
  bible: { fields: [], revisions: [] },
  lorebook: { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true },
  createdAt: 0,
  updatedAt: 0,
  schema: 1,
};

const node = {
  id: "n1", projectId: "p1", parentId: null, level: "scene", order: 0, title: "祭坛之夜",
  intent: "确认背叛", beats: [{ id: "b1", text: "发现匕首不见", done: true }], cast: [],
  foreshadows: [{ id: "f1", setup: "匕首去向", status: "planted" }], status: "tested",
  revision: 1, createdAt: 0, updatedAt: 0,
};

const character = {
  id: "c1", projectId: "p1", name: "薇薇安",
  profile: { appearance: "银发", background: "守灯人", personality: "冷峻", speechStyle: "", exampleLines: [] },
  scenario: "灯塔", greeting: "", mesExample: "", state: "", source: "manual", cardFormat: "v2", rawCard: undefined,
  createdAt: 0, updatedAt: 0,
};

const lore = {
  id: "l1", projectId: "p1", uid: 1, comment: "灯塔", content: "建于1899年。", keys: ["灯塔"],
  secondaryKeys: [], constant: true, selective: false, caseSensitive: false, matchWholeWord: false,
  position: "before_char", order: 0, depth: null, sticky: null, cooldown: null, probability: 100,
  useProbability: false, group: "", groupOverride: false, groupWeight: 0, excludeRecursion: false,
  preventRecursion: false, enabled: true, extensions: {},
};

const ledger = [
  { id: "g1", projectId: "p1", type: "event", content: "A烧了信", actors: ["A"], status: "confirmed", createdAt: 5 },
  { id: "g2", projectId: "p1", type: "item", content: "匕首失踪", actors: [], status: "proposed", createdAt: 6 },
];

const session = {
  id: "s1", projectId: "p1", nodeId: "n1", cast: ["c1"], userName: "黎明",
  messages: [
    { id: "m1", role: "char", name: "薇薇安", content: "灯不能灭。", createdAt: 1 },
    { id: "m2", role: "user", name: "黎明", content: "我来守。", createdAt: 2 },
  ],
  rollingSummary: "两人到达灯塔。", status: "testing", createdAt: 1, updatedAt: 2,
};

export default async function (t) {
  // 1. crc32 标准向量
  t.eq(crc32(enc.encode("123456789")), 0xcbf43926, "1. CRC32 标准校验值");

  // 2. 名字清洗 + 去重
  t.eq(safeZipName("..\\a\\..\\b:c?.txt"), "a/b_c_.txt", "2. 名字清洗");
  {
    const z = readZip(buildZip([{ name: "a.txt", text: "一" }, { name: "a.txt", text: "二" }]));
    t.eq(z.length, 1, "2. 同名后者覆盖，只留一条");
    t.eq(z[0].text, "一", "2. 保留先写者（写入序即优先级）");
  }

  // 3. 空包是合法 zip
  {
    const z = buildZip([]);
    const dv = new DataView(z.buffer, z.byteOffset, z.byteLength);
    t.eq(z.length, 22, "3. 空包=纯 EOCD 22 字节");
    t.eq(dv.getUint32(0, true), 0x06054b50, "3. EOCD 签名");
  }

  // 4. bundle 文件清单
  {
    const files = bundleFiles({ project, nodes: [node], characters: [character], loreEntries: [lore], ledger, sessions: [session] });
    const names = files.map((f) => f.name);
    const pre = "灯塔_暗流/";
    t.ok(names.includes(pre + "README.txt"), "4. README");
    t.ok(names.includes(pre + "outline.md") && names.includes(pre + "outline.json"), "4. 大纲双份");
    t.ok(names.includes(pre + "project.json") && names.includes(pre + "ledger.json"), "4. 档案+台账");
    t.ok(names.includes(pre + "worldbook.json"), "4. 世界书");
    t.ok(names.some((n) => n.startsWith(pre + "cards/") && n.endsWith(".json")), "4. 人物卡目录");
    const tr = files.find((f) => f.name.includes("transcripts/"));
    t.ok(tr && tr.text.includes("灯不能灭") && tr.text.includes("【前情摘要】两人到达灯塔"), "4. 转写含正文与摘要");
    const md = files.find((f) => f.name === pre + "outline.md");
    t.ok(md.text.includes("祭坛之夜") && md.text.includes("匕首去向"), "4. outline.md 有幕与伏笔");
    t.ok(files.every((f) => !f.name.includes("*") && !f.name.includes("?")), "4. 名字已清洗");
    const card = files.find((f) => f.name.startsWith(pre + "cards/"));
    t.ok(JSON.parse(card.text).data.name === "薇薇安", "4. 卡是 V2 形态");
  }

  // 5. zip 字节可完整读回（写读对拍）
  {
    const bytes = bundleZipBytes({ project, nodes: [node], characters: [character], loreEntries: [lore], ledger, sessions: [session] });
    const entries = readZip(bytes);
    t.ok(entries.length >= 7, "5. 条目数 " + entries.length);
    t.ok(entries.every((e) => e.text.length > 0), "5. 无空文件");
    t.eq(bytes[0], 0x50, "5. PK 头");
    t.eq(bytes[1], 0x4b, "5. PK 头");
  }

  // 6. digest 净化：全脏输入不炸、白名单收敛
  {
    const d = sanitizeDigest({
      summary: "  摘要。  ",
      ledger: [
        { type: "event", content: " 事实1 ", actors: ["A", 3, ""] },
        { type: "nonsense", content: "无类型→event" },
        { type: "item", content: "   " }, // 空文丢弃
        { type: "item", content: null },
        "垃圾",
        null,
        { type: "relation", content: "事实2", actors: "不是数组" },
      ],
    });
    t.eq(d.summary, "摘要。", "6. summary 修剪");
    t.eq(d.ledger.length, 3, "6. 空文/垃圾/空对象丢弃，有效 3 条留下");
    t.eq(d.ledger[0].type, "event", "6. 白名单");
    t.eq(d.ledger[0].actors.join(","), "A", "6. actors 净化");
    t.eq(d.ledger[1].type, "event", "6. 非法类型归 event");
    t.eq(d.ledger[2].type, "relation", "6. relation 在白名单内保留");
    t.eq(d.ledger[2].actors.length, 0, "6. 非数组 actors 归空");
    const e = sanitizeDigest(null);
    t.eq(e.summary, "" , "6. null 输入安全");
    t.eq(e.ledger.length, 0, "6. null 输入空账");
    const many = sanitizeDigest({ summary: "s", ledger: Array.from({ length: 20 }, (_, i) => ({ type: "event", content: "f" + i })) });
    t.eq(many.ledger.length, 8, "6. 上限 8 条");
  }
}
