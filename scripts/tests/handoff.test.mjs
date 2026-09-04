// 页签交接纯逻辑测试：解析校验/项目隔离/TTL 过期/形状净化
import { parseHandoff, serializeHandoff, handoffStorageKey, HANDOFF_TTL_MS } from "../../dist-test/flow/handoff.js";

const NOW = 1_700_000_000_000;

export default async function (t) {
  // 1. 三类正常往返
  {
    const th = { kind: "theater", projectId: "p1", nodeId: "n1", charHint: "薇薇安", ts: NOW };
    const p = parseHandoff(serializeHandoff(th), { kind: "theater", projectId: "p1", now: NOW });
    t.eq(p && p.kind, "theater", "1. theater 往返");
    t.eq(p && p.nodeId, "n1", "1. nodeId 保留");
    t.eq(p && p.charHint, "薇薇安", "1. charHint 保留");
    const rc = parseHandoff(serializeHandoff({ kind: "recap", projectId: "p1", nodeId: "n1", ts: NOW }), {
      kind: "recap", projectId: "p1", now: NOW,
    });
    t.ok(rc && rc.sessionId === undefined, "1. recap 可选 sessionId 缺省不造假");
    const co = parseHandoff(serializeHandoff({ kind: "correction", projectId: "p1", text: "拉回大纲", ts: NOW }), {
      kind: "correction", projectId: "p1", now: NOW,
    });
    t.eq(co && co.text, "拉回大纲", "1. correction 往返");
  }

  // 2. 垃圾输入全 null 不抛
  for (const bad of [null, undefined, "", "not json", "[1,2]", '"str"', "42"]) {
    t.eq(parseHandoff(bad, { kind: "theater", projectId: "p1", now: NOW }), null, "2. 垃圾输入 → null: " + String(bad));
  }

  // 3. kind / projectId 隔离（防止 A 作品投递被 B 作品消费）
  t.eq(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: NOW }), { kind: "theater", projectId: "p2", now: NOW }), null, "3. 项目不符 → null");
  t.eq(parseHandoff(serializeHandoff({ kind: "correction", projectId: "p1", text: "x", ts: NOW }), { kind: "theater", projectId: "p1", now: NOW }), null, "3. kind 不符 → null");

  // 4. TTL 与钟表宽容
  t.eq(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: NOW - HANDOFF_TTL_MS - 1 }), { kind: "theater", projectId: "p1", now: NOW }), null, "4. 过期 → null");
  t.ok(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: NOW - HANDOFF_TTL_MS + 1000 }), { kind: "theater", projectId: "p1", now: NOW }), "4. 界内保留");
  t.ok(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: NOW + 30_000 }), { kind: "theater", projectId: "p1", now: NOW }), "4. 未来 30s（钟表偏差）容忍");
  t.eq(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: NOW + 3_600_000 }), { kind: "theater", projectId: "p1", now: NOW }), null, "4. 远超未来的伪造 → null");
  t.eq(parseHandoff(serializeHandoff({ kind: "theater", projectId: "p1", nodeId: "n1", ts: "x" }), { kind: "theater", projectId: "p1", now: NOW }), null, "4. ts 非数 → null");

  // 5. 形状净化：必填缺失/空文/杂字段丢弃
  t.eq(parseHandoff(JSON.stringify({ kind: "theater", projectId: "p1", ts: NOW }), { kind: "theater", projectId: "p1", now: NOW }), null, "5. 缺 nodeId → null");
  t.eq(parseHandoff(JSON.stringify({ kind: "correction", projectId: "p1", text: "   ", ts: NOW }), { kind: "correction", projectId: "p1", now: NOW }), null, "5. 空白纠偏文 → null");
  {
    const dirty = parseHandoff(JSON.stringify({ kind: "theater", projectId: "p1", nodeId: "n1", charHint: "", auto: "yes", evil: 1, ts: NOW }), { kind: "theater", projectId: "p1", now: NOW });
    t.ok(dirty !== null && !("charHint" in dirty) && dirty.auto === undefined && !("evil" in dirty), "5. 空 hint/非法 auto/杂字段净化");
  }

  // 6. 存储键稳定（页签两侧约定同一个键）
  t.eq(handoffStorageKey("theater"), "ss.jump.theater", "6. 键约定");
  t.eq(handoffStorageKey("recap"), "ss.jump.recap", "6. 键约定");
}
