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
import type { DigestLedgerItem } from "../flow/snapshot";
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
import { subscribeAgentRun, startOrganize, type OrganizeIO } from "../flow/agentrun";
import { takeHandoff, putHandoff, type CorrectionHandoff, type TheaterHandoff } from "../flow/handoff";
import { goTab } from "../flow/nav";
import { RoomDiskWriter, fsSupported, roomFileName, type FsAutoStatus } from "../flow/fsauto";
import { toStChatJsonl } from "../st/chatlog";
import { RpRunner } from "../components/RpRunner";
import { RoomLedgerPanel } from "../components/RoomLedgerPanel";

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

  // ---- 场记 agent（v3.1-①：run 活在模块注册表里，切页不中断；这里只是订阅视图）----
  const [agentSteps, setAgentSteps] = useState<string[]>([]);
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentDowngraded, setAgentDowngraded] = useState(false);
  useEffect(() => {
    if (!activeId) return;
    // 换房间先清空视图（有进行中/已完成的 run 时，subscribe 会立即回放其快照）
    setAgentSteps([]);
    setAgentDowngraded(false);
    return subscribeAgentRun(activeId, (s) => {
      setAgentSteps(s.steps);
      setAgentBusy(s.running);
      setAgentDowngraded(s.downgraded);
    });
  }, [activeId]);

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
  // v3.1-⑥ H2 双开防护：同房间跨页签互斥。
  // 锁只在**同一个浏览器**的页签间互斥；拿到锁的页签可写，拿不到的整房只读
  // （消息整列表 last-write-wins 是跨页签唯一没法用写链解决的数据竞争）。
  // ------------------------------------------------------------
  const [roomLocked, setRoomLocked] = useState(false);
  useEffect(() => {
    setRoomLocked(false);
    if (!activeRoom || typeof navigator === "undefined" || !navigator.locks) return; // 不支持的浏览器：不拦（老行为）
    let release: () => void = () => {};
    let cancelled = false;
    const held = new Promise<void>((res) => {
      release = res;
    });
    void navigator.locks
      .request(`ss-rp-room-${activeRoom.id}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          if (!cancelled) setRoomLocked(true);
          return; // 拿不到 → 立即归还（本来就没有）
        }
        await held; // 拿到了：一直持有到本房切走/卸载
      })
      .catch(() => {
        /* 锁 API 异常不拦正常使用 */
      });
    return () => {
      cancelled = true;
      release();
    };
  }, [activeRoom?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // 用户名＝所选画像的名字（v3.1-⑤：不再有全局用户名；无画像落「读者」）
  const personaName = useCallback(
    (personaId: string) => personas.find((p) => p.id === personaId)?.name?.trim() || "读者",
    [personas],
  );

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
  // v3.1-⑥：per-room 串行写链——异步落库按调用序执行，后发的旧快照不会越过
  // 先发的新快照；链内 updateSession 事务读-改-写，跨页签并发也只丢单项补丁。
  // ------------------------------------------------------------
  const writeChains = useRef(new Map<string, Promise<unknown>>());
  const queueRoomWrite = useCallback(
    <T,>(roomId: string, fn: () => Promise<T>): Promise<T | undefined> => {
      const prev = writeChains.current.get(roomId) ?? Promise.resolve();
      const next = prev.then(fn, fn); // 前一个失败不拦后续
      writeChains.current.set(roomId, next);
      void next.finally(() => {
        if (writeChains.current.get(roomId) === next) writeChains.current.delete(roomId);
      });
      return next;
    },
    [],
  );

  const saveRoom = useCallback(
    async (patch: Partial<RPSession>): Promise<RPSession | null> => {
      if (!activeRoom) return null;
      const id = activeRoom.id;
      // v3.1-⑥ 事务内读-改-写：场记/自动保存并发写同一房间不互相覆盖
      const saved = await queueRoomWrite(id, () => repos.updateSession(id, (cur) => ({ ...cur, ...patch })));
      if (saved) setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
      return saved ?? null;
    },
    [activeRoom, queueRoomWrite],
  );

  /** turns→messages：按稳定 id 对齐旧行（截断/删除/并发不错位）；旧数据无 id 时退化为位次对齐 */
  const turnsToMessages = (turns: RpTurn[], prev: RPMessage[]): RPMessage[] => {
    const byId = new Map(prev.map((m) => [m.id, m]));
    const legacyUsed = new Set<string>();
    return turns.map((t, i) => {
      let old = t.id ? byId.get(t.id) : undefined;
      if (!old && !t.id) {
        // 兼容无 id 旧轮（理论不该出现）：位次对齐且不复用
        const cand = prev[i];
        if (cand && !legacyUsed.has(cand.id)) {
          old = cand;
          legacyUsed.add(cand.id);
        }
      }
      return {
        id: t.id ?? old?.id ?? repos.uid(),
        role: t.role,
        name: t.name,
        content: t.content,
        createdAt: old?.createdAt ?? Date.now(),
        // reasoning/notes：turn 上有用 turn 的；没有的沿用库里旧值（场记并行写入不被打字挤掉）
        ...((t.reasoning ?? old?.reasoning) ? { reasoning: t.reasoning ?? old?.reasoning } : {}),
        ...(t.notes?.length || old?.notes?.length ? { notes: t.notes?.length ? t.notes : old?.notes } : {}),
      };
    });
  };

  const exportJsonl = (room: RPSession, charName: string) =>
    toStChatJsonl(
      { userName: room.userName, charName },
      room.messages.map((m) => ({ role: m.role, name: m.name, content: m.content, createdAt: m.createdAt })),
    );

  /** v3.1-⑥ 悬殊守卫：条数骤减超过 max(2, 半数) 即视为可疑整屏覆盖。
   *  放行三种本意：allowClear（用户确认过的清空）、allowFold（摘要折叠，旧回合转存档）。 */
  const suspiciousShrink = (base: RPSession, msgs: RPMessage[], allowClear: boolean, allowFold: boolean) =>
    !allowClear && !allowFold && base.messages.length - msgs.length > Math.max(2, Math.floor(base.messages.length * 0.5));

  const persist = useCallback(
    async (turns: RpTurn[], summary: string, allowClear = false, allowFold = false) => {
      if (!activeRoom) return;
      const id = activeRoom.id;
      let due = false;
      let guardHit = false;
      // 链内事务读-改-写：调用序=落库序；cadence 判定基于库内最新行
      const saved = await queueRoomWrite(id, () =>
        repos.updateSession(id, (base) => {
          const msgs = turnsToMessages(turns, base.messages);
          if (suspiciousShrink(base, msgs, allowClear, allowFold)) {
            guardHit = true;
            return base; // 整行不动：可疑的旧快照晚到不碰历史
          }
          // 折叠留底：被摘要折叠掉的条按 id 找回来挪进存档，永不真删
          const keptIds = new Set(msgs.map((m) => m.id));
          const archived = (base.messagesArchive ?? []).filter((m) => !keptIds.has(m.id));
          const rolled = base.messages.filter((m) => allowFold && !keptIds.has(m.id));
          const userFloors = msgs.filter((m) => m.role === "user").length;
          due = planLedgerCadence(userFloors - (base.config?.cadenceMark ?? 0), base.config?.ledgerCadence ?? 0);
          return {
            ...base,
            messages: msgs,
            rollingSummary: summary || undefined,
            ...(archived.length || rolled.length ? { messagesArchive: [...archived, ...rolled] } : {}),
            ...(due && base.config ? { config: { ...base.config, cadenceMark: userFloors } } : {}),
          };
        }),
      );
      if (guardHit) {
        setNote("拦截了一次可疑的整屏覆盖（历史条数骤减且非折叠/非你确认的清空）——对话按库内最新保留。若这是你的本意，请逐条删除或用「重新开始」。");
        return;
      }
      // 本地写盘：全量快照覆盖（去抖在 writer 内部）
      if (saved) writerRef.current?.queue(roomFileName(saved.name ?? "", saved.id), exportJsonl(saved, assembly?.setup.charName ?? "角色"));
      // 楼层定时 → 场记自动整理（跑在注册表里，切页不中断；活动流里见）
      if (due && saved && (saved.config?.agentEnabled ?? true)) void organize("auto");
      if (saved) setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, assembly, queueRoomWrite],
  );

  /** v3.1-⑥ 流式期自动保存：只落消息（含半句），不动 cadence/不触发场记；
   *  同样走链保序，且永远带悬殊守卫（autosave 没有任何清空的理由） */
  const autosave = useCallback(
    async (turns: RpTurn[], summary: string) => {
      if (!activeRoom) return;
      const id = activeRoom.id;
      const saved = await queueRoomWrite(id, () =>
        repos.updateSession(id, (base) => {
          const msgs = turnsToMessages(turns, base.messages);
          if (suspiciousShrink(base, msgs, false, false)) return base;
          return { ...base, messages: msgs, rollingSummary: summary || undefined };
        }),
      );
      if (saved) setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeRoom, queueRoomWrite],
  );

  // ------------------------------------------------------------
  // 场记（v3.1-①）：整理跑在模块注册表里（flow/agentrun），切页/卸载都不中断；
  // 每个工具调用即时落库，本页只是订阅视图。
  // ------------------------------------------------------------
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

  // ------------------------------------------------------------
  // 场记（v3.1-①）：整理跑在模块注册表里，切页/卸载都不中断；本页只是订阅视图。
  // io 全部现读现写（不捕获渲染态），每个工具调用即时落库。
  // ------------------------------------------------------------
  const activeRoomIdRef = useRef("");
  useEffect(() => {
    activeRoomIdRef.current = activeId;
  }, [activeId]);
  const sceneTitleRef = useRef("");
  useEffect(() => {
    sceneTitleRef.current = assembly?.sceneTitle ?? "";
  }, [assembly]);

  const organizeIO: OrganizeIO = useMemo(
    () => ({
      loadRoom: (roomId) => repos.getSession(roomId),
      patchRoom: async (roomId, patch) => {
        // 与聊天/自动保存同一条串行写链（调用序=落库序，不互相越序覆盖）
        const saved = await queueRoomWrite(roomId, () => repos.updateSession(roomId, (cur) => ({ ...cur, ...patch })));
        if (saved) setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
      },
      addCanon: async (room, items) => {
        await repos.addRoomCanon(
          items.map((it) => ({
            id: repos.uid(),
            projectId: room.projectId,
            roomId: room.id,
            type: it.type,
            content: it.content,
            actors: it.actors,
            status: "confirmed" as const,
            createdAt: Date.now(),
          })),
        );
      },
      canonOf: (roomId) =>
        repos.getSession(roomId).then((r) => (r ? repos.listLedger(r.projectId, "confirmed", roomId) : [])),
      onCanonChanged: async (roomId) => {
        if (activeRoomIdRef.current !== roomId) return;
        const cur = await repos.getSession(roomId);
        if (!cur || activeRoomIdRef.current !== roomId) return;
        setRoomCanon(await repos.listLedger(cur.projectId, "confirmed", roomId));
      },
      onNote: async (rid, line) => {
        // v3.1-⑦ 场记 tools 调用活动挂到最后一条 assistant 消息的 notes →
        // 在回复的折叠思维链里呈现（跑完切回来也能看到本次整理做了什么）
        if (activeRoomIdRef.current !== rid) return;
        const saved = await queueRoomWrite(rid, () =>
          repos.updateSession(rid, (cur) => {
            const msgs = cur.messages.slice();
            for (let i = msgs.length - 1; i >= 0; i--) {
              if (msgs[i].role === "char") {
                msgs[i] = { ...msgs[i], notes: [...(msgs[i].notes ?? []).slice(-30), line] };
                break;
              }
            }
            return { ...cur, messages: msgs };
          }),
        );
        if (saved && activeRoomIdRef.current === rid) {
          setRooms((prev) => roomSort(prev.map((r) => (r.id === rid ? saved : r))));
        }
      },
    }),
    [],
  );

  const organize = useCallback(
    (mode: "manual" | "auto") => {
      const roomId = activeRoomIdRef.current;
      if (!roomId) return Promise.resolve();
      return startOrganize({ roomId, io: organizeIO, sceneTitle: sceneTitleRef.current || "（未知场景）", mode });
    },
    [organizeIO],
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
        userName: personaName(nf.personaId || personas.find((p) => p.isDefault)?.id || ""),
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
    // M5 留底：先自动导出一份 jsonl 落盘（磁盘旧快照不会被删，双保险）
    try {
      downloadText(roomFileName(room.name ?? "", room.id), exportJsonl(room, assembly?.setup.charName ?? "角色"));
    } catch {
      /* 留底失败不拦删除 */
    }
    await repos.deleteSession(room.id); // 级联删 roomId 台账（repos 层单事务保证）
    setRooms((prev) => prev.filter((r) => r.id !== room.id));
    if (activeId === room.id) setActiveId(rooms.find((r) => r.id !== room.id)?.id ?? "");
  };

  const renameRoom = async () => {
    if (!renameId) return;
    const room = rooms.find((r) => r.id === renameId);
    if (room && renameVal.trim()) await saveRoomDirect(room, { name: renameVal.trim() });
    setRenameId("");
  };

  /** 列表上不依赖 activeRoom 的直改（重命名/标记等）：走链 + 事务读-改-写，不碰在飞的消息 */
  const saveRoomDirect = async (room: RPSession, patch: Partial<RPSession>) => {
    const saved = await queueRoomWrite(room.id, () => repos.updateSession(room.id, (cur) => ({ ...cur, ...patch })));
    if (saved) setRooms((prev) => roomSort(prev.map((r) => (r.id === saved.id ? saved : r))));
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

  /** 台账面板改动后刷新注入用正典（房间+作品级） */
  const refreshCanon = useCallback(async (roomId: string) => {
    const cur = await repos.getSession(roomId);
    if (!cur) return;
    const [rc, pc] = await Promise.all([repos.listLedger(cur.projectId, "confirmed", roomId), repos.listLedger(cur.projectId, "confirmed", "*")]);
    setRoomCanon(rc);
    setProjectCanon(pc);
  }, []);

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
          userName: personaName(personas.find((p) => p.isDefault)?.id ?? ""),
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
            {roomLocked && (
              <div className="panel" style={{ fontSize: 12, borderColor: "#e65100", color: "#e65100" }}>
                🔒 这个房间正在<b>另一个标签页</b>里使用，本页已置为<b>只读</b>（两边同时聊会互相覆盖历史）。请回到那个标签页继续，或关掉它后重进本房间。
              </div>
            )}

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
                    userName={persona?.name?.trim() || activeRoom.userName || "读者"}
                    sceneLabel={assembly.sceneTitle}
                    greeting={assembly.greeting}
                    initial={
                      activeRoom.messages.length
                        ? {
                            turns: activeRoom.messages.map((m) => ({
                              id: m.id,
                              role: m.role,
                              name: m.name,
                              content: m.content,
                              ...(m.reasoning ? { reasoning: m.reasoning } : {}),
                              ...(m.notes?.length ? { notes: m.notes } : {}),
                            })),
                            summary: activeRoom.rollingSummary ?? "",
                          }
                        : null
                    }
                    initialBudget={{ budgetTokens: activeRoom.config?.budgetTokens ?? 8192, reserveTokens: activeRoom.config?.reserveTokens ?? 768 }}
                    disabled={roomLocked}
                    onPersist={(turns, summary, allowClear, allowFold) => void persist(turns, summary, allowClear, allowFold)}
                    onAutosave={(turns, summary) => void autosave(turns, summary)}
                    onBudgetChange={(b, r) => void saveRoom({ config: { ...activeRoom.config!, budgetTokens: b, reserveTokens: r } }).then(() => {
                      prefsRef.current = { ...prefsRef.current, budgetTokens: b, reserveTokens: r };
                      savePrefs(prefsRef.current);
                    })}
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

                <RoomLedgerPanel
                  projectId={activeRoom.projectId}
                  roomId={activeRoom.id}
                  snapshot={activeRoom.script ?? null}
                  onChanged={() => void refreshCanon(activeRoom.id)}
                />

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

