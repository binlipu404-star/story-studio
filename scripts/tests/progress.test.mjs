// 进度记忆测试（progress.ts：读写往返/坏 JSON/前缀隔离/全清/防抖）
import {
  PROGRESS_PREFIX,
  memoryStorage,
  setProgressStorage,
  saveProgress,
  loadProgress,
  clearProgress,
  clearAllProgress,
  progressKey,
  makeDebouncer,
} from "../../dist-test/flow/progress.js";

export default async function (t) {
  setProgressStorage({
    getItem: (k) => memoryStorage.getItem(k),
    setItem: (k, v) => memoryStorage.setItem(k, v),
    removeItem: (k) => memoryStorage.removeItem(k),
    key: (i) => memoryStorage.key(i),
    get length() {
      return memoryStorage.length;
    },
  });
  clearAllProgress();

  // 1. key 规范与前缀
  t.eq(progressKey("ws", "p1"), PROGRESS_PREFIX + "ws.p1", "1. 带 id 的 key");
  t.eq(progressKey("theater"), PROGRESS_PREFIX + "theater", "1. 无 id 的 key");

  // 2. 读写往返与隔离
  saveProgress("ws", "p1", { tab: "outline", draft: "草稿" });
  saveProgress("ws", "p2", { tab: "cast" });
  const a = loadProgress("ws", "p1");
  t.eq(a.tab, "outline", "2. 项目1 页签记忆");
  t.eq(a.draft, "草稿", "2. 草稿记忆");
  t.eq(loadProgress("ws", "p2").tab, "cast", "2. 项目间互不污染");
  t.eq(loadProgress("ws", "p3"), null, "2. 未存过 → null");

  // 3. 坏 JSON → null（不炸）
  memoryStorage.setItem(PROGRESS_PREFIX + "broken", "{oops");
  t.eq(loadProgress("broken"), null, "3. 坏 JSON 返回 null");

  // 4. 单作用域清除不误伤
  clearProgress("ws", "p1");
  t.eq(loadProgress("ws", "p1"), null, "4. 清除 p1");
  t.eq(loadProgress("ws", "p2").tab, "cast", "4. p2 未受牵连");

  // 5. 全清只动 ss.progress.*，别的前缀保留
  memoryStorage.setItem("ss.theater.prefs", "{}");
  const n = clearAllProgress();
  t.ok(n >= 2, "5. 全清条数 ≥2：" + n);
  t.eq(loadProgress("ws", "p2"), null, "5. 进度全清");
  t.eq(memoryStorage.getItem("ss.theater.prefs"), "{}", "5. prefs 不被误清");

  // 6. 防抖器：bump 合并、flushNow 立取
  let hits = 0;
  const d = makeDebouncer(30, () => (hits += 1));
  d.bump();
  d.bump();
  d.bump();
  t.eq(d.pending(), true, "6. 待触发中");
  t.eq(hits, 0, "6. 连打未触发");
  await new Promise((r) => setTimeout(r, 60));
  t.eq(hits, 1, "6. 合并为一次");
  d.bump();
  d.flushNow();
  t.eq(hits, 2, "6. flushNow 立即兑现");
  t.eq(d.pending(), false, "6. flush 后无残留");
  d.bump();
  d.cancel();
  await new Promise((r) => setTimeout(r, 60));
  t.eq(hits, 2, "6. cancel 吞掉待发");

  clearAllProgress();
  setProgressStorage(null);
};
