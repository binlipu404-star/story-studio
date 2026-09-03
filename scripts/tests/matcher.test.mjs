// matcher.ts 逻辑冒烟测试（node scripts/run-tests.mjs 调用，先 npm run build:logic）
import { matchLore, buildLoreInjection } from "../../dist-test/st/matcher.js";

// ---------- fixture 工厂 ----------
function e(partial = {}) {
  return {
    id: partial.id ?? `id-${partial.uid ?? 0}`,
    projectId: "p1",
    uid: 0,
    comment: "",
    content: "default content",
    keys: ["x"],
    secondaryKeys: [],
    constant: false,
    selective: false,
    caseSensitive: false,
    matchWholeWord: false,
    position: "before_char",
    order: 100,
    depth: null,
    sticky: null,
    cooldown: null,
    probability: 100,
    useProbability: false,
    group: "",
    groupOverride: false,
    groupWeight: 0,
    excludeRecursion: false,
    preventRecursion: false,
    enabled: true,
    extensions: {},
    ...partial,
  };
}

function s(partial = {}) {
  return { scanDepth: 2, tokenBudget: 1e9, recursiveScanning: false, ...partial };
}

const msg = (content, name = "user") => ({ name, content });
const est = (str) => Math.ceil(str.length / 2); // 确定性 stub

const uids = (arr) => arr.map((m) => m.entry.uid);

