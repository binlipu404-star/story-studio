// ============================================================
// 台账快照与伏笔欠账（N1 台账闭环的纯逻辑层）
//
// 定位：台账（已确认事实）→ 可注入提示词的紧凑文本；
//       大纲 foreshadows（意图·埋）× 台账 foreshadow 记录（事实·收）→ 欠账清单。
// 约定：只有 status==="confirmed" 的台账才进快照/欠账判定——提案未裁决的不是事实。
// 纯模块：不依赖 DOM/网络；prompts.ts 靠"调用方预生成文本"消费本模块（保持提示词库零运行时依赖）。
// ============================================================

import type { ForeshadowLink, ID, LedgerRecord, LedgerType, OutlineNode } from "../core/types";

export const LEDGER_TYPE_NAMES: Record<LedgerType, string> = {
  event: "事件",
  item: "道具",
  relation: "关系",
  foreshadow: "伏笔",
  worldstate: "世界状态",
};

/** 台账类型全集（UI 过滤器共用，顺序即展示顺序） */
export const LEDGER_TYPES: LedgerType[] = ["event", "item", "relation", "foreshadow", "worldstate"];

export interface LedgerSnapshot {
  counts: Partial<Record<LedgerType, number>>;
  /** 分组后的已确认记录（时间升序） */
  byType: Partial<Record<LedgerType, LedgerRecord[]>>;
  /** 注入文本（【台账快照】…）；无已确认事实时为 "" */
  text: string;
  /** 被 maxChars 裁掉的条目数 */
  dropped: number;
}

function norm(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 已确认台账 → 时间点快照。
 * upto：只看得到这个时刻之前的记录（时间点参照，缺省=现在）。
 * maxChars：注入文本总预算（默认 900；按类型轮转取样，防单类挤爆）。
 */
export function ledgerSnapshot(
  records: LedgerRecord[],
  opts: { upto?: number; maxChars?: number } = {},
): LedgerSnapshot {
  const upto = opts.upto ?? Number.POSITIVE_INFINITY;
  const maxChars = opts.maxChars ?? 900;
  const confirmed = records
    .filter((r) => r.status === "confirmed" && r.createdAt <= upto && r.content.trim())
    .sort((a, b) => a.createdAt - b.createdAt);

  const byType: Partial<Record<LedgerType, LedgerRecord[]>> = {};
  const counts: Partial<Record<LedgerType, number>> = {};
  for (const t of LEDGER_TYPES) {
    const list = confirmed.filter((r) => r.type === t);
    if (list.length > 0) {
      byType[t] = list;
      counts[t] = list.length;
    }
  }
  if (confirmed.length === 0) return { counts, byType, text: "", dropped: 0 };

  // 轮转取样：event→item→relation→foreshadow→worldstate 逐条取，直到预算耗尽
  const queues = LEDGER_TYPES.map((t) => [...(byType[t] ?? [])]);
  const picked: string[] = [];
  let used = 0;
  let dropped = 0;
  let progress = true;
  while (progress && dropped === 0) {
    progress = false;
    for (const q of queues) {
      if (q.length === 0) continue;
      const line = `- [${LEDGER_TYPE_NAMES[q[0].type]}] ${clip(q[0].content, 160)}`;
      if (used + line.length + 1 > maxChars) {
        dropped = queues.reduce((n, x) => n + x.length, 0); // 从此处起剩余全部计为被裁
        break;
      }
      q.shift();
      picked.push(line);
      used += line.length + 1;
      progress = true;
    }
  }
  const head = "【台账快照】以下为本作已确认事实，续写与提案不得与之矛盾：";
  const text = `${head}\n${picked.join("\n")}${dropped > 0 ? `\n（另有 ${dropped} 条更早之外的记录因预算省略）` : ""}`;
  return { counts, byType, text, dropped };
}

// ---------- 伏笔欠账 ----------

export interface ForeshadowDebt {
  nodeId: ID;
  nodeTitle: string;
  linkId: string;
  setup: string;
  /** 计划回收节点标题（payoffIn 解析；找不到为 ""） */
  payoffTitle: string;
  status: ForeshadowLink["status"];
  /** 台账里是否已有对应已确认的回收记录 */
  paidByLedger: boolean;
  /** 命中的台账记录内容 */
  matched?: string;
}

/**
 * 大纲伏笔（埋）× 台账（收）→ 欠账清单（默认只列未了的 planted）。
 * 判定「已收」：link.status==="paid"，或存在已确认 foreshadow 台账的正文与 setup 互为包含（≥6 字归一化匹配）。
 */
export function foreshadowDebt(nodes: OutlineNode[], ledger: LedgerRecord[]): ForeshadowDebt[] {
  const titleById = new Map<ID, string>(nodes.map((n) => [n.id, n.title]));
  const paidRecords = ledger
    .filter((r) => r.status === "confirmed" && r.type === "foreshadow" && r.content.trim())
    .map((r) => ({ raw: r.content.trim(), n: norm(r.content) }));

  const debts: ForeshadowDebt[] = [];
  for (const node of nodes) {
    for (const link of node.foreshadows ?? []) {
      if (!link.setup.trim()) continue;
      const key = norm(link.setup);
      const hit =
        link.status === "paid"
          ? { raw: "（大纲已标记回收）" }
          : key.length >= 6
            ? paidRecords.find((p) => p.n.includes(key) || (key.includes(p.n) && p.n.length >= 6))
            : undefined;
      debts.push({
        nodeId: node.id,
        nodeTitle: node.title || "（未命名）",
        linkId: link.id,
        setup: link.setup.trim(),
        payoffTitle: link.payoffIn ? titleById.get(link.payoffIn) ?? "（节点已删）" : "",
        status: link.status,
        paidByLedger: Boolean(hit),
        matched: hit?.raw,
      });
    }
  }
  return debts;
}

/** 欠账 → 注入文本；无欠账返回 "" */
export function debtText(debts: ForeshadowDebt[], onlyOpen = true): string {
  const open = debts.filter((d) => d.status === "planted" && !(onlyOpen && d.paidByLedger));
  if (open.length === 0) return "";
  const lines = open.slice(0, 12).map((d, i) => {
    const where = d.payoffTitle ? `，拟收：「${d.payoffTitle}」` : "";
    return `${i + 1}. ${clip(d.setup, 80)}（埋于「${d.nodeTitle}」${where}）`;
  });
  const more = open.length > 12 ? `\n（另有 ${open.length - 12} 条未列）` : "";
  return `【伏笔欠账】以下伏笔已埋未收，提案/续写请保持存在感或择机回收：\n${lines.join("\n")}${more}`;
}

/** 台账快照 + 伏笔欠账拼成一段注入文本（共创访谈/下一幕提案共用；无内容返回 ""） */
export function ledgerFacts(records: LedgerRecord[], nodes: OutlineNode[]): string {
  const snap = ledgerSnapshot(records).text;
  const debt = debtText(foreshadowDebt(nodes, records));
  return [snap, debt].filter(Boolean).join("\n\n");
}
