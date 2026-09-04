// 剧场偏好记忆测试（prefs.ts：默认兜底/值域/坏数据不炸）
import { parsePrefs, serializePrefs, DEFAULT_PREFS } from "../../dist-test/flow/prefs.js";

export default async function (t) {
  // 1. 空/坏输入 → 全默认
  for (const bad of [null, undefined, "", "xx", "[", "5", '{"pace":123}']) {
    const p = parsePrefs(bad);
    t.eq(p.pace, DEFAULT_PREFS.pace, "1. pace 默认: " + String(bad));
    t.eq(p.budgetTokens, 8192, "1. 预算默认");
    t.eq(p.lastRoomId, "", "1. 房间默认空");
  }

  // 2. 往返
  {
    const p = { ...DEFAULT_PREFS, lastProjectId: "p1", lastRoomId: "r7", pace: "tight", ledgerCadence: 8, borrowProjectLedger: true };
    const back = parsePrefs(serializePrefs(p));
    t.eq(back.lastProjectId, "p1", "2. 项目记忆");
    t.eq(back.lastRoomId, "r7", "2. 房间记忆");
    t.eq(back.pace, "tight", "2. 节奏记忆");
    t.eq(back.ledgerCadence, 8, "2. 楼层频率记忆");
    t.eq(back.borrowProjectLedger, true, "2. 借用开关记忆");
  }

  // 3. 值域净化
  {
    const p = parsePrefs(JSON.stringify({ pace: "wild", scopeMode: "x", ledgerCadence: -5, budgetTokens: 3, reserveTokens: "z", lastCharId: 42 }));
    t.eq(p.pace, "loose", "3. 非法 pace 落默认");
    t.ok(!("scopeMode" in p), "3. 已废弃 scopeMode 不进结果");
    t.eq(p.ledgerCadence, DEFAULT_PREFS.ledgerCadence, "3. 负楼层落默认（v3.1 默认=1 每楼自动）");
    t.eq(DEFAULT_PREFS.ledgerCadence, 1, "3. 默认楼层频率=1（场记每楼自动标进度）");
    t.eq(p.budgetTokens, 8192, "3. 过小预算落默认");
    t.eq(p.reserveTokens, 768, "3. 非数预留落默认");
    t.ok(!("lastCharId" in p), "3. 已废弃 lastCharId 不进结果");
  }

  // 4. 合法边界保留
  {
    const p = parsePrefs(JSON.stringify({ ledgerCadence: 100.7, budgetTokens: 1048576, reserveTokens: 0 }));
    t.eq(p.ledgerCadence, 100, "4. 取整封顶 100");
    t.eq(p.budgetTokens, 1048576, "4. 大预算合法");
    t.eq(p.reserveTokens, 0, "4. 预留 0 合法（区别于缺失）");
  }
}
