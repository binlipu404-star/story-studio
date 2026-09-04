// ============================================================
// story-studio M4 — ST 过渡试跑闭环页
// 流程：选幕 → ①buildTrialPack 生成试跑包（card/greeting/note/readme[/worldbook]，
//        逐文件下载/复制，落盘位置由用户定）→ 去 SillyTavern 演这一幕 →
//      ②导入 ST 导出的 .jsonl/.json → parseStChat → toTranscript →
//        sessionRecapPrompt + chatJSON(analyzer) 得到 RecapResult →
//      动作四件套：保存会话 / 应用节拍标记 / 反向修纲草案 / 采纳台账提案。
// 页面只经 store/repos 门面读写数据；类型只 import type 自 core/types。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import type {
  Character,
  LedgerRecord,
  LedgerType,
  LoreEntry,
  OutlineNode,
  Persona,
  Project,
  RPMessage,
  RPSession,
} from "../core/types";
import * as repos from "../store/repos";
import {
  applyRecapToNode,
  canTransition,
  lineageOf,
  reweaveBeats,
  sceneSequence,
  type RecapResult,
} from "../flow/outline";
import { buildTrialPack, synthesizeNarratorCard, type TrialPack } from "../flow/trialpack";
import type { RpSetup, RpTurn } from "../flow/rp";
import { composeAuthorNote } from "../flow/rp";
import { ledgerFacts } from "../flow/snapshot";
import { RpRunner } from "../components/RpRunner";
import { exportCardV2 } from "../st/card";
import { exportLorebookGlobal } from "../st/lorebook";
import { parseStChat, toTranscript, type ParsedChatMessage } from "../st/chatlog";
import { personaPromptBlock, sessionRecapPrompt } from "../ai/prompts";
import { chatJSON } from "../ai/client";
import { loadAppConfig } from "../ai/config";

// ---------- 常量与展示辅助 ----------

const LEDGER_TYPES: LedgerType[] = ["event", "item", "relation", "foreshadow", "worldstate"];
const LEDGER_TYPE_NAMES: Record<LedgerType, string> = {
  event: "事件",
  item: "道具",
  relation: "关系",
  foreshadow: "伏笔",
  worldstate: "世界",
};
const BEAT_LABEL: Record<string, string> = { hit: "命中", partial: "部分", missed: "未命中" };
const BEAT_COLOR: Record<string, string> = {
  hit: "#1a7f37", // 绿
  partial: "#b8860b", // 黄
  missed: "#c0392b", // 红
};
const ERROR_COLOR = "#c0392b";
const WARN_YELLOW = "#b8860b";
/** 主演下拉的特殊取值：不使用角色卡（原创/自由试跑，由 buildTrialPack 合成旁白卡） */
const NONE_CARD_ID = "__none__";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 台账提案 type 徽标文案；非法值兜底显示 event（落库同样兜底） */
function typeBadge(type: string | undefined): string {
  const key = (type ?? "").trim();
  return (LEDGER_TYPE_NAMES as Record<string, string>)[key] ?? "事件";
}

