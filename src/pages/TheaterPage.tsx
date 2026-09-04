// ============================================================
// RP 剧场（v3 独立化）—— 顶层页签，与作品平级。
//
// 房间模型：一个房间 = 一条 kind:"theater" 的会话行，自带——
//   · 剧本副本（开台时对选定作品大纲拍的快照；之后主纲怎么改都不渗进来）
//   · full 模式：可显式「同步副本」感知主纲更新；chapters 模式：永不同步（试跑语义）
//   · 房间正典（roomId 绑定的 confirmed 台账；新房间=空白正典；可选手动借作品级）
//   · 进展标记（progress 只写房间，永不回写主纲——agent 物理没有主纲写工具）
//   · 节奏（紧凑=强引导 / 舒缓=弱引导）、楼层定时整理（每 N 楼场记自动落正典）
// 场记 agent（P3）：7 个只读+副本写工具，「现在整理」或楼层触发；端点不支持
// tools 时自动降级为纯摘要整理（digest→直接进房间正典）。
// 本地写盘（P4）：连接一个文件夹后每轮稳定落定自动覆盖写 <房间名>-<id6>.jsonl；
// 浏览器不支持则走手动导出（诚实降级，不假装能自动）。
// 与「ST 试跑」分工不变：那页只做 ST 导出/往返/节拍命中复盘；站内 RP 全在这。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Character,
  LedgerRecord,
  LoreEntry,
  OutlineNode,
  Persona,
  Project,
  RPMessage,
  RPSession,
  TheaterPace,
  TheaterScope,
} from "../core/types";
import * as repos from "../store/repos";
import { sceneSequence } from "../flow/outline";
import type { RpTurn } from "../flow/rp";
import { composeAuthorNote } from "../flow/rp";
import { sanitizeDigest, type DigestLedgerItem } from "../flow/snapshot";
import {
  buildScriptSnapshot,
  detectMainScriptUpdate,
  mergeProgressOnSync,
  planLedgerCadence,
  scenesOfChapters,
  storyAdvance,
} from "../flow/script";
import { assembleRoom, newRoom, roomCurrentScene, roomSort } from "../flow/theater";
import { loadPrefs, savePrefs } from "../flow/prefs";
import { takeHandoff, putHandoff, type CorrectionHandoff, type TheaterHandoff } from "../flow/handoff";
import { goTab } from "../flow/nav";
import { rollingDigestPrompt } from "../ai/prompts";
import { chatJSON, chatTools, ToolsUnsupportedError } from "../ai/client";
import { loadAppConfig } from "../ai/config";
import { SCRIPT_KIT_DIRECTIVE, SCRIPT_TOOLS, runScriptTool, toolLabel, type ToolCall } from "../flow/agent";
import { RoomDiskWriter, fsSupported, roomFileName, type FsAutoStatus } from "../flow/fsauto";
import { toStChatJsonl } from "../st/chatlog";
import { RpRunner } from "../components/RpRunner";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function downloadText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const TYPE_LABEL: Record<string, string> = {
  event: "事件",
  item: "道具",
  relation: "关系",
  foreshadow: "伏笔",
  worldstate: "世界态",
};

