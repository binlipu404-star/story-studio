// ============================================================
// 页签间一次性交接（RP 剧场 ⇄ ST 试跑）
//
// 工作区页签切换会卸载页面组件，页面态必须过一层「一次性投递箱」：
// localStorage 存 JSON，消费即删 + 项目作用域 + TTL 过期，防止串幕/串作品/陈旧误触发。
// 纯逻辑（serialize/parse）可在 Node 测试；localStorage 只是最薄的壳。
// ============================================================

export type HandoffKind = "theater" | "recap" | "correction";

export interface TheaterHandoff {
  kind: "theater";
  projectId: string;
  nodeId: string;
  /** 会话里最后的角色名：剧场据此自动选中人物卡（找不到则维持默认） */
  charHint?: string;
  /** 把这条试跑工作会话的对话导入新建房间（「续写（去剧场）」） */
  sessionId?: string;
  ts: number;
}

export interface RecapHandoff {
  kind: "recap";
  projectId: string;
  nodeId: string;
  /** 精确指定要复盘的会话；缺省 = 该幕最近一条有消息的 testing 会话 */
  sessionId?: string;
  ts: number;
}

export interface CorrectionHandoff {
  kind: "correction";
  projectId: string;
  text: string;
  ts: number;
}

export type Handoff = TheaterHandoff | RecapHandoff | CorrectionHandoff;

/** 交接有效期：10 分钟（换页即时消费；隔太久再开页面不该被陈旧投递劫持） */
export const HANDOFF_TTL_MS = 10 * 60_000;

export const handoffStorageKey = (kind: HandoffKind): string => `ss.jump.${kind}`;

export function serializeHandoff(h: Handoff): string {
  return JSON.stringify(h);
}

/**
 * 解析并校验投递：JSON 坏/非对象/项目不符/类型或必填缺失/过期（含未来时间 60s 以上容差）→ null。
 * 纯函数，now 由调用方给（测试确定性）。不做删除——消费端负责 removeItem。
 */
export function parseHandoff(
  raw: string | null | undefined,
  expect: { kind: HandoffKind; projectId: string; now: number },
): Handoff | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r.kind !== expect.kind) return null;
  if (typeof r.projectId !== "string" || !r.projectId) return null;
  if (expect.projectId !== "*" && r.projectId !== expect.projectId) return null;
  const pid = r.projectId;
  const ts = r.ts;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
  if (expect.now - ts > HANDOFF_TTL_MS || ts - expect.now > 60_000) return null;
  if (expect.kind === "theater") {
    if (typeof r.nodeId !== "string") return null; // "" = 无指定幕（作品级「导去剧场演」）
    return {
      kind: "theater",
      projectId: pid,
      nodeId: r.nodeId,
      ...(typeof r.charHint === "string" && r.charHint ? { charHint: r.charHint } : {}),
      ...(typeof r.sessionId === "string" && r.sessionId ? { sessionId: r.sessionId } : {}),
      ts,
    };
  }
  if (expect.kind === "recap") {
    if (typeof r.nodeId !== "string" || !r.nodeId) return null;
    return {
      kind: "recap",
      projectId: pid,
      nodeId: r.nodeId,
      ...(typeof r.sessionId === "string" && r.sessionId ? { sessionId: r.sessionId } : {}),
      ts,
    };
  }
  // correction
  if (typeof r.text !== "string" || !r.text.trim()) return null;
  return { kind: "correction", projectId: pid, text: r.text, ts };
}

// ---------- localStorage 薄壳（浏览器端；Node 环境静默无操作） ----------

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // 隐私模式等
  }
};

/** putHandoff 的入参：各分支去掉 ts 后逐支交叉（ts 可缺省 = 现在） */
export type HandoffInput =
  | (Omit<TheaterHandoff, "ts"> & { ts?: number })
  | (Omit<RecapHandoff, "ts"> & { ts?: number })
  | (Omit<CorrectionHandoff, "ts"> & { ts?: number });

export function putHandoff(h: HandoffInput): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(handoffStorageKey(h.kind), serializeHandoff({ ...h, ts: h.ts ?? Date.now() } as Handoff));
  } catch {
    // 投递失败不炸调用方（跳转仍会发生，只是少了预填）
  }
}

/** 读取并消费（删除）。校验不过（含项目不符/过期）也会清掉坏投递。 */
export function takeHandoff(kind: HandoffKind, projectId: string): Handoff | null {
  const s = storage();
  if (!s) return null;
  const key = handoffStorageKey(kind);
  let raw: string | null = null;
  try {
    raw = s.getItem(key);
    if (raw === null) return null;
    s.removeItem(key);
    return parseHandoff(raw, { kind, projectId, now: Date.now() });
  } catch {
    try {
      s.removeItem(key);
    } catch {
      // 忽略
    }
    return null;
  }
}

/** 只看不消费（ProjectsPage 借 recap 投递自动打开对应工作台；消费仍归目标页）。 */
export function peekHandoff(kind: HandoffKind, projectId: string): Handoff | null {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(handoffStorageKey(kind));
    if (raw === null) return null;
    return parseHandoff(raw, { kind, projectId, now: Date.now() });
  } catch {
    return null;
  }
}
