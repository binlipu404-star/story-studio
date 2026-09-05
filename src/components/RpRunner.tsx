// ============================================================
// 站内试跑 RP 面板（M5 → N2 补全）。
//   展示层：回合状态机 + chat() 流式 + 提示词组装交给 flow/rp.ts 管线 v2。
//   N2 新增：优先级预算队列 + 分段 token 预览条；滚动摘要（自动/手动，analyzer）；
//            swipe 多候选重生成（不覆盖旧候选）；任意回合编辑/删除；
//            会话持久化回调（父层落 RPSession，刷新可续）。
//   「带回复盘」把当前回合交给父层，复用既有 复盘 → 改纲/纠偏/采纳 全流程。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chat, chatJSON } from "../ai/client";
import { rollingDigestPrompt, rollingSummaryPrompt } from "../ai/prompts";
import { sanitizeDigest, type DigestLedgerItem } from "../flow/snapshot";
import { planRollingSummary, rpAssemble, turnsTranscript, type RpTurn, type RpSetup } from "../flow/rp";
import { errMsg, isAbort } from "../core/uiUtils";

/** 稳定轮次 id（v3.1-⑥）：消息映射按 id 对齐，删除/截断/并发写不错位 */
function newTurnId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** 超过 keepTurns 之外的旧历史达到该 token 数就自动折叠 */
const ROLL_THRESHOLD = 2500;
const ROLL_KEEP = 8;

const SEC_COLORS: Record<string, string> = {
  roleDirective: "#4caf50",
  extra: "#2e7d32",
  card: "#1565c0",
  authorNote: "#6a1b9a",
  summary: "#00838f",
  ledger: "#8d6e63",
  script: "#37474f",
  loreBefore: "#ef6c00",
  loreAfter: "#aeea00",
  persona: "#78909c",
  pace: "#9ccc65",
  userNameHint: "#bcaaa4",
  bible: "#a1887f",
  examples: "#b0bec5",
  history: "#546e7a",
};

export interface RpRunnerProps {
  /** 预算初值（剧组 config 驱动；组件挂载后用户可临时改） */
  initialBudget?: { budgetTokens: number; reserveTokens: number };
  setup: RpSetup;
  charName: string;
  userName: string;
  /** 本幕标题（展示用） */
  sceneLabel: string;
  /** 开场 assistant 消息（= 试跑包 greeting，已含本场指导） */
  greeting: string;
  disabled?: boolean;
  /** 恢复既有会话（父层从 RPSession 还原；greeting 变化时生效一次） */
  initial?: { turns: RpTurn[]; summary: string } | null;
  /** 每次稳定落定（流式结束/编辑/滑动/折叠）后回调，父层负责落库；
   *  allowClear=用户确认过的清空；allowFold=折叠摘要（守卫放行 + 折叠条存档） */
  onPersist?: (turns: RpTurn[], summary: string, allowClear?: boolean, allowFold?: boolean) => void;
  /** v3.1-⑥ 流式期自动保存钩子（600ms 去抖半句 + pagehide 立即 flush；父层负责写库） */
  onAutosave?: (turns: RpTurn[], summary: string) => void;
  /** v3.1-③ 预算编辑即时回调（父层写剧组 config + prefs；组件本身不再只存本地 state） */
  onBudgetChange?: (budget: number, reserve: number) => void;
  /** 提供则滚动摘要升级为 digest：折叠点同时抽取台账事实并回调（RP 剧场自动台账） */
  onDigest?: (items: DigestLedgerItem[]) => void;
  /** 带这些对话去复盘 */
  onBringBack: (turns: RpTurn[]) => void;
}

