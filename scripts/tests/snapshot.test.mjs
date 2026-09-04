// 台账快照与伏笔欠账（N1）冒烟测试
import { debtText, foreshadowDebt, ledgerFacts, ledgerSnapshot, LEDGER_TYPE_NAMES } from "../../dist-test/flow/snapshot.js";

let seq = 0;
const mk = (over = {}) => ({
  id: `l${++seq}`,
  projectId: "p",
  type: "event",
  content: "事实",
  actors: [],
  status: "confirmed",
  createdAt: 1000 + seq,
  ...over,
});

const node = (over = {}) => ({
  id: `n${++seq}`,
  projectId: "p",
  parentId: null,
  level: "scene",
  order: 0,
  title: "幕",
  intent: "",
  beats: [],
  cast: [],
  foreshadows: [],
  status: "draft",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

export default async function (t) {
  // 1. 快照只吃 confirmed，时间升序，分组
  const recs = [
    mk({ type: "event", content: "A 烧掉了信" }),
    mk({ type: "item", content: "匕首归 B", status: "proposed" }), // 提案不是事实
    mk({ type: "event", content: "B 抵达港口", createdAt: 900 }),
    mk({ type: "relation", content: "A 恨 B", status: "rejected" }),
  ];
  const s = ledgerSnapshot(recs);
  t.eq(s.counts.event, 2, "1. 只计 confirmed");
  t.ok(s.text.includes("A 烧掉了信") && !s.text.includes("匕首归 B") && !s.text.includes("A 恨 B"), "1. proposed/rejected 不进快照");
  t.ok(s.text.indexOf("B 抵达港口") < s.text.indexOf("A 烧掉了信"), "1. 时间升序");
  t.ok(s.text.startsWith("【台账快照】"), "1. 标题头");
  t.ok(LEDGER_TYPE_NAMES.worldstate === "世界状态", "1. 类型中文名");

  // 2. 时间点快照：upto 截断
  const s2 = ledgerSnapshot(recs, { upto: 950 });
  t.eq(s2.counts.event, 1, "2. upto 之后的记录不可见");
  t.ok(!s2.text.includes("A 烧掉了信"), "2. 晚于时间点的正文被排除");

  // 3. 预算裁切
  const many = Array.from({ length: 50 }, (_, i) => mk({ type: "event", content: `很长的一条事实记录编号${i}，` .padEnd(60, "字") }));
  const s3 = ledgerSnapshot(many, { maxChars: 300 });
  t.ok(s3.dropped > 0 && s3.text.includes("因预算省略"), "3. 超预算裁切并声明");
  t.ok(s3.text.length < 420, "3. 总文本受控：" + s3.text.length);

  // 3b. 空台账 → 空文本
  t.eq(ledgerSnapshot([]).text, "", "3b. 空台账空文本");

  // 4. 伏笔欠账
  const payoffNode = node({ title: "终幕" });
  const nid = payoffNode.id;
  const n1 = node({
    title: "第一幕",
    foreshadows: [
      { id: "f1", setup: "神像下的匕首会易主", payoffIn: nid, status: "planted" },
      { id: "f2", setup: "老宅钥匙在谁手里", status: "planted" },
      { id: "f3", setup: "已被标记回收的伏笔内容", status: "paid" },
    ],
  });
  const led = [
    mk({ type: "foreshadow", content: "后话：神像下的匕首会易主，终于应验在雨夜" }), // 命中 f1
    mk({ type: "foreshadow", content: "无关的伏笔记录" }),
  ];
  const debts = foreshadowDebt([n1, payoffNode], led);
  t.eq(debts.length, 3, "4. 三条伏笔都在账上");
  const f1 = debts.find((d) => d.linkId === "f1");
  const f2 = debts.find((d) => d.linkId === "f2");
  const f3 = debts.find((d) => d.linkId === "f3");
  t.ok(f1.paidByLedger && f1.payoffTitle === "终幕", "4. 台账包含式命中 + 回收节点解析");
  t.ok(!f2.paidByLedger && f2.payoffTitle === "", "4. 未命中即欠账");
  t.ok(f3.paidByLedger, "4. status=paid 直接算已收");

  // 5. 欠账文本
  const dt = debtText(debts);
  t.ok(dt.startsWith("【伏笔欠账】") && dt.includes("老宅钥匙") && !dt.includes("神像下的匕首"), "5. 只列未了账");
  t.eq(debtText(foreshadowDebt([node()], [])), "", "5. 无伏笔空文本");

  // 6. 组合注入文本
  const facts = ledgerFacts([...led, ...recs], [n1, payoffNode]);
  t.ok(facts.includes("【台账快照】") && facts.includes("【伏笔欠账】"), "6. ledgerFacts 双块拼接");
  t.eq(ledgerFacts([], []), "", "6. 无事实空串");
}