export function TheaterPage() {
  // ---- 全局数据 ----
  const [projects, setProjects] = useState<Project[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [rooms, setRooms] = useState<RPSession[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState("");
  const prefsRef = useRef(loadPrefs());

  // ---- 当前房间所属作品的旁挂数据 ----
  const activeRoom = useMemo(() => rooms.find((r) => r.id === activeId) ?? null, [rooms, activeId]);
  const project = useMemo(
    () => projects.find((p) => p.id === activeRoom?.projectId) ?? null,
    [projects, activeRoom],
  );
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [roomCanon, setRoomCanon] = useState<LedgerRecord[]>([]);
  const [projectCanon, setProjectCanon] = useState<LedgerRecord[]>([]);

  // ---- 台面（开台装配产物）----
  const [corrections, setCorrections] = useState<string[]>([]);
  const [correctionText, setCorrectionText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [rpMountKey, setRpMountKey] = useState(0);

  // ---- 场记 agent ----
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDowngraded, setAgentDowngraded] = useState(false);

  // ---- 本地写盘 ----
  const writerRef = useRef<RoomDiskWriter | null>(null);
  const [disk, setDisk] = useState<FsAutoStatus>({
    supported: fsSupported(),
    connected: false,
    dirName: "",
    needsAction: "none",
    lastError: "",
    lastWriteAt: 0,
  });
  /** 连目录要用户手势：点按钮时直接 pick；restore 只恢复状态 */
  const pickDir = async () => {
    const w = writerRef.current;
    if (!w) return;
    try {
      await w.pick();
      setNote(`已连接文件夹「${w.status.dirName}」：此后每轮稳定落定都会覆盖写 <房间名>-<id6>.jsonl（全量快照）。`);
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) setNote(`连接文件夹失败：${errMsg(e)}`);
    }
  };

  // ---- 新建房间表单 ----
  const [creating, setCreating] = useState(false);
  const [nf, setNf] = useState({
    name: "",
    projectId: "",
    sandbox: false,
    scopeMode: "full" as TheaterScope,
    pace: prefsRef.current.pace as TheaterPace,
    charId: "",
    personaId: "",
    ledgerCadence: String(prefsRef.current.ledgerCadence),
    borrowProjectLedger: prefsRef.current.borrowProjectLedger,
    chapterIds: [] as string[],
  });
  const [nfNodes, setNfNodes] = useState<OutlineNode[]>([]); // 新表单里所选作品的章列表
  const [nfChars, setNfChars] = useState<Character[]>([]); // 新表单里所选作品的人物卡
  const [renameId, setRenameId] = useState("");
  const [renameVal, setRenameVal] = useState("");

  // ------------------------------------------------------------
  // 加载
  // ------------------------------------------------------------
  const refreshRooms = useCallback(async () => {
    const all = await repos.listAllSessions();
    const list = roomSort(all.filter((s) => s.kind === "theater"));
    setRooms(list);
    return list;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [ps, pf, list] = await Promise.all([repos.listProjects(), repos.listPersonas(), refreshRooms()]);
        setProjects(ps);
        setPersonas(pf);
        const remembered = prefsRef.current.lastRoomId;
        const first = remembered && list.some((r) => r.id === remembered) ? remembered : list[0]?.id ?? "";
        if (first) setActiveId(first);
        setLoaded(true);
      } catch (e) {
        setLoadError(errMsg(e));
        setLoaded(true);
      }
    })();
  }, [refreshRooms]);

  // 当前房间所属作品数据（切房间即重拉；正典=房间绑定+作品级备用）
  useEffect(() => {
    if (!activeRoom) {
      setNodes([]);
      setCharacters([]);
      setLoreEntries([]);
      setRoomCanon([]);
      setProjectCanon([]);
      return;
    }
    let dead = false;
    (async () => {
      try {
        const pid = activeRoom.projectId;
        const [nd, ch, lore, rc, pc] = await Promise.all([
          repos.listNodes(pid),
          repos.listCharacters(pid),
          repos.listLoreEntries(pid),
          repos.listLedger(pid, "confirmed", activeRoom.id),
          repos.listLedger(pid, "confirmed", "*"),
        ]);
        if (dead) return;
        setNodes(nd);
        setCharacters(ch);
        setLoreEntries(lore);
        setRoomCanon(rc);
        setProjectCanon(pc);
        setCorrections([]);
        setAgentSteps([]);
        setAgentDowngraded(false);
        setRpMountKey((k) => k + 1); // 显式换台意图：重挂 runner
      } catch (e) {
        if (!dead) setNote(`房间数据加载失败：${errMsg(e)}`);
      }
    })();
    return () => {
      dead = true;
    };
  }, [activeRoom?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 记住最后房间
  useEffect(() => {
    if (!activeId) return;
    prefsRef.current = { ...prefsRef.current, lastRoomId: activeId };
    savePrefs(prefsRef.current);
  }, [activeId]);

  // ------------------------------------------------------------
  // 本地写盘（P4）
  // ------------------------------------------------------------
  if (!writerRef.current) {
    writerRef.current = new RoomDiskWriter({
      loadDir: async () => (await repos.metaGet<import("../flow/fsauto").DirHandleLike | null>("theater.dir")) ?? null,
      saveDir: (d) => repos.metaPut("theater.dir", d),
    });
    writerRef.current.onStatus = (s) => setDisk(s);
    void writerRef.current.restore();
  }

  // ------------------------------------------------------------
  // 台面装配：只认房间自带数据（副本+房间正典），主纲渗透不进来
  // ------------------------------------------------------------
  const persona = useMemo(
    () => personas.find((p) => p.id === activeRoom?.config?.personaId) ?? null,
    [personas, activeRoom],
  );
  const assembly = useMemo(() => {
    if (!activeRoom) return null;
    return assembleRoom({
      room: activeRoom,
      project,
      characters,
      persona: persona ?? undefined,
      loreEntries,
      roomCanon,
      projectCanon: activeRoom.config?.borrowProjectLedger ? projectCanon : undefined,
    });
  }, [activeRoom, project, characters, persona, loreEntries, roomCanon, projectCanon]);

  /** 纠偏覆盖后的 setup（author's note = 基底 + 在场指令；换台/清纠偏回基底） */
  const runnerSetup = useMemo(() => {
    if (!assembly) return null;
    if (!corrections.length) return assembly.setup;
    return { ...assembly.setup, authorNote: composeAuthorNote(assembly.baseNote, corrections) };
  }, [assembly, corrections]);

  // 主纲又变了？（仅 full 模式提示；chapters 模式设计上不敏感）
  const mainUpdated = useMemo(() => {
    if (!activeRoom || activeRoom.sandbox || !activeRoom.script) return false;
    if ((activeRoom.scopeMode ?? "full") !== "full") return false;
    return detectMainScriptUpdate(activeRoom.script, nodes, Date.now());
  }, [activeRoom, nodes]);

  // ------------------------------------------------------------
  // 房间持久化（稳定落定才写；每次写盘全量 jsonl 快照）
  // ------------------------------------------------------------
  const saveRoom = useCallback(
    async (patch: Partial<RPSession>): Promise<RPSession | null> => {
      if (!activeRoom) return null;
      const next = { ...activeRoom, ...patch, updatedAt: Date.now() };
      const saved = await repos.saveSession(next);
      setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
      return saved;
    },
    [activeRoom],
  );

  const turnsToMessages = (turns: RpTurn[], prev: RPMessage[]): RPMessage[] =>
    turns.map((t, i) => ({
      id: prev[i]?.id ?? repos.uid(),
      role: t.role,
      name: t.name,
      content: t.content,
      createdAt: prev[i]?.createdAt ?? Date.now(),
    }));

  const exportJsonl = (room: RPSession, charName: string) =>
    toStChatJsonl(
      { userName: room.userName, charName },
      room.messages.map((m) => ({ role: m.role, name: m.name, content: m.content, createdAt: m.createdAt })),
    );

  const persist = useCallback(
    async (turns: RpTurn[], summary: string) => {
      if (!activeRoom) return;
      const msgs = turnsToMessages(turns, activeRoom.messages);
      const userFloors = msgs.filter((m) => m.role === "user").length;
      const cadence = activeRoom.config?.ledgerCadence ?? 0;
      const mark = activeRoom.config?.cadenceMark ?? 0;
      const due = planLedgerCadence(userFloors - mark, cadence);
      const saved = await saveRoom({
        messages: msgs,
        rollingSummary: summary || undefined,
        ...(due ? { config: { ...activeRoom.config!, cadenceMark: userFloors } } : {}),
      });
      // 本地写盘：全量快照覆盖（去抖在 writer 内部）
      if (saved) writerRef.current?.queue(roomFileName(saved.name ?? "", saved.id), exportJsonl(saved, assembly?.setup.charName ?? "角色"));
      // 楼层定时 → 场记自动整理（P3；不打断聊天，活动流里见）
      if (due && saved && (saved.config?.agentEnabled ?? true)) void organize("auto");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, assembly, saveRoom],
  );

  // ------------------------------------------------------------
  // 场记 agent（P3）：整理 = chatTools 多轮；端点不支持 tools → digest 降级
  // ------------------------------------------------------------
  const applyMarks = (marks: { id: string; st: "done" | "skipped" | "unmark" }[]) => {
    if (!activeRoom || marks.length === 0) return;
    const progress = { ...(activeRoom.progress ?? {}) };
    for (const m of marks) {
      if (m.st === "unmark") delete progress[m.id];
      else progress[m.id] = m.st;
    }
    void saveRoom({ progress });
  };

  const applyCanon = async (items: DigestLedgerItem[]) => {
    if (!activeRoom || items.length === 0) return;
    const now = Date.now();
    await repos.addRoomCanon(
      items.map((it) => ({
        id: repos.uid(),
        projectId: activeRoom.projectId,
        roomId: activeRoom.id,
        type: it.type,
        content: it.content,
        actors: it.actors,
        status: "confirmed" as const,
        createdAt: now,
      })),
    );
    setRoomCanon(await repos.listLedger(activeRoom.projectId, "confirmed", activeRoom.id));
  };

  const organizeRef = useRef(false);
  const organize = useCallback(
    async (mode: "manual" | "auto") => {
      const room = activeRoom;
      const asm = assembly;
      if (!room || !asm) return;
      if (organizeRef.current) return;
      organizeRef.current = true;
      setAgentBusy(true);
      const stamp = (line: string) =>
        setAgentSteps((prev) => [...prev.slice(-40), `[${new Date().toLocaleTimeString()}] ${line}`]);
      try {
        const turns = room.messages
          .filter((m) => m.content.trim())
          .slice(-24)
          .map((m) => `${m.name}：${m.content.trim()}`)
          .join("\n\n");
        if (!turns.trim()) {
          if (mode === "manual") stamp("没什么可整理的：对话还是空的。");
          return;
        }
        const marks: { id: string; st: "done" | "skipped" | "unmark" }[] = [];
        const added: DigestLedgerItem[] = [];
        const ctx = {
          snapshot: room.script ?? { sourceTitle: "", takenAt: 0, nodesUpdatedAt: 0, scenes: [] },
          progress: room.progress ?? {},
          canon: roomCanon,
          onMarkBeat: (id: string, st: "done" | "skipped" | "unmark") => marks.push({ id, st }),
          onAppendLedger: (it: DigestLedgerItem) => added.push(it),
        };
        const execute = (call: ToolCall) => runScriptTool(ctx, call.function.name, call.function.arguments).result;
        stamp(mode === "auto" ? `楼层定时到点：场记开始整理（第 ${room.messages.filter((m) => m.role === "user").length} 楼）` : "场记开始整理…");
        const res = await chatTools({
          role: "analyzer",
          tools: SCRIPT_TOOLS,
          execute,
          maxRounds: 4,
          messages: [
            { role: "system", content: SCRIPT_KIT_DIRECTIVE },
            {
              role: "system",
              content: `【当前局面】${asm.sceneTitle}（剧本《${room.script?.sourceTitle || "沙盒"}》副本）。\n【房间正典】${roomCanon.length ? `${roomCanon.length} 条已确认事实` : "（空白正典：这是新房间）"}`,
            },
            { role: "user", content: `请整理下面这段 RP 对话（最近楼层）：核对已演到的节拍并标记，把新发生的事实写入正典。\n\n${turns}` },
          ],
          onStep: (s) => {
            for (const c of s.calls) stamp(`${toolLabel(c.name, safeParse(c.arguments))} → ${c.result.split("\n")[0].slice(0, 60)}`);
          },
        });
        if (res.stopped === "max_rounds") stamp("已达 4 轮上限，剩余下轮继续。");
        if (res.text.trim()) stamp(`场记小结：${res.text.trim().slice(0, 160)}`);
        applyMarks(marks);
        await applyCanon(added);
        if (added.length) stamp(`写入房间正典 ${added.length} 条（新房间从空白开始，不借作品台账）。`);
        if (marks.length) stamp(`标记副本节拍 ${marks.length} 处（只动房间副本，主纲未受影响）。`);
        setAgentDowngraded(false);
      } catch (e) {
        if (e instanceof ToolsUnsupportedError) {
          // 降级：无工具的纯摘要整理，digest 直接进房间正典（用户决定②）
          setAgentDowngraded(true);
          try {
            const turns = room.messages
              .filter((m) => m.content.trim())
              .slice(-24)
              .map((m) => `${m.name}：${m.content.trim()}`)
              .join("\n\n");
            const obj = await chatJSON<unknown>(rollingDigestPrompt(room.rollingSummary ?? "", turns), { role: "analyzer" });
            const d = sanitizeDigest(obj);
            await applyCanon(d.ledger);
            if (d.summary) await saveRoom({ rollingSummary: d.summary });
            stamp(`端点不支持工具调用，已降级为纯摘要整理：正典 ${d.ledger.length} 条${d.summary ? "，滚动摘要已更新" : ""}。（节拍标记不可用）`);
          } catch (e2) {
            stamp(`降级整理也失败了：${errMsg(e2)}`);
          }
        } else {
          stamp(`整理失败：${errMsg(e)}`);
        }
      } finally {
        organizeRef.current = false;
        setAgentBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, assembly, roomCanon, saveRoom],
  );
  // ------------------------------------------------------------
  // 房间管理
  // ------------------------------------------------------------
  const createRoom = async () => {
    const pid = nf.projectId || prefsRef.current.lastProjectId || projects[0]?.id || "";
    if (!pid) {
      setNote("还没有作品：先到「作品」页建一个作品（剧本来自作品大纲）。");
      return;
    }
    try {
      const nd = nfNodes.length ? nfNodes : await repos.listNodes(pid);
      const proj = projects.find((p) => p.id === pid);
      const scenes = nf.sandbox || nf.scopeMode === "chapters" && nf.chapterIds.length === 0
        ? []
        : nf.scopeMode === "chapters"
          ? scenesOfChapters(nd, nf.chapterIds)
          : sceneSequence(nd);
      const snap = buildScriptSnapshot(proj?.title ?? "", nd, scenes, Date.now());
      const room = newRoom({
        id: repos.uid(),
        projectId: pid,
        projectName: proj?.title ?? "",
        name: nf.name.trim() || `${proj?.title ?? "作品"} · 房间${rooms.filter((r) => r.projectId === pid).length + 1}`,
        userName: loadAppConfig().userName || "读者",
        pace: nf.pace,
        scopeMode: nf.sandbox ? "full" : nf.scopeMode,
        sandbox: nf.sandbox,
        script: nf.sandbox ? { sourceTitle: proj?.title ?? "", takenAt: Date.now(), nodesUpdatedAt: Date.now(), scenes: [] } : snap,
        charId: nf.charId,
        personaId: nf.personaId || personas.find((p) => p.isDefault)?.id || "",
        budgetTokens: prefsRef.current.budgetTokens,
        reserveTokens: prefsRef.current.reserveTokens,
        ledgerCadence: Math.max(0, Math.floor(Number(nf.ledgerCadence) || 0)),
        borrowProjectLedger: nf.borrowProjectLedger,
        chapterIds: nf.sandbox ? undefined : nf.scopeMode === "chapters" ? nf.chapterIds : undefined,
        now: Date.now(),
      });
      const saved = await repos.saveSession(room);
      setRooms((prev) => roomSort([saved, ...prev]));
      setActiveId(saved.id);
      setCreating(false);
      prefsRef.current = { ...prefsRef.current, lastProjectId: pid, lastCharId: nf.charId, lastPersonaId: room.config?.personaId ?? "", pace: nf.pace, scopeMode: nf.scopeMode, ledgerCadence: room.config!.ledgerCadence, borrowProjectLedger: nf.borrowProjectLedger };
      savePrefs(prefsRef.current);
      setNote(`房间「${saved.name}」已开：正典空白，副本已拍（${snap.scenes.length} 幕）。${nf.sandbox ? "沙盒房没有剧本约束。" : ""}`);
    } catch (e) {
      setNote(`开房失败：${errMsg(e)}`);
    }
  };

  const deleteRoom = async (room: RPSession) => {
    if (!window.confirm(`删除房间「${room.name ?? room.id}」？其对话与房间正典（${room.id.slice(0, 6)}…绑定台账）一并删除，不可撤销。`)) return;
    await repos.deleteSession(room.id); // 级联删 roomId 台账（repos 层保证）
    setRooms((prev) => prev.filter((r) => r.id !== room.id));
    if (activeId === room.id) setActiveId(rooms.find((r) => r.id !== room.id)?.id ?? "");
  };

  const renameRoom = async () => {
    if (!renameId) return;
    const room = rooms.find((r) => r.id === renameId);
    if (room && renameVal.trim()) await saveRoomDirect(room, { name: renameVal.trim() });
    setRenameId("");
  };

  /** 列表上不依赖 activeRoom 的直改（重命名/标记等） */
  const saveRoomDirect = async (room: RPSession, patch: Partial<RPSession>) => {
    const saved = await repos.saveSession({ ...room, ...patch, updatedAt: Date.now() });
    setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
  };

  const syncSnapshot = async () => {
    if (!activeRoom || !project) return;
    const scenes =
      (activeRoom.scopeMode ?? "full") === "chapters" && activeRoom.config?.chapterIds?.length
        ? scenesOfChapters(nodes, activeRoom.config.chapterIds)
        : sceneSequence(nodes);
    const snap = buildScriptSnapshot(project.title, nodes, scenes, Date.now());
    await saveRoom({ script: snap, progress: mergeProgressOnSync(snap, activeRoom.progress) });
    setNote(`副本已同步主纲（${snap.scenes.length} 幕）；已演标记按节拍 id 保留 ${Object.keys(mergeProgressOnSync(snap, activeRoom.progress)).length} 个。`);
  };

  // 手动标记副本节拍（用户的手 = 合法；agent 的 mark_beat 走同一 progress）
  const toggleBeat = (beatId: string) => {
    if (!activeRoom) return;
    const cur = activeRoom.progress?.[beatId];
    const progress = { ...(activeRoom.progress ?? {}) };
    if (cur === undefined) progress[beatId] = "done";
    else if (cur === "done") progress[beatId] = "skipped";
    else delete progress[beatId];
    void saveRoom({ progress });
  };

  const deleteCanonRow = async (rec: LedgerRecord) => {
    if (!activeRoom) return;
    await repos.deleteLedger(rec.id);
    setRoomCanon((prev) => prev.filter((r) => r.id !== rec.id));
  };

  const setConfig = (patch: Partial<NonNullable<RPSession["config"]>>) => {
    if (!activeRoom?.config) return;
    void saveRoom({ config: { ...activeRoom.config, ...patch } });
  };

  // ------------------------------------------------------------
  // 纠偏 / 复盘移交
  // ------------------------------------------------------------
  const injectCorrection = () => {
    const text = correctionText.trim();
    if (!text || !runnerSetup) return;
    const next = [...corrections, text].slice(-3);
    setCorrections(next);
    setCorrectionText("");
    setNote(`纠偏已注入（在场 ${next.length} 条，超三条自动退旧）：下一句起生效，对话完整保留。`);
  };

  const bringBackToRecap = async (turns: RpTurn[]) => {
    if (!activeRoom || turns.length === 0) return;
    const cur = roomCurrentScene(activeRoom);
    if (!cur) {
      setNote("沙盒房没有剧本幕，复盘（节拍命中）不适用；要小说化请用「⬇ jsonl」导出。");
      return;
    }
    const msgs = turnsToMessages(turns, activeRoom.messages);
    await saveRoom({ messages: msgs });
    if (!cur.nodeId) {
      setNote("副本幕找不到主纲节点（可能主纲已重排）：请用「⬇ jsonl」导出后在试跑页导入复盘。");
      return;
    }
    putHandoff({ kind: "recap", projectId: activeRoom.projectId, nodeId: cur.nodeId, sessionId: activeRoom.id });
    goTab("projects");
  };

  // ------------------------------------------------------------
  // 交接消费（每次挂载至多一次）
  // ------------------------------------------------------------
  const jumpApplied = useRef(false);
  const pendingRoomCreate = useRef<TheaterHandoff | null>(null);
  useEffect(() => {
    if (!loaded || jumpApplied.current) return;
    jumpApplied.current = true;
    const th = takeHandoff("theater", "*") as TheaterHandoff | null;
    const ch = takeHandoff("correction", "*") as CorrectionHandoff | null;
    if (ch) {
      setCorrectionText(ch.text);
      setNote("复盘移交的纠偏已预填：开台后点「注入纠偏」才生效（目前尚未注入）。");
    }
    if (th) pendingRoomCreate.current = th;
  }, [loaded]);

  // 自动开房（「续写（去剧场）」/「导去剧场演全本」）：数据就绪后建一次
  useEffect(() => {
    const th = pendingRoomCreate.current;
    if (!loaded || !th) return;
    pendingRoomCreate.current = null;
    (async () => {
      try {
        const nd = await repos.listNodes(th.projectId);
        const proj = projects.find((p) => p.id === th.projectId) ?? (await repos.getProject(th.projectId)) ?? null;
        const ch = await repos.listCharacters(th.projectId);
        const scenes = sceneSequence(nd);
        const snap = buildScriptSnapshot(proj?.title ?? "", nd, scenes, Date.now());
        const src = th.sessionId ? await repos.getSession(th.sessionId) : undefined;
        const charHit = th.charHint ? ch.find((c) => c.name === th.charHint) : undefined;
        const room = newRoom({
          id: repos.uid(),
          projectId: th.projectId,
          projectName: proj?.title ?? "",
          name: `${proj?.title ?? "作品"} · ${src ? "续写" : "全本"} ${new Date().toLocaleDateString()}`,
          userName: src?.userName || "读者",
          pace: prefsRef.current.pace,
          scopeMode: "full",
          sandbox: scenes.length === 0,
          script: snap,
          charId: charHit?.id ?? "",
          personaId: personas.find((p) => p.isDefault)?.id ?? "",
          budgetTokens: prefsRef.current.budgetTokens,
          reserveTokens: prefsRef.current.reserveTokens,
          ledgerCadence: prefsRef.current.ledgerCadence,
          borrowProjectLedger: false,
          now: Date.now(),
        });
        if (src && src.messages.length) {
          room.messages = src.messages;
          room.rollingSummary = src.rollingSummary;
        }
        const saved = await repos.saveSession(room);
        setRooms((prev) => roomSort([saved, ...prev.filter((r) => r.id !== saved.id)]));
        setActiveId(saved.id);
        setNote(src ? "由试跑「续写」移交：对话已带进新房间，接着演。" : "已按当前大纲开全本房间（full 模式：主纲之后有更新可点「同步副本」）。");
      } catch (e) {
        setNote(`开房失败：${errMsg(e)}`);
      }
    })();
  }, [loaded, rooms.length, projects]); // eslint-disable-line react-hooks/exhaustive-deps

  // 打开新建表单时给所选作品装载默认值（章/卡下拉要有数据）
  useEffect(() => {
    if (!creating || nf.projectId) return;
    const pid = prefsRef.current.lastProjectId || projects[0]?.id || "";
    if (!pid) return;
    setNf((f) => ({ ...f, projectId: pid }));
    void (async () => {
      const [nd2, ch2] = await Promise.all([repos.listNodes(pid), repos.listCharacters(pid)]);
      setNfNodes(nd2);
      setNfChars(ch2);
    })();
  }, [creating]); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------
  // 渲染
  // ------------------------------------------------------------
  if (loadError) return <div className="panel">剧场加载失败：{loadError}</div>;
  if (!loaded) return <div className="panel">剧场加载中…</div>;

  const adv = activeRoom ? storyAdvance(activeRoom.script ?? { sourceTitle: "", takenAt: 0, nodesUpdatedAt: 0, scenes: [] }, activeRoom.progress ?? {}) : null;

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
      {/* ============ 左栏：房间列表 ============ */}
      <aside style={{ width: 232, flexShrink: 0, display: "grid", gap: 8 }}>
        <button onClick={() => setCreating((v) => !v)}>{creating ? "收起新建" : "＋ 新建房间"}</button>
        {creating && (
          <div className="panel" style={{ display: "grid", gap: 6 }}>
            <input placeholder="房间名（可空=自动）" value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} />
            <select
              value={nf.projectId || projects[0]?.id || ""}
              onChange={async (e) => {
                const pid = e.target.value;
                setNf({ ...nf, projectId: pid, chapterIds: [], charId: "" });
                if (pid) {
                  const [nd2, ch2] = await Promise.all([repos.listNodes(pid), repos.listCharacters(pid)]);
                  setNfNodes(nd2);
                  setNfChars(ch2);
                } else {
                  setNfNodes([]);
                  setNfChars([]);
                }
              }}
            >
              {projects.length === 0 && <option value="">（还没有作品）</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={nf.sandbox} onChange={(e) => setNf({ ...nf, sandbox: e.target.checked })} /> 沙盒房（不用剧本，自由即兴）
            </label>
            {!nf.sandbox && (
              <>
                <label style={{ fontSize: 12 }}>
                  <input type="radio" checked={nf.scopeMode === "full"} onChange={() => setNf({ ...nf, scopeMode: "full" })} /> 全本（感知主纲更新，可同步）
                </label>
                <label style={{ fontSize: 12 }}>
                  <input type="radio" checked={nf.scopeMode === "chapters"} onChange={() => setNf({ ...nf, scopeMode: "chapters" })} /> 章选（试跑几章，主纲再改也不受影响）
                </label>
                {nf.scopeMode === "chapters" && (
                  <div style={{ maxHeight: 120, overflowY: "auto", fontSize: 12, border: "1px solid var(--line)", padding: 4 }}>
                    {nfNodes.filter((n) => n.level === "chapter").length === 0 && <div style={{ color: "var(--muted)" }}>该作品还没有章</div>}
                    {nfNodes
                      .filter((n) => n.level === "chapter")
                      .map((c) => (
                        <label key={c.id} style={{ display: "block" }}>
                          <input
                            type="checkbox"
                            checked={nf.chapterIds.includes(c.id)}
                            onChange={(e) =>
                              setNf({ ...nf, chapterIds: e.target.checked ? [...nf.chapterIds, c.id] : nf.chapterIds.filter((x) => x !== c.id) })
                            }
                          />{" "}
                          {c.title || "（未命名章）"}
                        </label>
                      ))}
                  </div>
                )}
              </>
            )}
            <select value={nf.pace} onChange={(e) => setNf({ ...nf, pace: e.target.value as TheaterPace })}>
              <option value="loose">节奏 · 舒缓（弱引导，允许跑题）</option>
              <option value="tight">节奏 · 紧凑（强引导，快推主线）</option>
            </select>
            <select
              value={nf.charId}
              onChange={(e) => setNf({ ...nf, charId: e.target.value })}
              title="扮演对手的角色卡；不选=旁白叙述体"
            >
              <option value="">角色卡 · 旁白演绎（不用卡）</option>
              {nfChars.map((c) => (
                <option key={c.id} value={c.id}>{c.name || "（无名卡）"}</option>
              ))}
            </select>
            <select
              value={nf.personaId || personas.find((p) => p.isDefault)?.id || ""}
              onChange={(e) => setNf({ ...nf, personaId: e.target.value })}
              title="{{user}} 形象：画像库在顶层「画像」页维护"
            >
              <option value="">画像 · 不设</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>{p.name}{p.isDefault ? "（默认）" : ""}</option>
              ))}
            </select>
            <input
              placeholder="台账楼层定时（每 N 楼自动整理；0=关）"
              value={nf.ledgerCadence}
              onChange={(e) => setNf({ ...nf, ledgerCadence: e.target.value })}
            />
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={nf.borrowProjectLedger} onChange={(e) => setNf({ ...nf, borrowProjectLedger: e.target.checked })} /> 借用作品级台账（默认各房独立正典）
            </label>
            <button onClick={() => void createRoom()}>开房</button>
          </div>
        )}

        <div style={{ display: "grid", gap: 4 }}>
          {rooms.length === 0 && <div className="panel" style={{ color: "var(--muted)", fontSize: 12 }}>还没有房间：点上方「新建房间」。剧本来自作品的「大纲工作台」。</div>}
          {rooms.map((r) => (
            <div
              key={r.id}
              className="panel"
              style={{
                padding: "6px 8px",
                cursor: "pointer",
                borderColor: r.id === activeId ? "var(--accent)" : "var(--line)",
                display: "grid",
                gap: 2,
              }}
              onClick={() => setActiveId(r.id)}
            >
              {renameId === r.id ? (
                <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 4 }}>
                  <input autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void renameRoom()} style={{ width: 110 }} />
                  <button onClick={() => void renameRoom()}>好</button>
                  <button onClick={() => setRenameId("")}>×</button>
                </span>
              ) : (
                <b style={{ fontSize: 13 }}>{r.name ?? "（未命名）"}</b>
              )}
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {projects.find((p) => p.id === r.projectId)?.title ?? "（作品已删）"} ·{" "}
                {r.sandbox ? "沙盒" : (r.scopeMode ?? "full") === "full" ? "全本" : `章选${r.config?.chapterIds?.length ? `×${r.config.chapterIds.length}` : ""}`} ·{" "}
                {r.pace === "tight" ? "紧凑" : "舒缓"} · {r.messages.filter((m) => m.role === "user").length} 楼
              </span>
              <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, fontSize: 11 }}>
                <button style={{ fontSize: 11, padding: "1px 5px" }} title="重命名" onClick={() => { setRenameId(r.id); setRenameVal(r.name ?? ""); }}>改名</button>
                <button
                  style={{ fontSize: 11, padding: "1px 5px" }}
                  title="导出 ST chat .jsonl（本地未连文件夹时的手动通道）"
                  onClick={() => downloadText(roomFileName(r.name ?? "", r.id), exportJsonl(r, r.config?.charId ? "角色" : "旁白"))}
                >
                  ⬇
                </button>
                <button style={{ fontSize: 11, padding: "1px 5px", color: "#b3261e" }} title="删除房间及其正典" onClick={() => void deleteRoom(r)}>删</button>
              </span>
            </div>
          ))}
        </div>
      </aside>

      {/* ============ 右栏：房间详情 ============ */}
      <section style={{ flex: 1, minWidth: 0, display: "grid", gap: 10 }}>
        {!activeRoom || !assembly ? (
          <div className="panel">左侧新建或选择一个房间。房间=一段长期 RP：对话、剧本副本、正典都长在房间里，切页不丢。</div>
        ) : (
          <>
            {/* 房间头：模式/同步/写盘状态 */}
            <div className="panel" style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
              <b>{activeRoom.name ?? "（未命名）"}</b>
              <span style={{ fontSize: 12, color: "var(--muted)" }}>
                {project ? `《${project.title}》` : "（作品已删）"} · {assembly.sceneTitle}
                {adv && !activeRoom.sandbox && adv.scenesTotal > 0 ? ` · 副本进展 幕${(adv.currentSceneIndex ?? adv.scenesTotal - 1) + 1}/${adv.scenesTotal} 拍${adv.beatsDone}/${adv.beatsTotal}` : ""}
                {adv?.finished ? " · 副本已全部演完" : ""}
              </span>
              {mainUpdated && (activeRoom.scopeMode ?? "full") === "full" && (
                <button style={{ borderColor: "var(--accent)" }} title="把主纲最新大纲重新拍进本房间副本（已演标记尽量保留）。不点就永远用旧副本。" onClick={() => void syncSnapshot()}>
                  ⚡ 主纲有更新，同步副本
                </button>
              )}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--muted)" }}>
                {!disk.supported
                  ? "此浏览器不支持本地文件夹自动写盘：用每间「⬇」手动导出"
                  : disk.needsAction === "reselect"
                    ? <button style={{ color: "#b3261e", fontSize: 11 }} onClick={() => void pickDir()}>文件夹没了，重选</button>
                    : disk.needsAction === "reauth"
                      ? <button style={{ fontSize: 11 }} onClick={() => void writerRef.current!.reconnect().catch((e) => setNote(`重连失败：${errMsg(e)}`))}>重新连接「{disk.dirName}」</button>
                      : disk.connected
                        ? <span>📁 自动写入「{disk.dirName}」{disk.lastWriteAt ? ` · ${new Date(disk.lastWriteAt).toLocaleTimeString()}` : ""} <button style={{ fontSize: 10 }} onClick={() => void writerRef.current!.disconnect()}>断开</button></span>
                        : <button style={{ fontSize: 11 }} onClick={() => void pickDir()}>📁 连接本地文件夹（每轮自动写 jsonl）</button>}
              </span>
              {disk.lastError && <span style={{ fontSize: 11, color: "#b3261e" }}>{disk.lastError}</span>}
            </div>

            {note && <div className="panel" style={{ fontSize: 12 }}>{note} <button style={{ fontSize: 10 }} onClick={() => setNote(null)}>知道了</button></div>}

            {/* 配置条：节奏 / 正典借用 / 场记开关 / 楼层定时 */}
            {activeRoom.config && (
              <div className="panel" style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 12, alignItems: "center" }}>
                <label>节奏
                  <select value={activeRoom.pace ?? "loose"} onChange={(e) => void saveRoom({ pace: e.target.value as TheaterPace })}>
                    <option value="loose">舒缓（允许跑题）</option>
                    <option value="tight">紧凑（强引导快推）</option>
                  </select>
                </label>
                <label title="打开后，作品级已确认台账会标注「借自作品级台账」注入；房间自己的正典始终优先">
                  <input type="checkbox" checked={activeRoom.config.borrowProjectLedger} onChange={(e) => setConfig({ borrowProjectLedger: e.target.checked })} /> 借作品级台账
                </label>
                <label title="场记 agent：读副本/对进度/标节拍/写本房间正典。物理上没有任何修改主纲的工具。">
                  <input type="checkbox" checked={activeRoom.config.agentEnabled ?? true} onChange={(e) => setConfig({ agentEnabled: e.target.checked })} /> 场记 agent
                </label>
                <label>楼层定时
                  <input style={{ width: 46 }} value={String(activeRoom.config.ledgerCadence)} onChange={(e) => setConfig({ ledgerCadence: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} /> 楼
                </label>
                <span style={{ color: "var(--muted)" }}>正典 {roomCanon.length} 条{activeRoom.config.borrowProjectLedger ? `（另借 ${projectCanon.length}）` : ""}</span>
              </div>
            )}

            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              {/* RP 主台 */}
              <div style={{ flex: "2 1 480px", minWidth: 340 }}>
                {runnerSetup && (
                  <RpRunner
                    key={`${activeRoom.id}:${rpMountKey}`}
                    setup={runnerSetup}
                    charName={assembly.setup.charName}
                    userName={activeRoom.userName}
                    sceneLabel={assembly.sceneTitle}
                    greeting={assembly.greeting}
                    initial={
                      activeRoom.messages.length
                        ? {
                            turns: activeRoom.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
                            summary: activeRoom.rollingSummary ?? "",
                          }
                        : null
                    }
                    initialBudget={{ budgetTokens: activeRoom.config?.budgetTokens ?? 8192, reserveTokens: activeRoom.config?.reserveTokens ?? 768 }}
                    onPersist={(turns, summary) => void persist(turns, summary)}
                    onDigest={(items) => void applyCanon(items)}
                    onBringBack={(turns) => void bringBackToRecap(turns)}
                  />
                )}
              </div>

              {/* 右侧：进展清单 + 场记活动 + 房间正典 + 纠偏 */}
              <div style={{ flex: "1 1 260px", minWidth: 250, display: "grid", gap: 10 }}>
                {!activeRoom.sandbox && activeRoom.script && activeRoom.script.scenes.length > 0 && (
                  <div className="panel" style={{ maxHeight: 240, overflowY: "auto", fontSize: 12 }}>
                    <b>剧本副本（只读引用 · 主纲去「作品 › 大纲工作台」改）</b>
                    {activeRoom.script.scenes.map((sc) => (
                      <div key={`${sc.nodeId}`} style={{ marginTop: 6 }}>
                        <div style={{ color: "var(--muted)" }}>{sc.path}</div>
                        {sc.beats.map((b) => {
                          const st = activeRoom.progress?.[b.id];
                          return (
                            <label key={b.id} style={{ display: "block", cursor: "pointer" }} title="点一下循环：未演→已演→跳过→未演（只标房间副本）">
                              <input type="checkbox" checked={st === "done"} onChange={() => toggleBeat(b.id)} />{" "}
                              <span style={{ textDecoration: st === "skipped" ? "line-through" : undefined, color: st === "skipped" ? "var(--muted)" : undefined }}>
                                {b.text}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}

                <div className="panel" style={{ fontSize: 12 }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <b>场记</b>
                    <button disabled={agentBusy || !(activeRoom.config?.agentEnabled ?? true)} onClick={() => void organize("manual")}>
                      {agentBusy ? "整理中…" : "现在整理"}
                    </button>
                    {agentDowngraded && <span style={{ color: "var(--muted)" }}>（此端点不支持工具：已降级纯摘要）</span>}
                  </div>
                  {agentSteps.length > 0 && (
                    <div style={{ marginTop: 6, maxHeight: 150, overflowY: "auto", fontFamily: "monospace", fontSize: 11, whiteSpace: "pre-wrap" }}>
                      {agentSteps.join("\n")}
                    </div>
                  )}
                  <div style={{ color: "var(--muted)", marginTop: 4 }}>
                    工具面：读副本/对进度/标节拍/读正典/写正典——没有任何修改主纲的工具；副本改动永不回写。
                  </div>
                </div>

                <div className="panel" style={{ fontSize: 12, maxHeight: 220, overflowY: "auto" }}>
                  <b>房间正典（{roomCanon.length} 条；只属于本房间）</b>
                  {roomCanon.length === 0 && <div style={{ color: "var(--muted)", marginTop: 4 }}>空白。场记整理或折叠历史时，已演事实会写进这里——新房间不继承任何旧事实。</div>}
                  {roomCanon
                    .slice()
                    .reverse()
                    .map((r) => (
                      <div key={r.id} style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "baseline" }}>
                        <span style={{ color: "var(--accent)" }}>[{TYPE_LABEL[r.type] ?? r.type}]</span>
                        <span style={{ flex: 1 }}>{r.content}</span>
                        <button style={{ fontSize: 10 }} onClick={() => void deleteCanonRow(r)}>删</button>
                      </div>
                    ))}
                </div>

                <div className="panel" style={{ fontSize: 12 }}>
                  <b>纠偏（author's note，下一句生效）</b>
                  <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                    <input style={{ flex: 1 }} placeholder="例如：薇薇安此刻还不知道匕首失窃" value={correctionText} onChange={(e) => setCorrectionText(e.target.value)} />
                    <button onClick={injectCorrection}>注入</button>
                  </div>
                  {corrections.length > 0 && (
                    <div style={{ marginTop: 4 }}>
                      {corrections.map((c, i) => (
                        <div key={i} style={{ color: "var(--muted)" }}>· {c}</div>
                      ))}
                      <button style={{ fontSize: 10, marginTop: 2 }} onClick={() => setCorrections([])}>清空在场纠偏</button>
                    </div>
                  )}
                  <div style={{ color: "var(--muted)", marginTop: 4 }}>只影响站内 RP；导出去 ST 的往返不吃这份纠偏。</div>
                </div>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}