export function RpRunner({ setup, charName, userName, sceneLabel, greeting, disabled, initial, initialBudget, onPersist, onAutosave, onBudgetChange, onDigest, onBringBack }: RpRunnerProps) {
  const [turns, setTurns] = useState<RpTurn[]>([{ id: newTurnId(), role: "char", name: charName, content: greeting }]);
  const [summary, setSummary] = useState("");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rollBusy, setRollBusy] = useState(false);
  const [showSys, setShowSys] = useState(false);
  const [budgetT, setBudgetT] = useState(initialBudget?.budgetTokens ?? 8192);
  const [reserveT, setReserveT] = useState(initialBudget?.reserveTokens ?? 768);
  /** 流式中的思维链（仅当前这条 assistant；定稿并入 turn.reasoning） */
  const [liveReasoning, setLiveReasoning] = useState("");
  /** 末条 char 消息的多候选（swipe）：list 全部候选文本，idx 当前显示者 */
  const [alts, setAlts] = useState<{ list: string[]; idx: number } | null>(null);
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const ctrlRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const setupRef = useRef(setup);
  const summaryRef = useRef(summary);
  const initialRef = useRef(initial);
  const onPersistRef = useRef(onPersist);
  const digestRef = useRef(onDigest);
  useEffect(() => {
    setupRef.current = setup;
  }, [setup]);
  useEffect(() => {
    digestRef.current = onDigest;
  }, [onDigest]);
  useEffect(() => {
    summaryRef.current = summary;
  }, [summary]);
  useEffect(() => {
    initialRef.current = initial;
  }, [initial]);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  // 换幕 / 重开：greeting 变则回到开场白；带 initial 则恢复旧对话续写
  // v3.1-⑥ 防护一：正在流式生成时不重挂（否则 greeting 微变会掐掉/覆盖进行中的半句）
  // 防护二（M4）：非流式期 greeting 因场记写正典等微变时，若本地已有比 initial 更新
  // 且尚未回灌的落定（id 集不等），跳过重灌——防旧渲染快照顶回刚做的编辑/删除。
  const prevGreetingRef = useRef(greeting);
  useEffect(() => {
    const greetingChanged = prevGreetingRef.current !== greeting;
    prevGreetingRef.current = greeting;
    if (greetingChanged && ctrlRef.current) {
      // 生成中遇到装配变化：保留现场，只提示——等这条定稿自然落库
      setNote("台面装配有变，已在生成中的回复保留原现场；如需立即切换先点「停」。");
      return;
    }
    const init = initialRef.current;
    const settled = settledRef.current;
    if (greetingChanged && settled) {
      const localIds = settled.turns.map((t) => t.id).filter(Boolean).join(",");
      const initIds = (init?.turns ?? []).map((t) => t.id).filter(Boolean).join(",");
      if (localIds && localIds !== initIds) {
        setNote("台面装配有变；本地对话与库内不一致，已保留本地现场（切组或换台可强制对齐）。");
        return;
      }
    }
    if (init && init.turns.length > 0) {
      setTurns(init.turns.map((t) => (t.id ? t : { ...t, id: newTurnId() })));
      setSummary(init.summary || "");
      setNote("已恢复上一场对话（点「重新开始」可清空重来）。");
    } else {
      setTurns([{ id: newTurnId(), role: "char", name: charName, content: greeting }]);
      setSummary("");
      setNote(null);
    }
    setAlts(null);
    setEditIdx(null);
    setInput("");
    setError(null);
  }, [greeting, charName]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, running]);

  useEffect(() => () => ctrlRef.current?.abort(), []);

  const settledRef = useRef<{ turns: RpTurn[]; summary: string; allowClear: boolean; allowFold: boolean } | null>(null);
  /** 稳定落定后通知父层落库（流式中间态不落，避免高频写）；
   *  allowClear=用户确认过的清空；allowFold=摘要折叠掉旧回合（守卫放行骤减，且父层把被折叠条落底存档） */
  const settle = useCallback((next: RpTurn[], sum: string, allowClear = false, allowFold = false) => {
    settledRef.current = { turns: next, summary: sum, allowClear, allowFold };
    onPersistRef.current?.(next, sum, allowClear, allowFold);
  }, []);
  const budgetChangeRef = useRef(onBudgetChange);
  useEffect(() => {
    budgetChangeRef.current = onBudgetChange;
  }, [onBudgetChange]);

  // ---- v3.1-③ 预算编辑自动记忆（500ms 去抖：连打数字只记最后一次）----
  const budgetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清掉未到点的预算记忆（否则组件没了还会回调一次父层写库）
  useEffect(() => () => { if (budgetTimer.current) clearTimeout(budgetTimer.current); }, []);
  const scheduleBudgetSave = useCallback((b: number, r: number) => {
    if (budgetTimer.current) clearTimeout(budgetTimer.current);
    budgetTimer.current = setTimeout(() => {
      budgetTimer.current = null;
      budgetChangeRef.current?.(b, r);
    }, 500);
  }, []);

  // ---- v3.1-⑥ 流式期自动保存：半句也按 600ms 去抖落盘；页面隐藏/卸载立即 flush ----
  const autosaveRef = useRef(onAutosave);
  useEffect(() => {
    autosaveRef.current = onAutosave;
  }, [onAutosave]);
  const streamLiveRef = useRef<{ turns: RpTurn[]; summary: string } | null>(null);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleAutosave = useCallback(() => {
    if (!autosaveRef.current) return;
    if (autoTimer.current) return; // 已有待触发
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      const live = streamLiveRef.current;
      if (live) autosaveRef.current?.(live.turns, live.summary);
    }, 600);
  }, []);
  const flushAutosave = useCallback(() => {
    if (autoTimer.current) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
    const live = streamLiveRef.current;
    if (live) autosaveRef.current?.(live.turns, live.summary);
  }, []);
  // pagehide/visibilitychange：关页/切走前把生成中的半句抢写落盘
  useEffect(() => {
    const onHide = () => flushAutosave();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flushAutosave(); // 组件卸载：把未落盘的半句交还父层
    };
  }, [flushAutosave]);

  /** 组装预览（token 条/提示词预览实时反映，与实际发送同源同参） */
  const assembly = useMemo(
    () => rpAssemble(setup, turns, { budgetTokens: budgetT, reserveTokens: reserveT, summary }),
    [setup, turns, budgetT, reserveT, summary],
  );

  /** 折叠一段旧历史进滚动摘要（接了 onDigest 则同场抽取台账事实） */
  const roll = useCallback(async (plan: { rollup: RpTurn[]; keep: RpTurn[] }) => {
    setRollBusy(true);
    try {
      const useDigest = Boolean(digestRef.current);
      const transcript = turnsTranscript(plan.rollup);
      const obj = await chatJSON<unknown>(
        useDigest
          ? rollingDigestPrompt(summaryRef.current, transcript)
          : rollingSummaryPrompt(summaryRef.current, transcript),
        { role: "analyzer" },
      );
      const d = sanitizeDigest(obj);
      if (!d.summary) throw new Error("摘要结果为空");
      summaryRef.current = d.summary;
      setSummary(d.summary);
      setTurns(plan.keep);
      setAlts(null);
      // allowFold：旧回合进摘要＝设计内折叠（守卫放行），父层同时把折叠条存档留底
      settle(plan.keep, d.summary, false, true);
      if (useDigest && d.ledger.length > 0) digestRef.current?.(d.ledger);
      setNote(
        `前情已折叠：${plan.rollup.length} 条旧回合 → 摘要 ${d.summary.length} 字` +
          (useDigest ? `；顺手记下台账事实 ${d.ledger.length} 条（写入剧组正典）` : "") +
          "。",
      );
    } catch (e) {
      setError(`折叠前情失败（不影响继续聊）：${errMsg(e)}`);
    } finally {
      setRollBusy(false);
    }
  }, [settle]);

  /** 以给定历史流式生成下一条 assistant 回复（regen=true 时结果作为新候选追加；
   *  preserve=regen 前的完整现场：M2——生成期 autosave 镜像钉在旧现场，
   *  中途刷新/中止旧候选都不从库里消失，定稿才整列表覆盖） */
  const streamAssistant = useCallback(
    async (history: RpTurn[], regen = false, preserve?: RpTurn[]) => {
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setRunning(true);
    setError(null);
    const asm = rpAssemble(setupRef.current, history, {
      budgetTokens: budgetT,
      reserveTokens: reserveT,
      summary: summaryRef.current,
    });
    let acc = "";
    let accReasoning = "";
    setLiveReasoning("");
    const newId = newTurnId(); // 本轮回复的稳定 id：半途落库与定稿同一 id，映射不错位
    setTurns([...history, { id: newId, role: "char", name: charName, content: "" }]);
    if (regen && preserve) {
      streamLiveRef.current = { turns: preserve, summary: summaryRef.current }; // 钉住旧现场（含旧候选）
    } else {
      streamLiveRef.current = { turns: [...history, { id: newId, role: "char", name: charName, content: "" }], summary: summaryRef.current };
      scheduleAutosave();
    }
    try {
      const out = await chat(asm.messages, {
        role: "writer",
        signal: ctrl.signal,
        onDelta: (d) => {
          acc += d;
          if (!(regen && preserve)) {
            streamLiveRef.current = {
              turns: [...history, { id: newId, role: "char", name: charName, content: acc, ...(accReasoning.trim() ? { reasoning: accReasoning } : {}) }],
              summary: summaryRef.current,
            };
          }
          setTurns((prev) => {
            const cp = prev.slice();
            const last = cp[cp.length - 1];
            cp[cp.length - 1] = { ...last, content: last.content + d };
            return cp;
          });
          if (!(regen && preserve)) scheduleAutosave();
        },
        onReasoning: (d) => {
          accReasoning += d;
          setLiveReasoning(accReasoning);
        },
      });
      const content = out.content && out.content.trim() ? out.content : acc;
      const reasoning = out.reasoning?.trim() || accReasoning.trim() || undefined;
      const finalTurns: RpTurn[] = [...history, { id: newId, role: "char", name: charName, content, ...(reasoning ? { reasoning } : {}) }];
      setTurns(finalTurns);
      setLiveReasoning("");
      streamLiveRef.current = { turns: finalTurns, summary: summaryRef.current };
      // swipe 候选：重生成=追加新候选；新回复=候选列表归一为单条
      setAlts((prev) => {
        if (regen && prev && prev.list.length > 0) {
          const list = [...prev.list, content];
          return { list, idx: list.length - 1 };
        }
        return content.trim() ? { list: [content], idx: 0 } : null;
      });
      settle(finalTurns, summaryRef.current);
      // 自动滚动摘要：超阈值就折叠（analyzer 角色），失败不打断 RP
      const plan = planRollingSummary(finalTurns, { thresholdTokens: ROLL_THRESHOLD, keepTurns: ROLL_KEEP });
      if (plan) void roll(plan);
    } catch (e) {
      const aborted = isAbort(e);
      // 收尾：半句保留（人工续写/删除），空占位移除；从本地累积量确定性重建，不读渲染态
      const halfReasoning = accReasoning.trim() || undefined;
      const regenAbort = regen && Boolean(preserve) && (!aborted || !acc.trim());
      const cp: RpTurn[] = regenAbort && preserve
        ? preserve // regen 中止/失败且没有可用的新半句 → 旧候选原地保留
        : acc.trim()
          ? [...history, { id: newId, role: "char", name: charName, content: acc, ...(halfReasoning ? { reasoning: halfReasoning } : {}) }]
          : history;
      streamLiveRef.current = { turns: cp, summary: summaryRef.current };
      setTurns(cp);
      setLiveReasoning("");
      settle(cp, summaryRef.current);
      if (regenAbort && preserve && preserve[preserve.length - 1].role === "char") {
        setAlts((prev) => prev ?? { list: [preserve[preserve.length - 1].content], idx: 0 });
      }
      if (!aborted) setError(errMsg(e));
    } finally {
      setRunning(false);
      ctrlRef.current = null;
    }
  }, [charName, roll, settle, budgetT, reserveT, scheduleAutosave]);

  const send = () => {
    const text = input.trim();
    // rollBusy：折叠摘要进行中禁发——此时 turns 正被 roll 整列表重写，
    // 插入新楼层会基于旧快照发请求，且折叠定稿的整列表覆盖会把新楼层抹掉
    if (!text || running || rollBusy) return;
    setInput("");
    setAlts(null); // 旧候选随发送定稿
    void streamAssistant([...turns, { id: newTurnId(), role: "user", name: userName, content: text }]);
  };

  /** 重生成＝追加一条 swipe 候选，旧候选保留可回滑 */
  const regenerate = () => {
    if (running || rollBusy) return;
    let h = turns.slice();
    if (h.length && h[h.length - 1].role === "char") h.pop();
    if (!h.length) return;
    void streamAssistant(h, true, turns);
  };

  const swipe = (delta: number) => {
    if (!alts || alts.list.length < 2 || running || turns.length === 0 || turns[turns.length - 1].role !== "char") return;
    const idx = (alts.idx + delta + alts.list.length) % alts.list.length;
    setAlts({ ...alts, idx });
    const cp = turns.slice();
    cp[cp.length - 1] = { ...cp[cp.length - 1], content: alts.list[idx] };
    setTurns(cp);
    settle(cp, summaryRef.current);
  };

  const stop = () => ctrlRef.current?.abort();

  const mutateTurns = (next: RpTurn[]) => {
    setTurns(next);
    setAlts(null);
    settle(next, summaryRef.current);
  };

  const delLast = () => {
    if (running || turns.length <= 1) return;
    // v3.1-⑥ 破坏性操作必须经用户确认（与逐条删除同款）
    if (!window.confirm("删除最后一条消息？此操作会从对话历史中移除该条。")) return;
    mutateTurns(turns.slice(0, -1));
  };

  const delTurn = (i: number) => {
    if (running || turns.length <= 1) return;
    // v3.1-⑥ 破坏性操作必须经用户确认
    if (!window.confirm(`删除第 ${i + 1} 条消息？此操作会从对话历史中移除该条。`)) return;
    mutateTurns(turns.filter((_, j) => j !== i));
    setEditIdx(null);
  };

  const saveEdit = (i: number) => {
    const text = editText.trim();
    if (!text) return;
    const cp = turns.slice();
    cp[i] = { ...cp[i], content: text };
    setEditIdx(null);
    mutateTurns(cp);
  };

  const restart = () => {
    // v3.1-⑥ 清空对话=破坏性操作：确认+导出提醒（清空立即落库，不可恢复）
    const floors = turns.filter((t) => t.content.trim()).length;
    if (floors > 1 && !window.confirm(`「重新开始」会立即清空并持久删除当前 ${floors} 条对话记录与滚动摘要，并清空本剧组正典（整组重来；作品级台账不动，刷新也不回来）。建议先「⬇ 导出」留底。\n确定重来？`)) return;
    ctrlRef.current?.abort();
    const fresh = { id: newTurnId(), role: "char" as const, name: charName, content: greeting };
    setTurns([fresh]);
    setSummary("");
    summaryRef.current = "";
    setAlts(null);
    setInput("");
    setError(null);
    setNote(null);
    settle([fresh], "", true);
  };

  const manualRoll = () => {
    const plan = planRollingSummary(turns, { thresholdTokens: 0, keepTurns: ROLL_KEEP });
    if (!plan) {
      setNote("太短了，还没有可折叠的前情。");
      return;
    }
    void roll(plan);
  };

  const bringBack = () => {
    onBringBack(turns.filter((t) => t.content.trim()));
  };

  const userTurns = turns.filter((t) => t.role === "user").length;
  const canBringBack = userTurns >= 1 && !running;
  const canRoll = !running && !rollBusy && turns.length > ROLL_KEEP + 1;

  // token 预览条
  const budgetTotal = Math.max(1, budgetT);

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" }}>
        <span className="muted">
          {sceneLabel}｜你扮演 <b>{userName}</b>，AI 扮演 <b>{charName}</b>（ST 默认标准·本机直连）
        </span>
        <span className="muted">
          世界书命中 {assembly.injected.length} 条
          {assembly.injected.some((m) => m.entry.sticky ? m.entry.sticky > 0 : false) ? "（含 sticky 续命）" : ""}
          {assembly.dropped.length > 0 ? ` · 预算外 ${assembly.dropped.length} 条` : ""}
        </span>
      </div>

      {/* 上下文预算条：分段 token 占用（悬停看段名/处置） */}
      <div style={{ marginTop: 6 }}>
        <div style={{ display: "flex", height: 10, borderRadius: 5, overflow: "hidden", border: "1px solid var(--line)", background: "var(--bg)" }}>
          {assembly.sections
            .filter((s) => s.kept && s.tokens > 0)
            .map((s, i) => (
              <div
                key={`${s.key}-${i}`}
                title={`${s.label} ≈${s.tokens} tok${s.note ? `（${s.note}）` : ""}`}
                style={{ width: `${(s.tokens / budgetTotal) * 100}%`, minWidth: 2, background: SEC_COLORS[s.key] ?? "#999" }}
              />
            ))}
        </div>
        <div className="row" style={{ gap: 10, flexWrap: "wrap", marginTop: 3, fontSize: 11 }}>
          <span className="muted">
            上下文 ≈{assembly.totalTokens} tok / 预算 {budgetT}（预留回复 {reserveT}）
          </span>
          {assembly.droppedTurns > 0 && <span style={{ color: "#e65100", fontSize: 11 }}>已裁旧消息 {assembly.droppedTurns} 条（前情摘要兜底）</span>}
          {assembly.overflow && <span style={{ color: "#b3261e", fontSize: 11 }}>超出预算：保护段已占满，建议压缩前情或换短卡</span>}
          {summary && <span className="muted">前情摘要 {summary.length} 字</span>}
          <label className="muted" style={{ fontSize: 11 }} title="编辑即自动记忆（写进剧组配置与全局默认），无需保存按钮">
            预算
            <input type="number" min={1024} max={200000} step={256} value={budgetT} onChange={(e) => { const b = Math.max(1024, Number(e.target.value) || 8192); setBudgetT(b); scheduleBudgetSave(b, reserveT); }} style={{ width: 80, marginLeft: 4 }} />
          </label>
          <label className="muted" style={{ fontSize: 11 }} title="编辑即自动记忆（写进剧组配置与全局默认），无需保存按钮">
            预留回复
            <input type="number" min={128} max={16384} step={128} value={reserveT} onChange={(e) => { const r = Math.min(16384, Math.max(128, Number(e.target.value) || 768)); setReserveT(r); scheduleBudgetSave(budgetT, r); }} style={{ width: 70, marginLeft: 4 }} />
          </label>
        </div>
        {alts && alts.list.length > 1 && (
          <div className="row" style={{ gap: 6, marginTop: 2 }}>
            <button className="muted" onClick={() => swipe(-1)} disabled={running} style={{ fontSize: 12 }}>←</button>
            <span className="muted" style={{ fontSize: 12 }}>候选 {alts.idx + 1}/{alts.list.length}（重生成不覆盖，可回滑）</span>
            <button className="muted" onClick={() => swipe(1)} disabled={running} style={{ fontSize: 12 }}>→</button>
          </div>
        )}
      </div>

      <div
        ref={scrollRef}
        style={{
          border: "1px solid var(--line)",
          borderRadius: 8,
          background: "var(--bg)",
          padding: 12,
          maxHeight: 460,
          overflowY: "auto",
          marginTop: 8,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        {turns.map((t, i) =>
          editIdx === i ? (
            <div key={i} style={{ alignSelf: t.role === "user" ? "flex-end" : "flex-start", width: "86%" }}>
              <textarea rows={4} value={editText} onChange={(e) => setEditText(e.target.value)} style={{ width: "100%" }} />
              <div className="row" style={{ marginTop: 4 }}>
                <button className="primary" onClick={() => saveEdit(i)}>保存</button>
                <button onClick={() => setEditIdx(null)}>取消</button>
                {t.role === "user" && <span className="muted" style={{ fontSize: 11 }}>改用户台词只影响其后的生成</span>}
              </div>
            </div>
          ) : (
            <TurnBubble
              key={i}
              turn={t}
              userName={userName}
              charName={charName}
              streaming={running && i === turns.length - 1 && t.role === "char"}
              liveReasoning={running && i === turns.length - 1 && t.role === "char" ? liveReasoning : undefined}
              actions={
                running ? undefined : (
                  <span style={{ fontSize: 11 }}>
                    <button className="muted" style={{ fontSize: 11, padding: "0 4px" }} onClick={() => { setEditIdx(i); setEditText(t.content); }} title="编辑这条">✎</button>
                    <button className="muted" style={{ fontSize: 11, padding: "0 4px", marginLeft: 2 }} onClick={() => delTurn(i)} title="删除这条" disabled={turns.length <= 1}>✕</button>
                  </span>
                )
              }
            />
          ),
        )}
      </div>

      {error && <p style={{ color: "#b3261e", fontSize: 13 }}>{error}</p>}
      {note && !error && <p className="muted" style={{ fontSize: 12 }}>{note}</p>}

      <label className="field" style={{ marginTop: 10 }}>
        <span>{`你的行动 / 台词（你扮演 ${userName}）— Enter 发送，Shift+Enter 换行`}</span>
        <textarea
          rows={3}
          value={input}
          disabled={disabled || running || rollBusy}
          placeholder="描述你要说的话或动作…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          style={{ width: "100%" }}
        />
      </label>

      <div className="row" style={{ marginTop: 8, flexWrap: "wrap" }}>
        <button className="primary" onClick={send} disabled={disabled || running || rollBusy || !input.trim()}>
          {running ? "生成中…" : rollBusy ? "折叠前情中…" : "发送"}
        </button>
        <button onClick={stop} disabled={!running}>停止</button>
        <button onClick={regenerate} disabled={disabled || running || rollBusy || !turns.some((t) => t.role === "user")}>
          重生成（换候选）
        </button>
        <button onClick={delLast} disabled={disabled || running || turns.length <= 1}>删除末条</button>
        <button onClick={manualRoll} disabled={disabled || !canRoll} title="把较早的对话折叠进前情摘要（省 token）">
          {rollBusy ? "折叠中…" : "🗜 压缩前情"}
        </button>
        <button onClick={restart} disabled={disabled || running}>重新开始</button>
        <button onClick={() => setShowSys((v) => !v)}>
          {showSys ? "隐藏提示词" : "查看提示词"}
        </button>
        <button className="primary" onClick={bringBack} disabled={disabled || !canBringBack}>
          🧭 带这些对话去复盘
        </button>
      </div>
      {!canBringBack && !running && (
        <p className="muted" style={{ fontSize: 12 }}>至少聊一轮（你一发言）即可「带回复盘」。</p>
      )}

      {showSys && (
        <details open style={{ marginTop: 8 }}>
          <summary className="muted">本轮实际发送内容（管线 v2 组装结果，含分段清单）</summary>
          <div style={{ margin: "6px 0", fontSize: 12 }}>
            {assembly.sections.map((s, i) => (
              <div key={`${s.key}-${i}`} className={s.kept ? "" : "muted"} style={{ textDecoration: s.kept ? undefined : "line-through" }}>
                <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: SEC_COLORS[s.key] ?? "#999", marginRight: 6, opacity: s.kept ? 1 : 0.35 }} />
                {s.label} ≈{s.tokens} tok{s.note ? `（${s.note}）` : ""}
              </div>
            ))}
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "var(--bg)",
              padding: 12,
              borderRadius: 8,
              maxHeight: 320,
              overflowY: "auto",
              fontSize: 12,
            }}
          >
            {assembly.messages.map((m, i) => `── ${m.role} ──\n${m.content}`).join("\n\n")}
          </pre>
        </details>
      )}
    </div>
  );
}

