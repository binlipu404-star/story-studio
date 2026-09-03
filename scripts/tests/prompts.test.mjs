// 提示词库冒烟测试：验证各阶段提示的关键内容与截断逻辑（纯文本断言，不跑 AI）
import {
  fieldsMarkdown,
  beatsToLines,
  nodeDigest,
  interviewSystemPrompt,
  masterOutlinePrompt,
  nodeDiscussPrompt,
  nextScenePrompt,
  trialGreeting,
  trialAuthorNote,
  trialPackReadme,
  sessionRecapPrompt,
  rpSystemPrompt,
  MASTER_OUTLINE_SPEC,
} from "../../dist-test/ai/prompts.js";

const F = (partial) => ({
  key: "k",
  label: "字段",
  group: "定位",
  value: "",
  status: "empty",
  deps: [],
  ...partial,
});

const B = (text, done) => ({ id: "b" + text, text, done });

const N = (partial) => ({
  id: "n1",
  projectId: "p1",
  parentId: null,
  level: "scene",
  order: 0,
  title: "荒庙重逢",
  intent: "让旧识相认并埋下匕首伏笔",
  beats: [B("A 在破庙避雨发现匕首"), B("B 冒雨闯入，两人对峙")],
  cast: ["c1"],
  location: "荒庙",
  timepoint: "雨夜",
  foreshadows: [],
  status: "refined",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  ...partial,
});

export default async function (t) {
  // fieldsMarkdown
  const fields = [
    F({ key: "genre", label: "题材与类型", group: "定位", status: "empty" }),
    F({ key: "premise", label: "主线一句话", group: "结构", value: "x".repeat(600), status: "rough", deps: ["genre"] }),
  ];
  const md = fieldsMarkdown(fields);
  t.ok(md.includes("## 定位") && md.includes("## 结构"), "按组渲染");
  t.ok(md.includes("「题材与类型」") && md.includes("空缺"), "空缺字段带状态标记");
  t.ok(!md.includes("x".repeat(401)), "长值被截断");
  t.eq(fieldsMarkdown([]), "（构思档案为空）", "空档案不崩");

  // 访谈提示
  const iv = interviewSystemPrompt(fields);
  t.ok(iv.includes("JSON") && iv.includes("askNext"), "访谈系统提示含 JSON 协议");
  t.ok(iv.includes("「题材与类型」"), "访谈提示注入字段表");
  t.ok(interviewSystemPrompt([F({ status: "confirmed", value: "v" }), F({ status: "rough", value: "r" })]).includes("已全部有内容"), "全满时切换口吻");

  // 总纲提示
  const mo = masterOutlinePrompt(fields, { structure: "three-act", volumeCount: 2 });
  const joined = mo.map((m) => m.content).join("\n");
  t.ok(joined.includes("三幕式"), "结构骨架名注入");
  t.ok(joined.includes("卷数控制在 2 卷"), "卷数约束注入");
  t.ok(joined.includes("volumes") && joined.includes("scenes"), "JSON 规格含 volumes/scenes");
  t.eq(mo[0].role, "system", "首条为 system");
  t.eq(JSON.parse(MASTER_OUTLINE_SPEC) && true, true, "MASTER_OUTLINE_SPEC 是合法 JSON 字面量");

  // 节点讨论
  const nd = nodeDiscussPrompt(N({}), [N({ id: "c0", level: "chapter", title: "第一卷·雨夜" })], fields)
    .map((m) => m.content)
    .join("\n");
  t.ok(nd.includes("荒庙重逢") && nd.includes("第一卷·雨夜"), "讨论提示含节点与上级脉络");

  // 下一幕提案
  const ns = nextScenePrompt(
    [N({ id: "v", level: "volume", title: "卷一" })],
    [N({ id: "s0", title: "旧地重游", beats: [B("进庙")] })],
    fields,
    [{ id: "l1", projectId: "p1", type: "item", content: "匕首为 B 之物", actors: ["B"], status: "confirmed", createdAt: 0 }],
  )
    .map((m) => m.content)
    .join("\n");
  t.ok(ns.includes("匕首为 B 之物"), "正典台账注入");
  t.ok(ns.includes("旧地重游"), "已上演进度注入");

  // 试跑包
  const ctx = {
    scene: N({}),
    chapter: N({ id: "c", level: "chapter", title: "第一章" }),
    castNames: ["B", "店小二"],
    userName: "旅行者",
    prevSummary: "A 在官道遭遇盘查",
    loreBlock: "【荒庙】位于边界林间……",
  };
  const g = trialGreeting(ctx);
  t.ok(g.includes("A 在破庙避雨发现匕首"), "greeting 含节拍全文");
  t.ok(g.includes("扮演除 旅行者") && g.includes("前情实际走向"), "greeting 含扮演指令与前情");
  const note = trialAuthorNote(ctx, 120);
  t.ok(note.length <= 120, "author's note 强制截断");
  t.ok(note.includes("当前待演节拍"), "note 指向第一个未完成节拍");
  const done = trialAuthorNote({ ...ctx, scene: N({ beats: [B("x", true)] }) });
  t.ok(done.includes("收尾节拍"), "全演完时切换到收尾指令");
  t.ok(trialPackReadme("荒庙重逢").includes("导出聊天记录"), "README 含 ST 操作指引");

  // 导回分析
  const sp = sessionRecapPrompt("旅行者：……".repeat(5000), N({}));
  const spText = sp.map((m) => m.content).join("\n");
  t.ok(spText.includes("beatStatus") && spText.includes("proposals"), "recap 含比对与台账 JSON 协议");
  t.ok(spText.includes("……（截断）"), "超长演出记录截断");
  const free = sessionRecapPrompt("随便聊聊", N({ beats: [] }));
  t.ok(free[1].content.includes("纯自由试跑"), "无节拍场景走自由试跑口吻");

  // beats / digest / RP
  t.eq(beatsToLines([B("甲"), B("乙", true)]), "1. 甲\n2. 乙（已上演）", "beatsToLines 序号与完成标记");
  const dg = nodeDigest(N({}), { withBeats: true });
  t.ok(dg.includes("幕") && dg.includes("细化") && dg.includes("匕首伏笔"), "nodeDigest 含层级/状态/意图");
  const rp = rpSystemPrompt({ userName: "旅行者", charNames: [" Morgana "], styleInstructions: "第二人称现在时" });
  t.ok(rp.includes("不替用户角色说话") && rp.includes("旅行者"), "RP 系统提示含核心约束");
}
