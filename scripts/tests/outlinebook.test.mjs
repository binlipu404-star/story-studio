// 剧情世界书（outlinebook）冒烟测试
import { STORY_GROUP, STORY_PROTOCOL, draftToBookScenes, outlineBookEntries, outlineBookJson, extractBeatKeys } from "../../dist-test/flow/outlinebook.js";
import { outlineCoachPrompt, sceneBeatsPrompt } from "../../dist-test/ai/prompts.js";

const SCENES = [
  {
    nodeId: "s1",
    title: "祭坛之夜",
    lineage: "卷一·第一章",
    intent: "取回匕首",
    location: "地下祭坛",
    timepoint: "雨夜",
    beats: [
      { id: "b1", text: "在神像下发现「匕首」" },
      { id: "b2", text: "守卫巡逻经过", done: true },
    ],
    castNames: ["摩根娜"],
  },
  { nodeId: "s2", title: "已演完的一幕", intent: "x", beats: [{ id: "b3", text: "他离开了" }], done: true },
  { nodeId: "s3", title: "第三章对峙", intent: "对峙", beats: [{ id: "b4", text: "He draws the dagger" }], castNames: ["卡尔"] },
  { nodeId: "s4", title: "空幕兜底", intent: "无可用触发词", beats: [{ id: "b5", text: "他离开了" }] },
];

export default async function (t) {
  // 1. 抽取器行为保持（继承自节拍书时代）
  t.ok(extractBeatKeys("在神像下发现「匕首」", []).includes("匕首"), "1. 引号短语抽取");
  t.ok(!extractBeatKeys("双方突然", []).includes("突然"), "1. 动停表过滤");

  // 2. 成书结构：协议 + 未演幕
  const r = outlineBookEntries(SCENES);
  t.eq(r.entries.length, 4, "2. 协议1条 + 幕3条（done 幕跳过）");
  t.eq(r.skippedDone, 1, "2. skippedDone 计数");
  t.eq(outlineBookEntries(SCENES, { includeDone: true }).entries.length, 5, "2. includeDone 含已演幕");

  // 3. 协议条目
  const proto = r.entries[0];
  t.ok(proto.constant && proto.content === STORY_PROTOCOL, "3. 协议条目蓝灯常驻");
  t.ok(STORY_PROTOCOL.includes("{{char}}") && STORY_PROTOCOL.includes("{{user}}"), "3. 协议使用酒馆变量");

  // 4. 幕条目字段
  const s1 = r.entries[1];
  t.ok(s1.keys.includes("祭坛之夜") && s1.keys.includes("匕首"), "4. keys=标题+节拍触发词：" + s1.keys.join(","));
  t.ok(s1.comment === "幕 1/4·卷一·第一章·祭坛之夜", "4. comment 含层级路径：" + s1.comment);
  t.ok(s1.content.includes("第 1 幕") && s1.content.includes("（已演）"), "4. 内容含幕号与已演标记");
  t.ok(s1.content.includes("{{char}}") && s1.content.includes("{{user}}"), "4. 指令文本用酒馆变量");
  t.eq(s1.depth, 1, "4. depth=1");
  t.eq(s1.sticky, 3, "4. sticky=3（短停留）");
  t.eq(s1.cooldown, 10, "4. cooldown=10（长冷却防自写触发词重触发）");
  t.eq(s1.group, STORY_GROUP, "4. 同组互斥");
  // 幕号保持全幕视角（跳过不重排）：s3 是池内第 3 条
  const s3 = r.entries[2];
  t.ok(s3.comment.startsWith("幕 3/4"), "4. 幕号不因跳过重排：" + s3.comment);
  t.ok(s3.groupWeight > s1.groupWeight, "4. 后幕权重高（更接近当前进度者优先）");

  // 5. 弱触发兜底：s4 只有标题 → 蓝灯不入组
  const s4 = r.entries[3];
  t.ok(s4.constant && s4.group === "", "5. 弱触发 → 蓝灯兜底不入组");
  t.eq(s4.keys.length, 1, "5. 兜底条目 keys=仅标题");

  // 6. 英文节拍
  t.ok(s3.keys.some((k) => k.toLowerCase() === "dagger"), "6. 英文实词触发：" + s3.keys.join(","));

  // 7. 导出 JSON = ST 全局 world info 形态、不绑角色
  const { json } = outlineBookJson(SCENES);
  const raw = JSON.parse(json);
  t.ok(Object.keys(raw.entries).join(",") === "1,2,3,4", "7. uid 数字字符串键");
  const e2 = raw.entries["2"];
  t.eq(e2.sticky, 3, "7. sticky 数字导出");
  t.eq(e2.cooldown, 10, "7. cooldown 导出");
  t.eq(e2.useGroupScoring, true, "7. 有组条目显式启用组打分（否则 ST 组内择一不生效）");
  t.eq(e2.characterBinding, undefined, "7. 不绑定任何角色");
  t.ok(Array.isArray(e2.key) && e2.key.includes("祭坛之夜"), "7. key 数组导出");
  t.eq(e2.disable, false, "7. disable=false");
  t.eq(raw.entries["1"].useGroupScoring, false, "7. 无组条目组打分=false");

  // 8. 协议可关
  t.eq(outlineBookEntries(SCENES, { protocolEntry: false }).entries[0].comment.includes("幕 1/4"), true, "8. protocolEntry=false 首条即幕条目");

  // 9. 草稿直通成书（共创访谈不建树也能出书）
  const DRAFT = {
    logline: "旧案重启",
    volumes: [
      {
        title: "卷一",
        chapters: [
          {
            title: "第一章",
            scenes: [
              { title: "雨夜档案馆", intent: "拿到旧卷宗", location: "档案馆", cast: ["摩根娜"] },
              { title: "", intent: "" }, // 空幕跳过
            ],
          },
        ],
      },
    ],
  };
  const ds = draftToBookScenes(DRAFT);
  t.eq(ds.length, 1, "9. 空幕被跳过");
  t.eq(ds[0].lineage, "卷一·第一章", "9. lineage 层级串");
  t.eq(ds[0].beats.length, 0, "9. 访谈阶段节拍恒空");
  t.eq(ds[0].castNames.join(","), "摩根娜", "9. cast 名字直通");
  t.eq(draftToBookScenes(null).length, 0, "9. null 草稿 → 空表");
  t.eq(outlineBookJson(ds).result.entries.length, 2, "9. 直通成书：协议+1幕");

  // 10. 共创/填充提示词契约
  const coach = outlineCoachPrompt([], null);
  t.ok(coach.includes('"phase"') && coach.includes("null"), "10. 空草稿教练词含阶段规格与 null 初态");
  t.ok(outlineCoachPrompt([], DRAFT).includes("雨夜档案馆"), "10. 草稿内嵌下一轮");
  const beatsP = sceneBeatsPrompt(
    { id: "s", projectId: "p", parentId: null, level: "scene", order: 0, title: "雨夜档案馆", intent: "拿到旧卷宗", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 0, updatedAt: 0 },
    [{ id: "v", projectId: "p", parentId: null, level: "volume", order: 0, title: "卷一", intent: "", beats: [], cast: [], foreshadows: [], status: "draft", revision: 1, createdAt: 0, updatedAt: 0 }],
    null,
    [],
  );
  t.eq(beatsP.length, 2, "10. 填充提示 system+user 两条");
  t.ok(beatsP[0].content.includes('{"beats"'), "10. 填充只要求 beats JSON");
  t.ok(beatsP[1].content.includes("路径：卷一") && beatsP[1].content.includes("上一幕：无"), "10. 路径与开场幕说明");
}
