// 试跑包组装器测试
import { buildTrialPack, sanitizeName, synthesizeNarratorCard } from "../../dist-test/flow/trialpack.js";

const SCENE = {
  id: "s1", projectId: "p1", parentId: "c1", level: "scene", order: 0,
  title: "荒庙重逢", intent: "让旧识相认并埋匕首伏笔",
  beats: [{ id: "b1", text: "A 在神像下发现匕首" }, { id: "b2", text: "B 冒雨闯入对峙", done: true }],
  cast: [], foreshadows: [], status: "refined", revision: 1, createdAt: 0, updatedAt: 0,
};

const BASE = {
  packName: "第一卷/第一章：荒庙*重逢",
  scene: SCENE,
  chapter: { ...SCENE, id: "c1", level: "chapter", title: "第一章·雨" },
  castNames: ["B", "店小二"],
  userName: "旅行者",
  prevSummary: "官道遇盘查，仓皇入林",
  loreBlock: "【荒庙】旧战场上的野祠",
  cardJson: { spec: "chara_card_v2", spec_version: "2.0", data: { name: "Morgana" } },
};

export default async function (t) {
  const pack = buildTrialPack(BASE);
  t.eq(pack.folder, "第一卷_第一章：荒庙*重逢".replace(/[\\/:*?"<>|]/g, "_"), "folder 名净化");
  const names = pack.files.map((f) => f.name);
  t.eq(names, ["card.json", "greeting.txt", "note.txt", "readme.md"], "未给世界书则四件套");
  const card = JSON.parse(pack.files.find((f) => f.name === "card.json").content);
  t.eq(card.spec, "chara_card_v2", "卡 JSON 原样嵌入（pretty 缩进）");
  const g = pack.greeting;
  t.ok(g.includes("A 在神像下发现匕首") && g.includes("已上演") && g.includes("官道遇盘查"), "greeting 含节拍与完成标记与前情");
  t.ok(g.includes("旧战场上的野祠"), "loreBlock 注入 greeting");
  t.ok(pack.authorNote.length <= 300 && pack.authorNote.includes("A 在神像下发现匕首"), "note 指向第一个未演节拍且截断");
  t.ok(pack.files.find((f) => f.name === "readme.md").content.includes("荒庙"), "readme 用原始包名");

  const withBook = buildTrialPack({ ...BASE, lorebookJson: { entries: {} } });
  t.ok(withBook.files.some((f) => f.name === "worldbook.json"), "给世界书则五件套");
  t.eq(JSON.parse(withBook.files.find((f) => f.name === "worldbook.json").content).entries && true, true, "世界书 JSON 可回解析");

  // 净化函数
  t.eq(sanitizeName("a/b:c*d?e"), "a_b_c_d_e", "非法字符替换");
  t.eq(sanitizeName(""), "trial-pack", "空名兜底");
  t.eq(sanitizeName("..."), "trial-pack", "纯点号兜底");
  t.eq(sanitizeName(" 卷一 · 雨  "), "卷一 · 雨", "首尾空白修剪（中间保留）");
  t.eq(sanitizeName("x".repeat(200)).length, 80, "长度上限 80");

  // 无卡模式（原创小说试跑）：省略 cardJson → 自动合成旁白卡
  const noCard = buildTrialPack({ ...BASE, cardJson: undefined, worldview: "灵力复苏的都市", narratorName: "旁白" });
  t.ok(
    noCard.files.find((f) => f.name === "readme.md").content.includes("旁白卡"),
    "无卡模式 readme 说明改用旁白卡",
  );
  const narrator = JSON.parse(noCard.files.find((f) => f.name === "card.json").content);
  t.eq(narrator.spec, "chara_card_v2", "旁白卡是合法 v2 骨架");
  t.eq(narrator.data.name, "旁白", "旁白卡名取 narratorName");
  t.ok(narrator.data.description.includes("灵力复苏"), "世界观进旁白卡 description");
  t.ok(narrator.data.first_mes.includes("荒庙重逢"), "旁白卡 first_mes = 试跑 greeting");
  // 直接调用合成器：narratorName 缺省回落幕标题
  const synth = synthesizeNarratorCard({ scene: SCENE, castNames: [], worldview: "" }, "开场白");
  t.eq(synth.data.name, "荒庙重逢", "narratorName 缺省回落幕标题");

  // 用户画像注入 greeting
  const persona = buildTrialPack({ ...BASE, userPersona: "名字：Lipu\n身份/背景：记录故事的大学生" });
  t.ok(persona.greeting.includes("玩家形象") && persona.greeting.includes("记录故事的大学生"), "userPersona 进 greeting");
}