/** 下载一个文本文件：Blob + 临时 <a download>.click()，用完即 revoke */
function downloadText(name: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 复制：优先 navigator.clipboard；失败/不可用降级隐藏 textarea select + execCommand */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 非安全上下文/权限拒绝：走降级 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// ============================================================
// 主组件
// ============================================================
export function TrialPage({ projectId }: { projectId: string }) {
  // ---- 数据底 ----
  const [project, setProject] = useState<Project | undefined>(undefined);
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [sessions, setSessions] = useState<RPSession[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  /** 已确认台账（正典事实）：站内 RP 的组装管线注入快照+伏笔欠账 */
  const [ledgerRecs, setLedgerRecs] = useState<LedgerRecord[]>([]);
  /** 站内 RP 的工作会话：每幕一条 testing，随聊天自动落库（刷新可续写） */
  const [rpSession, setRpSession] = useState<RPSession | null>(null);
  const rpSessionRef = useRef<RPSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- 选择 ----
  const [sceneId, setSceneId] = useState("");
  const [leadCharId, setLeadCharId] = useState("");
  /** 玩家画像（全局 Persona）："" = 不注入画像，沿用全局设置里的用户名 */
  const [personaId, setPersonaId] = useState("");
  /** 「默认画像」只在首次载入后套用一次，避免覆盖用户手动选的「不设画像」 */
  const personaDefaultApplied = useRef(false);

  // ---- 步骤1：试跑包 ----
  const [pack, setPack] = useState<TrialPack | null>(null);
  /** 生成当时的主演/画像标签：包预览用，避免事后切换选择导致显示与实际包不符 */
  const [packLeadLabel, setPackLeadLabel] = useState("");
  const [packError, setPackError] = useState<string | null>(null);
  const [copyMsg, setCopyMsg] = useState<string | null>(null);
  /** 生成试跑包的同时快照的站内 RP 装配（存在 = 可以不开 ST 直接聊） */
  const [rpSetup, setRpSetup] = useState<RpSetup | null>(null);

  // ---- 步骤2：导回与分析 ----
  const [parsed, setParsed] = useState<ParsedChatMessage[] | null>(null);
  const [recap, setRecap] = useState<RecapResult | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]); // 与 recap.proposals 对齐
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  // ---- 动作反馈 ----
  const [savedSession, setSavedSession] = useState<RPSession | null>(null);
  const [beatMsg, setBeatMsg] = useState<string | null>(null);
  const [reweaveText, setReweaveText] = useState("");
  const [proposalMsg, setProposalMsg] = useState<string | null>(null);
  /** N3：注入站内 RP 的纠偏指令列表（最新在后，最多保留 3 条） */
  const [corrections, setCorrections] = useState<string[]>([]);
  const [correctionText, setCorrectionText] = useState("");
  /** 应用节拍标记后：本幕是否已全拍完成（可锁定） */
  const [playedDone, setPlayedDone] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [proj, nd, ch, lore, ss, ps, led] = await Promise.all([
        repos.getProject(projectId),
        repos.listNodes(projectId),
        repos.listCharacters(projectId),
        repos.listLoreEntries(projectId),
        repos.listSessions(projectId),
        repos.listPersonas(),
        repos.listLedger(projectId, "confirmed"),
      ]);
      setProject(proj);
      setNodes(nd);
      setCharacters(ch);
      setLoreEntries(lore);
      setSessions(ss);
      setPersonas(ps);
      setLedgerRecs(led);
      // 载入后一次性：有默认画像且当前未选 → 套用（此后不再覆盖用户的选择，含手选的「不设画像」）
      if (!personaDefaultApplied.current) {
        personaDefaultApplied.current = true;
        const def = ps.find((p) => p.isDefault);
        if (def) setPersonaId((cur) => (cur === "" ? def.id : cur));
      }
      setLoadError(null);
    } catch (e) {
      setLoadError(errMsg(e));
    } finally {
      setLoaded(true);
    }
  }, [projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scenes = useMemo(() => sceneSequence(nodes), [nodes]);
  const scene = scenes.find((s) => s.id === sceneId) ?? scenes[0] ?? null;
  /** 无卡模式：不导出主演，交给 buildTrialPack 合成旁白卡（原创/自由试跑） */
  const noCardMode = leadCharId === NONE_CARD_ID;
  const leadChar = noCardMode
    ? null
    : characters.find((c) => c.id === leadCharId) ?? characters[0] ?? null;
  // 受控 select 的展示值：无卡模式下 leadChar 为 null，仍要回填 __none__ 这一项
  const leadSelectValue = noCardMode ? NONE_CARD_ID : leadChar?.id ?? "";
  const persona = personas.find((p) => p.id === personaId) ?? undefined;
  const beatCount = scene?.beats.length ?? 0;
  // 同一节点最近一次会话（listSessions 已按 updatedAt 倒序）的滚动摘要 = 前情实际走向
  const prevSession = scene ? sessions.find((s) => (s.nodeId ?? null) === scene.id) : undefined;
  const prevSummary = prevSession?.rollingSummary?.trim() || undefined;

  const patchNode = useCallback((updated: OutlineNode | undefined) => {
    if (updated) setNodes((ns) => ns.map((n) => (n.id === updated.id ? updated : n)));
  }, []);

  const resetDownstream = () => {
    setPack(null);
    setPackLeadLabel("");
    setPackError(null);
    setCopyMsg(null);
    setRpSetup(null);
    setParsed(null);
    setRecap(null);
    setChecked([]);
    setImportError(null);
    setSavedSession(null);
    setBeatMsg(null);
    setReweaveText("");
    setProposalMsg(null);
    setCorrections([]);
    setCorrectionText("");
    setPlayedDone(false);
    setRpSession(null);
    rpSessionRef.current = null;
  };

  const selectScene = (id: string) => {
    setSceneId(id);
    resetDownstream();
  };

  // ---------- 步骤1：生成试跑包 ----------

  const generatePack = () => {
    setPackError(null);
    setPack(null);
    setPackLeadLabel("");
    setCopyMsg(null);
    setCorrections([]);
    setCorrectionText("");
    setPlayedDone(false);
    if (!scene) {
      setPackError("当前作品还没有可试跑的「幕」，请先在大纲工作台创建。");
      return;
    }
    if (!noCardMode && !leadChar) {
      setPackError("人物库为空：请先在人物卡页导入/创建至少一个角色作为主演。");
      return;
    }
    try {
      const byId = new Map(characters.map((c) => [c.id, c] as const));
      const castNames = leadChar
        ? Array.from(
            new Set([...scene.cast.map((id) => byId.get(id)?.name ?? ""), leadChar.name].filter(Boolean)),
          )
        : // 无主演：只取本幕出场人物，可为空
          Array.from(new Set(scene.cast.map((id) => byId.get(id)?.name ?? "").filter(Boolean)));
      const chain = lineageOf(nodes, scene.id);
      const chapter = chain.length >= 2 ? chain[chain.length - 2] : undefined;
      const enabled = loreEntries.filter((e) => e.enabled);
      const loreBlock = enabled
        .filter((e) => e.constant)
        .map((e) => e.content)
        .filter((c) => c.trim())
        .join("\n");
      // 世界观一两句：从构思档案里挑 label 含「世界/设定」的字段（旁白卡 description 用）
      const worldview =
        (project?.bible.fields ?? [])
          .filter((f) => /世界|设定/.test(f.label))
          .map((f) => f.value.trim())
          .filter(Boolean)
          .join("\n") || undefined;
      const uname = persona?.name?.trim() || loadAppConfig().userName;
      const built = buildTrialPack({
        packName: scene.title,
        scene,
        chapter,
        castNames,
        userName: uname,
        userPersona: persona ? personaPromptBlock(persona) : undefined,
        prevSummary,
        loreBlock: loreBlock || undefined,
        cardJson: leadChar ? exportCardV2(leadChar) : undefined,
        worldview,
        lorebookJson: enabled.length > 0 ? exportLorebookGlobal(enabled) : undefined,
      });
      // 同步快照站内 RP 装配：与导出包同源（主演卡 / 合成旁白卡），保证两条路径一致
      let rp: RpSetup;
      if (leadChar) {
        rp = {
          charName: leadChar.name || "角色",
          userName: uname,
          description: [
            leadChar.profile.appearance.trim() ? `外貌：${leadChar.profile.appearance.trim()}` : "",
            leadChar.profile.background,
          ]
            .filter(Boolean)
            .join("\n"),
          personality: leadChar.profile.personality || undefined,
          scenario: leadChar.scenario || undefined,
          exampleDialogue: leadChar.profile.exampleLines.join("\n") || undefined,
          personaBlock: persona ? personaPromptBlock(persona) : undefined,
          authorNote: built.authorNote,
          loreEntries: enabled,
          loreSettings: project?.lorebook ?? { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true },
        };
      } else {
        const narrator = synthesizeNarratorCard({ scene, chapter, castNames, worldview }, built.greeting);
        const nd = (narrator as { data?: Record<string, unknown> }).data ?? {};
        rp = {
          charName: typeof nd.name === "string" && nd.name ? nd.name : "旁白",
          userName: uname,
          description: typeof nd.description === "string" ? nd.description : "",
          scenario: typeof nd.scenario === "string" ? nd.scenario || undefined : undefined,
          personaBlock: persona ? personaPromptBlock(persona) : undefined,
          authorNote: built.authorNote,
          loreEntries: enabled,
          loreSettings: project?.lorebook ?? { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true },
        };
      }
      setRpSetup({
        ...rp,
        ledgerBlock: ledgerFacts(ledgerRecs, nodes) || undefined,
      });
      // 本幕已有 testing 会话 → 挂回工作会话（RpRunner 恢复旧对话续写）
      const prior =
        sessions.find((s) => (s.nodeId ?? null) === scene.id && s.status === "testing" && s.messages.length > 0) ?? null;
      rpSessionRef.current = prior;
      setRpSession(prior);
      setPackLeadLabel(
        `${leadChar ? `主演：${leadChar.name || "（无名）"}` : "主演：旁白卡（无卡模式）"}` +
          `｜玩家画像：${persona ? persona.name || "（未命名）" : "（未设）"}`,
      );
      setPack(built);
    } catch (e) {
      setPackError(errMsg(e));
    }
  };

  const onCopyFile = async (name: string, content: string) => {
    const ok = await copyToClipboard(content);
    setCopyMsg(ok ? `已复制 ${name}。` : `${name} 复制失败（剪贴板不可用），请改用「下载」。`);
  };

  // ---------- 步骤2/3 共用：对一份消息序列跑 AI 复盘 ----------

  const runRecap = async (target: OutlineNode, msgs: ParsedChatMessage[]) => {
    setParsed(msgs);
    setRecap(null);
    setChecked([]);
    setBusy(true);
    try {
      const r = await chatJSON<RecapResult>(sessionRecapPrompt(toTranscript(msgs), target), {
        role: "analyzer",
      });
      setRecap(r ?? {});
      setChecked(Array.isArray(r?.proposals) ? r.proposals.map(() => false) : []);
    } catch (err) {
      setImportError(`导回分析失败：${errMsg(err)}`);
    } finally {
      setBusy(false);
    }
  };

  /** 站内试跑「带回复盘」：RpRunner 回合 → ParsedChatMessage，走同一条复盘流水线 */
  const onBringBackFromRp = (rpTurns: RpTurn[]) => {
    if (!scene) {
      setPackError("请先选择要试跑的幕。");
      return;
    }
    const msgs: ParsedChatMessage[] = rpTurns.map((t) => ({
      name: t.name,
      content: t.content,
      isUser: t.role === "user",
      role: t.role,
    }));
    if (msgs.length === 0) return;
    setImportError(null);
    void runRecap(scene, msgs);
  };

  /** 站内 RP 稳定落定 → 自动落库本幕工作会话（testing；刷新/换页后可续写） */
  const onRpPersist = async (rturns: RpTurn[], sum: string) => {
    if (!scene) return;
    try {
      const base = rpSessionRef.current;
      const now = Date.now();
      const createdAt = base?.createdAt ?? now;
      const messages: RPMessage[] = rturns.map((t, i) => ({
        id: base?.messages[i]?.id ?? `${createdAt}-${i}`,
        role: t.role,
        name: t.name,
        content: t.content,
        createdAt: createdAt + i,
      }));
      const cast = [...scene.cast];
      if (leadChar && !cast.includes(leadChar.id)) cast.push(leadChar.id);
      const row: RPSession = {
        id: base?.id ?? repos.uid(),
        projectId,
        nodeId: scene.id,
        cast,
        userName: rpSetup?.userName ?? persona?.name?.trim() ?? loadAppConfig().userName,
        messages,
        ...(sum ? { rollingSummary: sum } : {}),
        status: base?.status === "canon" ? "canon" : "testing",
        createdAt,
        updatedAt: now,
      };
      const saved = await repos.saveSession(row);
      rpSessionRef.current = saved;
      setRpSession(saved);
      setSessions((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
    } catch {
      // 静默：持久化失败不打断聊天（本回合仍在屏上）
    }
  };

  /** 本幕全部落库会话（listSessions 已按 updatedAt 倒序） */
  const sceneSessions = useMemo(() => (scene ? sessions.filter((s) => (s.nodeId ?? null) === scene.id) : []), [sessions, scene]);

  const markSessionStatus = async (s: RPSession, status: "canon" | "testing" | "abandoned") => {
    try {
      const saved = await repos.saveSession({ ...s, status });
      setSessions((prev) => [saved, ...prev.filter((x) => x.id !== saved.id)]);
      if (rpSessionRef.current?.id === s.id) {
        rpSessionRef.current = saved;
        setRpSession(saved);
      }
    } catch (e) {
      setImportError(`更新会话状态失败：${errMsg(e)}`);
    }
  };

  /** RpRunner 重挂载令牌：只在显式「续写」/换场时递增（自动落库不打断聊天） */
  const [rpMountKey, setRpMountKey] = useState(0);

  /** 传给 RpRunner 的恢复态（仅当本幕有已落库对话时） */
  const rpInitial =
    rpSession && rpSession.messages.length > 0
      ? {
          turns: rpSession.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
          summary: rpSession.rollingSummary ?? "",
        }
      : null;

  // ---------- 步骤3：导入试跑记录 → AI 复盘 ----------

  const onChatFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许连续导入同一文件
    if (!file) return;
    setImportError(null);
    setRecap(null);
    setChecked([]);
    setSavedSession(null);
    setBeatMsg(null);
    setProposalMsg(null);
    setReweaveText("");
    if (!scene) {
      setImportError("请先选择要回写的幕。");
      setParsed(null);
      return;
    }
    const target = scene; // 定住本次分析目标幕
    let msgs: ParsedChatMessage[] = [];
    try {
      msgs = parseStChat(await file.text(), file.name);
    } catch (err) {
      setParsed(null);
      setImportError(`解析聊天记录失败：${errMsg(err)}`);
      return;
    }
    if (msgs.length === 0) {
      setParsed(null);
      setImportError("该文件未解析出任何有效消息（支持 ST .jsonl 逐行 / {messages:[…]} / 顶层数组）。");
      return;
    }
    await runRecap(target, msgs);
  };

  // ---------- 动作：保存会话 ----------

  const onSaveSession = async () => {
    if (!scene || !parsed) return;
    try {
      const now = Date.now();
      const messages: RPMessage[] = parsed.map((m, i) => ({
        id: repos.uid(),
        role: m.role,
        name: m.name,
        content: m.content,
        createdAt: now + i, // 单调递增保消息顺序
      }));
      const cast = [...scene.cast];
      if (leadChar && !cast.includes(leadChar.id)) cast.push(leadChar.id);
      const session: RPSession = {
        id: rpSessionRef.current?.id ?? repos.uid(), // 站内聊过 → 复盘保存更新同一条工作会话
        projectId,
        nodeId: scene.id,
        cast,
        userName: persona?.name?.trim() || loadAppConfig().userName, // 与 greeting 注入 {{user}} 的名字保持一致
        messages,
        rollingSummary: recap?.summary,
        status: "testing",
        createdAt: now,
        updatedAt: now,
      };
      const saved = await repos.saveSession(session);
      setSavedSession(saved);
      rpSessionRef.current = saved;
      setRpSession(saved);
      setSessions((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
    } catch (e) {
      setImportError(`保存会话失败：${errMsg(e)}`);
    }
  };

  // ---------- 动作：应用节拍标记 ----------

  const onApplyBeats = async () => {
    if (!scene || !recap) return;
    try {
      const app = applyRecapToNode(scene, recap);
      const doneById = new Map(app.beatUpdates.map((u) => [u.id, u.done] as const));
      const beats = scene.beats.map((b) => (doneById.has(b.id) ? { ...b, done: doneById.get(b.id) } : b));
      patchNode(await repos.updateNode(scene.id, { beats }));
      let statusNote = "节点状态未变";
      if (canTransition(scene.status, "tested")) {
        patchNode(await repos.setNodeStatus(scene.id, "tested"));
        statusNote = "节点状态已置「已试跑」";
      }
      const allDone = beats.length > 0 && beats.every((b) => b.done);
      setPlayedDone(allDone);
      setBeatMsg(
        `节拍标记已回写（${app.beatUpdates.length}/${beatCount} 拍有判定，命中率 ${
          app.hitRate === null ? "—" : `${Math.round(app.hitRate * 100)}%`
        }；重大偏差 ${app.majorCount} 条），${statusNote}${allDone ? "；所有节拍已完成，可标记已演毕" : ""}。`,
      );
    } catch (e) {
      setImportError(`应用节拍标记失败：${errMsg(e)}`);
    }
  };

  // ---------- 动作：反向修纲草案 ----------

  const onMakeReweaveDraft = () => {
    if (!scene || !recap) return;
    setReweaveText(reweaveBeats(scene, recap).map((b, i) => `${i + 1}. ${b.text}`).join("\n"));
  };

  const onApplyReweave = async () => {
    if (!scene || !recap) return;
    try {
      const beats = reweaveBeats(scene, recap);
      patchNode(await repos.updateNode(scene.id, { beats }));
      setBeatMsg(
        `反向修纲草案已落库（共 ${beats.length} 拍）。注意：落的是系统草案原文，框内手改不生效（未实现），请去大纲工作台精修。站内 RP 若正开着：重新点「生成试跑包」即可让新细纲生效（旧对话会自动恢复接写）。`,
      );
    } catch (e) {
      setImportError(`反向修纲落库失败：${errMsg(e)}`);
    }
  };

  // ---------- 动作：注入纠偏继续站内演（N3 中间路） ----------

  const injectCorrection = () => {
    const text = correctionText.trim();
    if (!text) return;
    if (!pack || !rpSetup) {
      setProposalMsg("当前没有站内 RP 会话可注入：先生成试跑包（导回 ST 记录走不了这条路，请把纠偏手工贴进 ST 的 author's note）。");
      return;
    }
    const next = [...corrections, text].slice(-3);
    setCorrections(next);
    setRpSetup({ ...rpSetup, authorNote: composeAuthorNote(pack.authorNote, next) });
    setCorrectionText("");
    setProposalMsg(`纠偏已注入（在场 ${next.length} 条，超三条自动退旧）：下一句回复起生效，对话上下文完整保留。`);
  };

  const lockScene = async () => {
    if (!scene) return;
    try {
      patchNode(await repos.setNodeStatus(scene.id, "locked"));
      setBeatMsg("本幕已标记「已锁定」：大纲改动会被工作台提示。剧情世界书导出时它按已演退场（以节拍完成为准）。");
      setPlayedDone(false);
    } catch (e) {
      setImportError(`锁定失败：${errMsg(e)}`);
    }
  };

  // ---------- 动作：采纳台账提案 ----------

  const validChecked = (recap?.proposals ?? []).filter(
    (p, i) => checked[i] && (p?.content ?? "").trim() !== "",
  ).length;

  const onAdoptProposals = async () => {
    if (!recap) return;
    const prov =
      savedSession && savedSession.messages.length > 0
        ? {
            sessionId: savedSession.id,
            msgId: savedSession.messages[savedSession.messages.length - 1].id,
          }
        : undefined;
    const rows: LedgerRecord[] = [];
    (recap.proposals ?? []).forEach((p, i) => {
      if (!checked[i]) return;
      const content = (p?.content ?? "").trim();
      if (!content) return;
      const rawType = (p?.type ?? "").trim();
      const type: LedgerType = (LEDGER_TYPES as string[]).includes(rawType)
        ? (rawType as LedgerType)
        : "event";
      rows.push({
        id: repos.uid(),
        projectId,
        type,
        content,
        actors: Array.isArray(p?.actors) ? p.actors : [],
        ...(prov ? { provenance: prov } : {}),
        status: "proposed",
        createdAt: Date.now(),
      });
    });
    if (rows.length === 0) {
      setProposalMsg("没有可采纳的提案（请勾选内容非空的条目）。");
      return;
    }
    try {
      await repos.addProposals(rows);
      setProposalMsg(`已采纳 ${rows.length} 条 → 台账提案区（status=proposed，待台账页裁决）。`);
    } catch (e) {
      setImportError(`采纳提案失败：${errMsg(e)}`);
    }
  };

  // ============================================================
  // 渲染
  // ============================================================
  return (
    <div>
      {loadError && <p style={{ color: ERROR_COLOR }}>数据加载失败：{loadError}</p>}

      {/* ---------- 顶部：选幕 ---------- */}
      <section className="panel">
        <div className="row">
          <label className="field" style={{ flex: 1 }}>
            <span>选择要试跑的幕（前序/上演顺序，全路径 卷/章/幕）— {project?.title ?? "…"}</span>
            <select
              value={scene?.id ?? ""}
              onChange={(e) => selectScene(e.target.value)}
              disabled={scenes.length === 0}
            >
              {scenes.length === 0 && <option value="">{loaded ? "（暂无幕，请先在大纲工作台创建）" : "（加载中…）"}</option>}
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {lineageOf(nodes, s.id)
                    .map((n) => n.title || "（未命名）")
                    .join(" / ")}
                </option>
              ))}
            </select>
          </label>
        </div>
        {scene && (
          <p className="muted">
            戏剧目标：{scene.intent || "（未填）"}｜节拍 {beatCount} 拍｜
            {prevSummary
              ? `前情实际走向（同幕最近会话滚动摘要）：${prevSummary}`
              : "本幕暂无历史会话（prevSummary 为空）"}
          </p>
        )}
      </section>

      {/* ---------- 步骤1：导出试跑包 ---------- */}
      <section className="panel">
        <h3>① 生成并导出试跑包</h3>
        <div className="row">
          <label className="field">
            <span>主演角色（导出为 chara_card_v2）</span>
            <select value={leadSelectValue} onChange={(e) => setLeadCharId(e.target.value)}>
              <option value={NONE_CARD_ID}>🎭 不使用角色卡（原创/自由试跑，自动生成旁白卡）</option>
              {characters.length === 0 && <option value="">{loaded ? "（人物库为空）" : "（加载中…）"}</option>}
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || "（无名）"}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={generatePack} disabled={!scene || (!noCardMode && !leadChar)}>
            生成试跑包
          </button>
        </div>
        <div className="row">
          <label className="field">
            <span>{"玩家画像（全局 Persona，注入 {{user}}；不设则用全局设置里的用户名）"}</span>
            <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="">（不设画像 · 用全局设置里的用户名）</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {`${p.name || "（未命名）"}${p.isDefault ? " ⭐" : ""}`}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          启用（enabled）的世界书词条会作为「导入卡片附带世界书」打包：有则随包出 worldbook.json
          （ST 全局 world info 形态，在世界书面板导入）；蓝灯（constant）词条同时注入 greeting 的「世界设定摘录」。
          greeting 贴到角色卡开场白，note.txt 贴 author&apos;s note（note-depth 1），照 readme.md 操作即可开演。
        </p>
        {packError && <p style={{ color: ERROR_COLOR }}>{packError}</p>}
        {pack && (
          <div>
            {packLeadLabel && (
              <p className="muted" style={{ marginTop: 8 }}>
                {packLeadLabel}
              </p>
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <strong>
                <code>{pack.folder}/</code>
              </strong>
              <span style={{ color: WARN_YELLOW }}>
                建议包名——最终放到哪个目录/压成 zip 由你定，ST 里按 readme.md 导入即可。
              </span>
            </div>
            {pack.files.map((f) => (
              <div className="row" key={f.name} style={{ marginTop: 4 }}>
                <code style={{ minWidth: 140 }}>{f.name}</code>
                <span className="muted">{f.content.length.toLocaleString()} 字符</span>
                <button onClick={() => downloadText(f.name, f.content)}>下载</button>
                <button onClick={() => void onCopyFile(f.name, f.content)}>复制</button>
              </div>
            ))}

            {copyMsg && <p className="muted">{copyMsg}</p>}
          </div>
        )}
      </section>

      {/* ---------- 步骤2：站内试跑（无需 ST） ---------- */}
      {pack && rpSetup && (
        <section className="panel">
          <h3>② 站内试跑（推荐：不必导出 ST，直接开聊）</h3>
          <RpRunner
            key={`${scene?.id ?? "x"}-${rpMountKey}`}
            setup={rpSetup}
            charName={rpSetup.charName}
            userName={rpSetup.userName}
            sceneLabel={pack.folder}
            greeting={pack.greeting}
            initial={rpInitial}
            onPersist={(t, s) => void onRpPersist(t, s)}
            onBringBack={onBringBackFromRp}
          />
        </section>
      )}

      {/* ---------- 本幕会话管理（N2：持久化/回放/状态） ---------- */}
      {scene && (
        <section className="panel">
          <h3>本幕会话（{sceneSessions.length}）</h3>
          <p className="muted" style={{ fontSize: 12 }}>
            站内试跑每稳定落定一条就自动落库为本幕工作会话（status=testing），刷新/换页后可「续写」。
            复盘保存会更新同一条。标记「正典」后不再被默认续写选中。
          </p>
          {sceneSessions.length === 0 && <p className="muted">尚无落库会话。</p>}
          {sceneSessions.map((s) => (
            <div key={s.id} style={{ borderTop: "1px solid var(--line)", padding: "6px 0" }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 12,
                    padding: "1px 8px",
                    borderRadius: 10,
                    border: "1px solid var(--line)",
                    background: s.status === "canon" ? "#1b5e20" : s.status === "abandoned" ? "#616161" : "var(--panel)",
                    color: s.status === "testing" ? undefined : "#fff",
                  }}
                >
                  {s.status === "canon" ? "正典" : s.status === "abandoned" ? "弃稿" : "试跑中"}
                </span>
                <span className="muted" style={{ fontSize: 12 }}>
                  {s.messages.length} 条 · 更新 {new Date(s.updatedAt).toLocaleString()}
                  {s.rollingSummary ? ` · 前情摘要 ${s.rollingSummary.length} 字` : ""}
                  {rpSession?.id === s.id ? " · 当前续写中" : ""}
                </span>
                <button
                  onClick={() => {
                    rpSessionRef.current = s;
                    setRpSession(s);
                    setRpMountKey((k) => k + 1);
                    if (!pack) setPackError("先「生成试跑包」，然后这里点「续写」即可接着聊。");
                  }}
                  disabled={rpSession?.id === s.id}
                >
                  续写
                </button>
                {s.status !== "canon" && (
                  <button onClick={() => void markSessionStatus(s, "canon")} title="这一幕的演法被采纳为正典">
                    标为正典
                  </button>
                )}
                {s.status !== "testing" && (
                  <button onClick={() => void markSessionStatus(s, "testing")}>改回试跑</button>
                )}
                {s.status !== "abandoned" && (
                  <button onClick={() => void markSessionStatus(s, "abandoned")}>弃稿</button>
                )}
              </div>
              <details style={{ marginTop: 4 }}>
                <summary className="muted" style={{ fontSize: 12 }}>回放</summary>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    background: "var(--bg)",
                    padding: 8,
                    borderRadius: 6,
                    fontSize: 12,
                    maxHeight: 260,
                    overflowY: "auto",
                    marginTop: 4,
                  }}
                >
                  {s.rollingSummary ? `【前情摘要】${s.rollingSummary}\n\n` : ""}
                  {s.messages.map((m) => `${m.name || m.role}：${m.content}`).join("\n\n").slice(0, 6000)}
                  {s.messages.reduce((n, m) => n + m.content.length + 2, 0) > 6000 ? "\n…（回放截断 6000 字）" : ""}
                </pre>
              </details>
            </div>
          ))}
        </section>
      )}

      {/* ---------- 步骤3：导入试跑记录（ST 路径，可选） ---------- */}
      <section className="panel">
        <h3>③ 从 ST 导回试跑记录（可选：在 SillyTavern 里演完时，用 export chat 的 .jsonl / .json）</h3>
        <div className="row">
          <input type="file" accept=".jsonl,.json" onChange={(e) => void onChatFile(e)} disabled={busy || !scene} />
        </div>
        {parsed && (
          <p className="muted">
            解析出 {parsed.length} 条消息（转写 {toTranscript(parsed).split("\n").length} 行，system 不进转写）。
          </p>
        )}
        {importError && <p style={{ color: ERROR_COLOR }}>{importError}</p>}
        {busy && <p className="muted">AI（analyzer）复盘中：实际走向摘要 + 节拍比对 + 偏差 + 台账提案…</p>}

        {recap && !busy && (
          <div style={{ marginTop: 12 }}>
            <h4>实际走向摘要</h4>
            <p style={{ whiteSpace: "pre-wrap" }}>{recap.summary || "（模型未给出 summary）"}</p>

            {(recap.beatStatus ?? []).length > 0 && (
              <>
                <h4>节拍比对</h4>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid var(--line)", textAlign: "left" }}>
                      <th style={{ padding: "4px 8px" }}>期望节拍</th>
                      <th style={{ padding: "4px 8px" }}>判定</th>
                      <th style={{ padding: "4px 8px" }}>演出依据</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(recap.beatStatus ?? []).map((b, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid var(--line)" }}>
                        <td style={{ padding: "4px 8px" }}>{b?.beat ?? ""}</td>
                        <td
                          style={{
                            padding: "4px 8px",
                            whiteSpace: "nowrap",
                            fontWeight: 700,
                            color: BEAT_COLOR[b?.status] ?? "var(--muted)",
                          }}
                        >
                          {BEAT_LABEL[b?.status] ?? b?.status ?? "?"}
                        </td>
                        <td className="muted" style={{ padding: "4px 8px" }}>
                          {b?.evidence ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {(recap.divergences ?? []).length > 0 && (
              <>
                <h4>偏差</h4>
                {(recap.divergences ?? []).map((d, i) => (
                  <div
                    key={i}
                    className={d?.severity === "major" ? undefined : "muted"}
                    style={
                      d?.severity === "major"
                        ? { border: `1px solid ${ERROR_COLOR}`, borderRadius: 8, padding: "6px 10px", marginBottom: 6 }
                        : { marginBottom: 4 }
                    }
                  >
                    {d?.severity === "major" && <strong style={{ color: ERROR_COLOR }}>重大偏差 </strong>}
                    {d?.desc ?? ""}
                    {d?.suggestion ? <span className="muted">（建议：{d.suggestion === "steer" ? "纠偏拉回" : d.suggestion === "update_outline" ? "修订大纲" : d.suggestion === "accept" ? "接受既成事实" : d.suggestion}）</span> : null}{" "}
                    <button
                      className="muted"
                      style={{ fontSize: 12 }}
                      title="把这条偏差写成给站内 RP 的纠偏指令"
                      onClick={() =>
                        setCorrectionText((prev) =>
                          (prev ? prev + "\n" : "") +
                          `针对偏差「${(d?.desc ?? "").slice(0, 60)}」：${d?.suggestion === "steer" ? "请在不推翻已发生剧情的情况下把走向拉回大纲" : "请注意处理"}`,
                        )
                      }
                    >
                      → 拟为纠偏
                    </button>
                  </div>
                ))}
              </>
            )}

            {/* N3：注入纠偏继续站内演（复盘后即可用，不必等有登记的偏差） */}
            <div className="panel" style={{ marginTop: 8 }}>
              <label className="field">
                <span>注入纠偏，继续站内演（写进 author's note 区，下一句起生效；只影响站内 RP，ST 侧需手工贴）</span>
                <textarea rows={2} value={correctionText} onChange={(e) => setCorrectionText(e.target.value)} style={{ width: "100%" }} placeholder="例：薇薇安尚未察觉地窖钥匙，别让她的反应提前暴露这一点……" />
              </label>
              <div className="row" style={{ marginTop: 4 }}>
                <button className="primary" onClick={injectCorrection} disabled={!correctionText.trim() || !pack || !rpSetup}>
                  🎯 注入并继续演
                </button>
                {corrections.length > 0 && (
                  <button
                    onClick={() => {
                      setCorrections([]);
                      if (pack && rpSetup) setRpSetup({ ...rpSetup, authorNote: composeAuthorNote(pack.authorNote, []) });
                    }}
                  >
                    清空在场纠偏（{corrections.length}）
                  </button>
                )}
              </div>
              {!pack && <p className="muted" style={{ fontSize: 12 }}>站内 RP 未开启时此按钮不可用（ST 路径请把纠偏文字贴进 ST 的 author's note）。</p>}
            </div>

            {(recap.proposals ?? []).length > 0 && (
              <>
                <h4>台账提案（勾选后采纳）</h4>
                {(recap.proposals ?? []).map((p, i) => (
                  <label className="row" key={i} style={{ alignItems: "flex-start", marginBottom: 4 }}>
                    <input
                      type="checkbox"
                      checked={Boolean(checked[i])}
                      onChange={() => setChecked((prev) => prev.map((v, j) => (j === i ? !v : v)))}
                    />
                    <span>
                      <span
                        style={{
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                          padding: "0 6px",
                          marginRight: 6,
                          fontSize: 12,
                        }}
                      >
                        {typeBadge(p?.type)}
                      </span>
                      {p?.content ?? ""}
                      {Array.isArray(p?.actors) && p.actors.length > 0 && (
                        <span className="muted">（{p.actors.join("、")}）</span>
                      )}
                    </span>
                  </label>
                ))}
              </>
            )}

            {/* ---------- 动作四件套 ---------- */}
            <div className="row" style={{ marginTop: 14, flexWrap: "wrap" }}>
              <button className="primary" onClick={() => void onSaveSession()} disabled={!parsed}>
                保存会话
              </button>
              <button className="primary" onClick={() => void onApplyBeats()} disabled={!scene}>
                应用节拍标记
              </button>
              <button onClick={onMakeReweaveDraft} disabled={!scene}>
                反向修纲草案
              </button>
              <button onClick={() => void onApplyReweave()} disabled={!scene || reweaveText.trim() === ""}>
                应用到节点
              </button>
              <button className="primary" onClick={() => void onAdoptProposals()} disabled={validChecked === 0}>
                采纳台账提案{validChecked > 0 ? `（${validChecked}）` : ""}
              </button>
            </div>

            {savedSession && (
              <p className="muted">
                已保存会话：{savedSession.messages.length} 条消息，绑定本幕（id {savedSession.id.slice(0, 8)}…）。站内聊过则更新的是同一条工作会话。
              </p>
            )}
            {beatMsg && <p className="muted">{beatMsg}</p>}
            {playedDone && scene && (
              <div className="row" style={{ marginTop: 4 }}>
                <button className="primary" onClick={() => void lockScene()} disabled={!canTransition(scene.status, "locked")}>
                  🔒 本幕已演毕：标记已锁定
                </button>
                {!canTransition(scene.status, "locked") && (
                  <span className="muted" style={{ fontSize: 12 }}>（需先经「已试跑」，应用节拍标记时已自动置好）</span>
                )}
              </div>
            )}
            {reweaveText.trim() !== "" && (
              <label className="field" style={{ marginTop: 8 }}>
                <span>反向修纲草案（可手改预览；「应用到节点」落的是系统草案，应用手改内容未实现）</span>
                <textarea
                  rows={Math.min(12, Math.max(3, reweaveText.split("\n").length))}
                  value={reweaveText}
                  onChange={(e) => setReweaveText(e.target.value)}
                  style={{ width: "100%" }}
                />
              </label>
            )}
            {proposalMsg && <p className="muted">{proposalMsg}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
