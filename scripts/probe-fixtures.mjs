// 一次性集成探针：fixture → 兼容层真实解析（跑完可删）
import { readFileSync } from "node:fs";
import { normalizeLorebook, toLoreEntries } from "../dist-test/st/lorebook.js";
import { parseStChat, toTranscript } from "../dist-test/st/chatlog.js";
import { matchLore } from "../dist-test/st/matcher.js";

let fail = 0;
const ok = (c, m) => { console.log(`${c ? "ok" : "FAIL"}  ${m}`); if (!c) fail++; };

// 1. 世界书 fixture
const wi = JSON.parse(readFileSync("docs/fixtures/worldinfo-sample.json", "utf8"));
const book = normalizeLorebook(wi, "auto");
ok(book.entries.length === 4, `世界书解析 ${book.entries.length} 条（期望 4）`);
const entries = toLoreEntries(book, "p1", 1);
ok(entries.find((e) => e.uid === 3)?.enabled === false, "disable 词条 enabled=false");
const tower = entries.find((e) => e.keys.includes("黑塔"));
ok(!!tower && tower.group === "locations" && tower.position === "after_char", "黑塔词条 group/position");
const sel = entries.find((e) => e.selective);
ok(!!sel && sel.secondaryKeys.includes("烧毁"), "selective 副键");

// 2. 匹配引擎在 fixture 上的行为
const hits = matchLore(entries, { scanDepth: 4, tokenBudget: 2048, recursiveScanning: true },
  { history: [
    { name: "Morgana", content: "她望着远处的黑塔" },
    { name: "旅行者", content: "契约真的要烧毁吗" },
  ] }, (s) => Math.ceil(s.length / 4));
const uids = hits.injected.map((h) => h.entry.uid);
ok(uids.includes(0), "constant 词条命中");
ok(uids.includes(1), "黑塔关键词命中");
ok(uids.includes(2), "契约+烧毁 主副键命中");
ok(!uids.includes(3), "disable 词条不出现");

// 3. 试跑记录 fixture
const jl = readFileSync("docs/fixtures/trial-chat-sample.jsonl", "utf8");
const msgs = parseStChat(jl, "trial-chat-sample.jsonl");
ok(msgs.length === 6, `聊天解析 ${msgs.length} 条（期望 6：含 1 条 system，metadata 头跳过）`);
ok(msgs[0].name === "Morgana" && !msgs[0].isUser, "首条 Morgana char");
ok(msgs[2].content.includes("火焰吞没"), "swipe_id=1 取到第二候选");
ok(msgs.filter((m) => m.role === "system").length === 1, "System 标记为 system 不混入正文");
const tr = toTranscript(msgs);
ok(tr.split("\n").length === 5 && !tr.includes("[Scene change"), "transcript 5 行且无舞台指示");

console.log(fail ? `\n探针失败 ${fail} 项` : "\nfixture 探针全部通过");
process.exit(fail ? 1 : 0);