function TurnBubble({
  turn,
  userName,
  charName,
  streaming,
  liveReasoning,
  actions,
}: {
  turn: RpTurn;
  userName: string;
  charName: string;
  streaming: boolean;
  liveReasoning?: string; // 流式进行中的思维链（定稿后并入 turn.reasoning）
  actions?: React.ReactNode;
}) {
  const isUser = turn.role === "user";
  const reasoning = turn.reasoning ?? "";
  const showReasoning = !isUser && (reasoning.length > 0 || (streaming && !!liveReasoning));
  return (
    <div style={{ alignSelf: isUser ? "flex-end" : "flex-start", maxWidth: "86%" }}>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2, textAlign: isUser ? "right" : "left" }}>
        {isUser ? userName : turn.role === "system" ? "系统" : charName}
        {actions && (
          <span style={{ marginLeft: isUser ? 0 : 6, marginRight: isUser ? 6 : 0, float: isUser ? "left" : "right" }}>{actions}</span>
        )}
      </div>
      {/* v3.1-⑦ 思维链：默认折叠，点开才看（含场记 tools 调用活动 notes） */}
      {showReasoning && (
        <details style={{ marginBottom: 4 }}>
          <summary className="muted" style={{ fontSize: 11, cursor: "pointer" }}>
            🧠 思考{streaming && !reasoning ? "中…" : ""}
            {(turn.notes?.length ?? 0) > 0 ? ` · 场记 ${turn.notes!.length} 条` : ""}
          </summary>
          {(reasoning || liveReasoning) && (
            <pre
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                fontSize: 11,
                color: "var(--muted)",
                background: "var(--bg)",
                border: "1px dashed var(--line)",
                borderRadius: 8,
                padding: "6px 8px",
                margin: "4px 0 0",
                maxHeight: 200,
                overflowY: "auto",
              }}
            >
              {reasoning || liveReasoning}
              {streaming && !reasoning && liveReasoning ? "▍" : ""}
            </pre>
          )}
          {(turn.notes?.length ?? 0) > 0 && (
            <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
              {turn.notes!.map((n, k) => (
                <div key={k}>· {n}</div>
              ))}
            </div>
          )}
        </details>
      )}
      <div
        style={{
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          padding: "8px 12px",
          borderRadius: 10,
          border: "1px solid var(--line)",
          background: isUser ? "var(--accent)" : "var(--panel)",
          color: isUser ? "#fff" : undefined,
          minHeight: 20,
        }}
      >
        {turn.content || (streaming ? "…" : "（空）")}
        {streaming && turn.content ? "▍" : ""}
      </div>
    </div>
  );
}