export default async function (t) {
  // ---------- 1. constant 必中，且不受扫描窗内容影响 ----------
  {
    const r = matchLore(
      [e({ uid: 1, constant: true, keys: ["qqq"], content: "always here" })],
      s(),
      { history: [msg("nothing relevant at all")] },
      est,
    );
    t.eq(uids(r.injected), [1], "constant：无关历史也注入");
    t.eq(r.injected[0].via, "constant", "constant：via=constant");
    const off = matchLore(
      [e({ uid: 2, constant: true })],
      s(),
      { history: [] },
      est,
    );
    t.eq(uids(off.injected), [2], "constant：空 history 也注入");
  }

  // ---------- 2. 扫描窗 ----------
  {
    const hist = [
      msg("the needle was here long ago"),
      msg("alpha beta"),
      msg("gamma delta"),
    ];
    const outside = matchLore([e({ uid: 3, keys: ["needle"] })], s({ scanDepth: 2 }), { history: hist }, est);
    t.eq(uids(outside.injected), [], "窗口外旧消息的关键词不命中");
    const inside = matchLore(
      [e({ uid: 4, keys: ["needle"] })],
      s({ scanDepth: 2 }),
      { history: [msg("alpha beta"), msg("found a needle")] },
      est,
    );
    t.eq(uids(inside.injected), [4], "关键词在最后一条 → 命中");
    t.eq(inside.injected[0].via, "primary", "主键命中 via=primary");
    const overridden = matchLore([e({ uid: 5, keys: ["needle"] })], s({ scanDepth: 2 }), { history: hist, depthOverride: 3 }, est);
    t.eq(uids(overridden.injected), [5], "depthOverride=3 扩大窗口 → 命中");
  }

  // ---------- 3. 大小写 ----------
  {
    const ci = matchLore([e({ uid: 6, keys: ["Alice"] })], s(), { history: [msg("alice smiled")] }, est);
    t.eq(uids(ci.injected), [6], "默认大小写不敏感：key Alice 中 alice");
    const csMiss = matchLore([e({ uid: 7, keys: ["Alice"], caseSensitive: true })], s(), { history: [msg("alice smiled")] }, est);
    t.eq(uids(csMiss.injected), [], "caseSensitive：key Alice 不误中 alice");
    const csHit = matchLore([e({ uid: 8, keys: ["Alice"], caseSensitive: true })], s(), { history: [msg("Alice smiled")] }, est);
    t.eq(uids(csHit.injected), [8], "caseSensitive：原样出现则命中");
  }

  // ---------- 4. 整词（CJK 感知） ----------
  {
    const ww = (uid, keys) => e({ uid, keys, matchWholeWord: true });
    const noCata = matchLore([ww(9, ["cat"])], s(), { history: [msg("a catalog of items")] }, est);
    t.eq(uids(noCata.injected), [], '整词："cat" 不中 "catalog"');
    const yesCat = matchLore([ww(10, ["cat"])], s(), { history: [msg("the cat sat")] }, est);
    t.eq(uids(yesCat.injected), [10], '整词："cat" 中 "the cat sat"');
    const yesCatCi = matchLore([ww(11, ["CAT"])], s(), { history: [msg("the cat sat")] }, est);
    t.eq(uids(yesCatCi.injected), [11], "整词+大小写不敏感：CAT 中 cat");
    const cjk = matchLore([ww(12, ["剑"])], s(), { history: [msg("他拔出剑鞘旁的剑")] }, est);
    t.eq(uids(cjk.injected), [12], '整词+CJK："剑" 中 "他拔出剑鞘旁的剑"（不做词边界）');
  }

  // ---------- 5. selective AND_ANY ----------
  {
    const sel = (uid) => e({ uid, keys: ["alpha"], secondaryKeys: ["beta"], selective: true });
    const noSec = matchLore([sel(13)], s(), { history: [msg("only alpha here")] }, est);
    t.eq(uids(noSec.injected), [], "selective：副键未命中则不中");
    const withSec = matchLore([sel(14)], s(), { history: [msg("alpha and beta")] }, est);
    t.eq(uids(withSec.injected), [14], "selective：主键任一+副键任一 → 命中");
    t.eq(withSec.injected[0].via, "secondary", "副键参与时 via=secondary");
    const emptySec = matchLore(
      [e({ uid: 15, keys: ["alpha"], secondaryKeys: [], selective: true })],
      s(),
      { history: [msg("only alpha here")] },
      est,
    );
    t.eq(uids(emptySec.injected), [15], "selective 但副键为空 → 等价普通主键匹配");
    t.eq(emptySec.injected[0].via, "primary", "副键为空 via=primary");
  }

  // ---------- 6. order 排序 + token 预算截断 ----------
  {
    // est("aaaa")=2, est("bbbbbb")=3, est("cc")=1；预算 4：A(2) 进，B(+3=5>4) 裁，C(2+1=3) 进
    const r = matchLore(
      [
        e({ uid: 16, constant: true, order: 1, content: "aaaa" }),
        e({ uid: 17, constant: true, order: 2, content: "bbbbbb" }),
        e({ uid: 18, constant: true, order: 3, content: "cc" }),
      ],
      s({ tokenBudget: 4 }),
      { history: [msg("irrelevant")] },
      est,
    );
    t.eq(uids(r.injected), [16, 18], "预算：超支词条裁掉，后续小词条继续装箱");
    t.eq(uids(r.dropped), [17], "被裁词条进 dropped");
    t.eq(r.usedTokens, 3, "usedTokens=2+1=3");
    const sorted = matchLore(
      [
        e({ uid: 21, constant: true, order: 30 }),
        e({ uid: 22, constant: true, order: 10 }),
        e({ uid: 23, constant: true, order: 20 }),
        e({ uid: 24, constant: true, order: 10 }), // 与 uid22 同 order → uid 升序
      ],
      s(),
      { history: [] },
      est,
    );
    t.eq(uids(sorted.injected), [22, 24, 23, 21], "injected 按 order 升序、tie 按 uid 升序");
  }

  // ---------- 7. before/after 分流 ----------
  {
    const r = matchLore(
      [
        e({ uid: 25, constant: true, position: "before_char", order: 1 }),
        e({ uid: 26, constant: true, position: "after_char", order: 2 }),
        e({ uid: 27, constant: true, position: "before_char", order: 3 }),
      ],
      s(),
      { history: [] },
      est,
    );
    t.eq(uids(r.before), [25, 27], "before_char 按 order 进 before");
    t.eq(uids(r.after), [26], "after_char 进 after");
    const inj = buildLoreInjection(
      matchLore(
        [
          e({ uid: 28, constant: true, order: 2, content: "second" }),
          e({ uid: 29, constant: true, order: 1, content: "first" }),
        ],
        s(),
        { history: [] },
        est,
      ),
    );
    t.eq(inj, "first\nsecond", "buildLoreInjection 按 order 以 \\n 连接");
  }

  // ---------- 8. probability + random 注入 ----------
  {
    const mk = (uid, probability) =>
      e({ uid, keys: ["alpha"], useProbability: true, probability });
    const zero = matchLore([mk(30, 0)], s(), { history: [msg("alpha")] }, est, );
    // 默认 Math.random 下 0 概率必不中；再显式注入 0.5 验证接口
    const zero5 = matchLore([mk(31, 0)], s(), { history: [msg("alpha")], random: () => 0.5 }, est);
    t.eq(uids(zero.injected), [], "probability=0 → 被丢");
    t.eq(uids(zero5.injected), [], "probability=0 + random=0.5 → 被丢");
    const full = matchLore([mk(32, 100)], s(), { history: [msg("alpha")], random: () => 0.999 }, est);
    t.eq(uids(full.injected), [32], "probability=100 → 必留（>=100 不掷骰）");
    const halfHit = matchLore([mk(33, 50)], s(), { history: [msg("alpha")], random: () => 0.4 }, est);
    t.eq(uids(halfHit.injected), [33], "probability=50 + random=0.4 → 保留");
    const halfMiss = matchLore([mk(34, 50)], s(), { history: [msg("alpha")], random: () => 0.6 }, est);
    t.eq(uids(halfMiss.injected), [], "probability=50 + random=0.6 → 被丢");
    let rolls = 0;
    const counting = () => {
      rolls++;
      return 0.5;
    };
    const konst = matchLore(
      [e({ uid: 35, constant: true, useProbability: true, probability: 0 })],
      s(),
      { history: [msg("alpha")], random: counting },
      est,
    );
    t.eq(uids(konst.injected), [35], "constant 不掷骰：probability=0 仍保留");
    t.eq(rolls, 0, "constant 完全不消耗 random");
  }

  // ---------- 9. 递归扫描 ----------
  {
    const mkA = (uid, partial = {}) =>
      e({ uid, keys: ["trigger"], content: "A talks about dragons.", ...partial });
    const mkB = (uid) => e({ uid, keys: ["dragon"], content: "dragon lore" });
    const hist = [msg("a trigger appeared")];
    const rec = matchLore([mkA(36), mkB(37)], s({ recursiveScanning: true }), { history: hist }, est);
    t.eq(uids(rec.injected).sort((a, b) => a - b), [36, 37], "递归：A 命中后其 content 带出 B");
    t.eq(rec.injected.find((m) => m.entry.uid === 37).via, "recursion", "B via=recursion");
    const noRec = matchLore([mkA(38), mkB(39)], s({ recursiveScanning: false }), { history: hist }, est);
    t.eq(uids(noRec.injected), [38], "recursiveScanning=false → 不递归");
    const excl = matchLore(
      [mkA(40, { excludeRecursion: true }), mkB(41)],
      s({ recursiveScanning: true }),
      { history: hist },
      est,
    );
    t.eq(uids(excl.injected), [40], "A.excludeRecursion → A 内容不参与扩展扫描，B 不中");
    const prevent = matchLore(
      [mkA(42, { preventRecursion: true }), mkB(43)],
      s({ recursiveScanning: true }),
      { history: hist },
      est,
    );
    t.eq(uids(prevent.injected), [42], "A.preventRecursion → 整个递归轮跳过");
    const direct = matchLore(
      [mkA(44), mkB(45)],
      s({ recursiveScanning: true }),
      { history: [msg("a trigger and a dragon")] },
      est,
    );
    t.eq(uids(direct.injected).sort((a, b) => a - b), [44, 45], "B 已被第一轮命中 → 不重复");
    t.eq(direct.injected.find((m) => m.entry.uid === 45).via, "primary", "第一轮命中保持 primary");
  }

  // ---------- 10. group 同组只留 groupWeight 高者 ----------
  {
    const r = matchLore(
      [
        e({ uid: 46, constant: true, group: "g1", groupWeight: 5, order: 1 }),
        e({ uid: 47, constant: true, group: "g1", groupWeight: 9, order: 2 }),
        e({ uid: 48, constant: true, group: "g2", groupWeight: 5, order: 1 }),
        e({ uid: 49, constant: true, group: "g2", groupWeight: 5, order: 2 }),
        e({ uid: 50, constant: true, group: "", order: 3 }),
      ],
      s(),
      { history: [] },
      est,
    );
    t.eq(uids(r.injected), [48, 47, 50], "group：g1 留权重高者(47)，g2 平权留 order 小者(48)，空组不受限（结果按 order 升序）");
    t.eq(r.dropped.length, 0, "group 落选者不进 dropped（直接舍弃）");
  }

  // ---------- 11. depth!=null 进 deep 分组且照常进 before/after ----------
  {
    const r = matchLore(
      [
        e({ uid: 51, constant: true, depth: 2, order: 1, content: "d2a", position: "before_char" }),
        e({ uid: 52, constant: true, depth: 1, order: 2, content: "d1", position: "after_char" }),
        e({ uid: 53, constant: true, depth: 2, order: 3, content: "d2b", position: "before_char" }),
        e({ uid: 54, constant: true, depth: null, order: 4, content: "plain" }),
      ],
      s(),
      { history: [] },
      est,
    );
    t.eq(r.deep.map((g) => g.depth), [1, 2], "deep 按 depth 升序分组");
    t.eq(uids(r.deep[0].entries), [52], "depth=1 组内容正确");
    t.eq(uids(r.deep[1].entries), [51, 53], "depth=2 组内按 order 排序");
    t.eq(uids(r.before), [51, 53, 54], "depth 词条照常进 before（54 默认 position=before_char）");
    t.eq(uids(r.after), [52], "depth 词条照常进 after");
    t.ok(!r.deep.some((g) => uids(g.entries).includes(54)), "depth=null 不进 deep");
  }

  // ---------- 12. enabled=false 永不参与 ----------
  {
    const r = matchLore(
      [e({ uid: 55, constant: true, enabled: false }), e({ uid: 56, keys: ["alpha"], enabled: false })],
      s(),
      { history: [msg("alpha")] },
      est,
    );
    t.eq(uids(r.injected), [], "enabled=false 的词条（含 constant）一律不注入");
  }
}
