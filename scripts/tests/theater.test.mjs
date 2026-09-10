// 剧场剧组装配测试（theater.ts：沙盒装配/剧本装配/台账隔离/借用/副本块/新组形状）
import { assembleRoom, newRoom, roomCurrentScene, roomSort } from "../../dist-test/flow/theater.js";
import { buildScriptSnapshot } from "../../dist-test/flow/script.js";

const sceneNode = (over) => ({
  id: "s1", projectId: "p1", parentId: "c1", level: "scene", order: 0, title: "祭坛之夜",
  intent: "确认背叛", beats: [{ id: "b1", text: "匕首失踪", done: false }], cast: [],
  foreshadows: [{ id: "f1", setup: "匕首的去向成谜", status: "planted", payoffIn: null }],
  status: "draft", revision: 1, createdAt: 1, updatedAt: 1, ...over,
});
const nodes = [
  { id: "v1", projectId: "p1", parentId: null, level: "volume", order: 0, title: "卷一", intent: "", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 1, updatedAt: 1 },
  { id: "c1", projectId: "p1", parentId: "v1", level: "chapter", order: 0, title: "第一章", intent: "", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 1, updatedAt: 1 },
  sceneNode(),
  sceneNode({ id: "s2", order: 1, title: "第二幕", beats: [{ id: "b2", text: "出海", done: false }], foreshadows: [] }),
];
const snap = buildScriptSnapshot("灯塔", nodes, [nodes[2], nodes[3]], 100);

const project = {
  id: "p1", title: "灯塔", synopsis: "", bible: { fields: [{ key: "w", label: "世界观", group: "世界", value: "永夜之海", status: "confirmed" }], revisions: [] },
  lorebook: { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true }, createdAt: 0, updatedAt: 0,
};
const char = {
  id: "ch1", projectId: "p1", name: "薇薇安",
  profile: { appearance: "银发", personality: "冷峻", background: "守灯人", speechStyle: "", exampleLines: [] },
  scenario: "灯塔", greeting: "", mesExample: "", source: "manual", cardFormat: "v2", createdAt: 0, updatedAt: 0,
};
const lore = {
  id: "l1", projectId: "p1", uid: 1, comment: "灯塔", content: "建于1899年。", keys: ["灯塔"], secondaryKeys: [],
  constant: true, selective: false, caseSensitive: false, matchWholeWord: false, position: "before_char", order: 0,
  depth: null, sticky: null, cooldown: null, probability: 100, useProbability: false, group: "", groupOverride: false,
  groupWeight: 0, excludeRecursion: false, preventRecursion: false, enabled: true, extensions: {},
};
const canon = (over) => ({ id: "g1", projectId: "p1", type: "event", content: "A 烧了信", actors: ["A"], status: "confirmed", createdAt: 5, ...over });

const baseRoom = (over) => ({
  id: "r1", projectId: "p1", nodeId: null, cast: [], userName: "黎明", messages: [], status: "testing",
  createdAt: 1, updatedAt: 1, kind: "theater", name: "夜航组", pace: "loose", scopeMode: "full", sandbox: false,
  script: snap, progress: {},
  config: { charId: "ch1", personaId: "", budgetTokens: 8192, reserveTokens: 768, ledgerCadence: 0, borrowProjectLedger: false },
  ...over,
});

