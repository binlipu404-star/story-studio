// matcher.ts sticky/cooldown 冒烟测试（确定性重放状态机）
import { matchLore } from "../../dist-test/st/matcher.js";

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

const msg = (content, name = "user") => ({ name, content });
const est = (str) => Math.ceil(str.length / 2);
const hit = (entry, history, scanDepth = 1) =>
  matchLore([entry], { scanDepth, tokenBudget: 1e9, recursiveScanning: false }, { history }, est).injected.length > 0;

export default async function (t) {
  const key = { keys: ["神像"] };

  // 1. sticky=0 & cooldown=0：走普通窗判定（回归不破）；sticky=1 与之逐位等价
  {
    const plain = e({ uid: 1, ...key });
    const timer1 = e({ uid: 11, ...key, sticky: 1, cooldown: 0 });
    const inWin = [msg("守卫让开了"), msg("他走向神像")];
    const outWin = [msg("他走向神像"), msg("守卫让开了"), msg("门吱呀一声")];
    t.ok(hit(plain, inWin, 1), "1. 窗内命中（普通语义不变）");
    t.ok(!hit(plain, outWin, 1), "1. 窗外即失效（无 sticky）");
    t.ok(hit(timer1, inWin, 1), "1. sticky=1 窗内命中");
    t.ok(!hit(timer1, outWin, 1), "1. sticky=1 ≡ 普通语义（窗外不续命）");
  }

  // 2. sticky=2：键离开扫描窗后仍活跃 1 轮，再下一轮熄灭
  {
    const en = e({ uid: 2, ...key, sticky: 2, depth: 0 });
    // 触发轮（键在最后一条）
    t.ok(hit(en, [msg("他走向神像")], 1), "2. 触发轮活跃");
    // 键离开窗（depth=1）后第一轮：sticky 维持
    t.ok(hit(en, [msg("他走向神像"), msg("守卫让开了")], 1), "2. sticky 续命第一轮");
    // 第二轮：sticky 窗耗尽
    t.ok(!hit(en, [msg("他走向神像"), msg("守卫让开了"), msg("门吱呀一声")], 1), "2. sticky 耗尽后熄灭");
  }

  // 3. sticky=3 + cooldown=3：熄灭后进冷却，冷却期内直接命中也被压制，冷却结束重触发
  {
    const en = e({ uid: 3, ...key, sticky: 3, cooldown: 3 });
    const base = [msg("他走向神像")];
    // t1 触发, activeUntil=3（t1..t3）；t4 转灭 → coolUntil=3+3=6
    t.ok(hit(en, base, 1), "3. t1 触发");
    t.ok(hit(en, [...base, msg("a")], 1), "3. t2 sticky");
    t.ok(hit(en, [...base, msg("a"), msg("b")], 1), "3. t3 sticky");
    t.ok(!hit(en, [...base, msg("a"), msg("b"), msg("c")], 1), "3. t4 熄灭");
    // t5/t6 冷却中：即便最后一条直接命中键也压制
    t.ok(!hit(en, [...base, msg("a"), msg("b"), msg("c"), msg("神像 again")], 1), "3. t5 冷却压制直接命中");
    t.ok(!hit(en, [...base, msg("a"), msg("b"), msg("c"), msg("x"), msg("神像 again")], 1), "3. t6 冷却仍压制");
    // t7 冷却结束（coolUntil=6 < 7）：重新触发
    t.ok(hit(en, [...base, msg("a"), msg("b"), msg("c"), msg("x"), msg("y"), msg("神像 again")], 1), "3. t7 冷却结束重触发");
  }

  // 4. cooldown=0 但 sticky 大：窗内命中会刷新 sticky 窗（重放全程，语义=最近一次命中决定）
  {
    const en = e({ uid: 4, ...key, sticky: 2 });
    t.ok(
      hit(en, [msg("神像 first"), msg("a"), msg("神像 again"), msg("b")], 1),
      "4. 第二次命中刷新 sticky（距最近命中 1 轮 < 2）",
    );
    t.ok(
      !hit(en, [msg("神像 first"), msg("a"), msg("神像 again"), msg("b"), msg("c")], 1),
      "4. 距最近命中 2 轮：sticky 窗耗尽",
    );
  }

  // 5. 副键词条：sticky 判定沿用主+副键联合语义（触发轮主副齐即可）
  {
    const en = e({ uid: 5, keys: ["神像"], selective: true, secondaryKeys: ["匕首"], sticky: 3 });
    t.ok(hit(en, [msg("神像下藏着匕首"), msg("a")], 1), "5. 主副同窗触发后 sticky 续命（后续无副键也维持）");
    t.ok(
      !hit(en, [msg("神像下藏着匕首"), msg("a"), msg("b"), msg("c")], 1),
      "5. sticky 窗耗尽后熄灭",
    );
  }

  // 6. constant 不受定时逻辑影响（sticky 对 constant 无意义，照常必中）
  {
    const en = e({ uid: 6, constant: true, keys: [], sticky: 2, cooldown: 5 });
    t.ok(hit(en, [msg("无关内容")], 1), "6. constant 无视 cooldown 必中");
  }
}