export default async function (t) {
  // 1. 当前幕定位
  t.eq(roomCurrentScene(baseRoom())?.title, "祭坛之夜", "1. 未演=第一幕");
  t.eq(roomCurrentScene(baseRoom({ progress: { b1: "done" } }))?.title, "第二幕", "1. 第一幕完→第二幕");
  t.eq(roomCurrentScene(baseRoom({ progress: { b1: "done", b2: "done" } }))?.title, "第二幕", "1. 演尽=停最后一幕");
  t.eq(roomCurrentScene(baseRoom({ sandbox: true, script: undefined })), null, "1. 沙盒无幕");
  // 1b. v8-A 手动故事指针：作者指哪演哪（盖过自动推导，含"演尽回落末幕"路径）
  t.eq(roomCurrentScene(baseRoom({ scenePointer: 1 }))?.title, "第二幕", "1b. 指针=第二幕");
  t.eq(roomCurrentScene(baseRoom({ progress: { b1: "done", b2: "done" }, scenePointer: 0 }))?.title, "祭坛之夜", "1b. 演尽仍听指针=第一幕（旧行为会锁死末幕）");
  t.eq(roomCurrentScene(baseRoom({ scenePointer: 9 }))?.title, "祭坛之夜", "1b. 越界指针回落自动推导");

  // 1c. v8-A 装配随指针：greeting/剧本块认作者指的幕
  {
    const a = assembleRoom({ room: baseRoom({ scenePointer: 1 }), project, characters: [char], loreEntries: [lore], roomCanon: [], projectCanon: [] });
    t.eq(a.sceneTitle, "第二幕", "1c. 装配幕=指针幕");
    t.ok(a.setup.scriptBlock.includes("作者指针停在最后一幕"), "1c. 指针=末幕 → 剧本块备忘=尽头（指针语义）");
    t.ok(a.greeting.includes("第二幕"), "1c. greeting 随指针换幕");
  }

  // 1d. v8-B 导演简报：剧本组随剧本块尾注入；沙盒组走「本幕指引」位；无简报=零污染
  {
    const withBrief = assembleRoom({ room: baseRoom({ brief: "薇薇安已起疑：下一拍让她搜查房间" }), project, characters: [char], loreEntries: [lore], roomCanon: [], projectCanon: [] });
    t.ok(withBrief.setup.scriptBlock.includes("【导演简报·场记留给演员】薇薇安已起疑"), "1d. 简报拼进剧本块尾");
    const noBrief = assembleRoom({ room: baseRoom(), project, characters: [char], loreEntries: [lore], roomCanon: [], projectCanon: [] });
    t.ok(!noBrief.setup.scriptBlock.includes("导演简报"), "1d. 无简报不占字");
    const sandboxBrief = assembleRoom({ room: baseRoom({ sandbox: true, script: undefined, brief: "让海雾带来一个客人" }), project, characters: [], loreEntries: [], roomCanon: [], projectCanon: [] });
    t.ok(sandboxBrief.setup.systemExtra?.includes("让海雾带来一个客人"), "1d. 沙盒组简报走本幕指引位");
  }
  // 2. 剧本组装配：节奏/副本块/台账隔离/greeting
  {
    const a = assembleRoom({ room: baseRoom(), project, characters: [char], loreEntries: [lore], roomCanon: [canon()], projectCanon: [canon({ id: "g9", content: "作品级旧事" })] });
    t.eq(a.setup.charName, "薇薇安", "2. 人卡生效");
    t.eq(a.setup.pace, "loose", "2. 节奏透传");
    t.ok(a.setup.scriptBlock.includes("【剧本副本·灯塔】"), "2. 副本块注入");
    t.ok(a.setup.scriptBlock.includes("匕首失踪"), "2. 副本节拍可见");
    t.ok(a.setup.bibleBlock.includes("【构思档案·作品定位】") && a.setup.bibleBlock.includes("永夜之海"), "2. 构思档案要素固定注入");
    t.ok(a.setup.ledgerBlock.includes("A 烧了信"), "2. 剧组正典注入");
    t.ok(!a.setup.ledgerBlock.includes("作品级旧事"), "2. 作品级台账默认隔离");
    t.ok(a.setup.ledgerBlock.includes("匕首的去向成谜"), "2. 副本伏笔欠账注入");
    t.ok(a.greeting.includes("匕首失踪"), "2. greeting 含当前幕节拍");
    t.eq(a.sceneTitle, "祭坛之夜", "2. 场景标题");
    t.ok(a.baseNote.length > 0, "2. AN 基底非空");
  }

  // 3. 借用作品级：显式开关注入且标注来源
  {
    const borrow = { ...baseRoom(), config: { ...baseRoom().config, borrowProjectLedger: true } };
    const a = assembleRoom({ room: borrow, project, characters: [char], loreEntries: [lore], roomCanon: [canon()], projectCanon: [canon({ id: "g9", content: "作品级旧事" })] });
    t.ok(a.setup.ledgerBlock.includes("作品级旧事") && a.setup.ledgerBlock.includes("借自作品级台账"), "3. 借用+来源标注");
  }

  // 4. 欠账可被剧组台账核销（foreshadow 记录正文含 setup）
  {
    const a = assembleRoom({
      room: baseRoom(), project, characters: [char], loreEntries: [lore],
      roomCanon: [canon(), canon({ id: "g2", type: "foreshadow", content: "回收伏笔：匕首的去向成谜——就在靴筒里" })],
    });
    t.ok(!a.setup.ledgerBlock.includes("伏笔欠账"), "4. 已回收 → 欠账块消失（核销记录本身仍在正典快照里）");
  }

  // 5. 无卡=旁白；沙盒组装配
  {
    const noCard = { ...baseRoom(), config: { ...baseRoom().config, charId: "" } };
    const a = assembleRoom({ room: noCard, project, characters: [char], loreEntries: [], roomCanon: [] });
    t.ok(a.setup.charName.length > 0, "5. 旁白卡有名字");
    const sb = assembleRoom({ room: baseRoom({ sandbox: true, script: undefined }), project, characters: [], loreEntries: [], roomCanon: [] });
    t.eq(sb.sceneTitle, "自由即兴", "5. 沙盒标题");
    t.eq(sb.setup.charName, "旁白", "5. 沙盒=旁白");
    t.eq(sb.setup.scriptBlock, undefined, "5. 沙盒无副本块");
    t.eq(sb.setup.description, "永夜之海", "5. 世界观兜底注入");
    t.ok(sb.setup.bibleBlock.includes("永夜之海"), "5. 沙盒组同样注入构思档案要素");
  }

  // 6. newRoom 形状与排序
  {
    const r = newRoom({
      id: "r9", projectId: "p1", name: "新剧组", userName: "U", pace: "tight",
      scopeMode: "chapters", sandbox: false, script: snap, charId: "ch1", personaId: "", budgetTokens: 4096,
      reserveTokens: 512, ledgerCadence: 10, borrowProjectLedger: false, chapterIds: ["c1"], now: 555,
    });
    t.eq(r.kind, "theater", "6. kind 标记");
    t.eq(r.status, "testing", "6. 初始 testing");
    t.eq(r.config.ledgerCadence, 10, "6. 楼层频率入 config");
    t.eq(r.config.chapterIds.join(","), "c1", "6. 章选入 config");
    t.eq(r.updatedAt, 555, "6. 时间戳");
    t.eq(roomSort([{ ...r, updatedAt: 1 }, { ...r, id: "b", updatedAt: 9 }])[0].id, "b", "6. 活跃倒序");
  }
}
