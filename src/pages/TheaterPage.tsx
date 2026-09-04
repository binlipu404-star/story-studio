// ============================================================
// RP 剧场（N5+）—— 脱离 SillyTavern 的本站内「真聊天区」。
// 模拟酒馆交互：选幕 + 选人卡 + 选用户画像 → 按整部大纲组装（greeting 含本场目标与
// 节拍、author's note、世界书每轮重扫、台账快照+伏笔欠账注入 system）→ RpRunner 开聊。
// 自动台账：历史折叠时场记 digest 抽取已发生事实，自动落台账「待确认队列」；
// 「结算本场」可随时全量抽取。AI 只提案——裁决永远在台账页。
// 与「ST 试跑」页的分工：那页负责导出 ST 往返+节拍命中复盘改纲；本页是日常 RP 主场。
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Character, LedgerRecord, LoreEntry, OutlineNode, Persona, Project, RPMessage, RPSession } from "../core/types";
import * as repos from "../store/repos";
import { lineageOf, sceneSequence } from "../flow/outline";
import { buildTrialPack, synthesizeNarratorCard } from "../flow/trialpack";
import type { RpSetup, RpTurn } from "../flow/rp";
import { ledgerFacts, foreshadowDebt, sanitizeDigest, type DigestLedgerItem } from "../flow/snapshot";
import { rollingDigestPrompt, personaPromptBlock } from "../ai/prompts";
import { chatJSON } from "../ai/client";
import { loadAppConfig } from "../ai/config";
import { exportCardV2 } from "../st/card";
import { RpRunner } from "../components/RpRunner";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const NONE_CARD_ID = "__none__";

export function TheaterPage({ projectId }: { projectId: string }) {
  // ---- 数据 ----
  const [project, setProject] = useState<Project | null>(null);
  const [nodes, setNodes] = useState<OutlineNode[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loreEntries, setLoreEntries] = useState<LoreEntry[]>([]);
  const [sessions, setSessions] = useState<RPSession[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [ledgerRecs, setLedgerRecs] = useState<LedgerRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- 开台选择 ----
  const [sceneId, setSceneId] = useState("");
  const [charId, setCharId] = useState("");
  const [personaId, setPersonaId] = useState("");
  const personaDefaultApplied = useRef(false);

  // ---- 场上 ----
  const [rp, setRp] = useState<{ setup: RpSetup; greeting: string; folder: string } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [rpSession, setRpSession] = useState<RPSession | null>(null);
  const rpSessionRef = useRef<RPSession | null>(null);
  const [rpMountKey, setRpMountKey] = useState(0);
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [settleBusy, setSettleBusy] = useState(false);

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
      setProject(proj ?? null);
      setNodes(nd);
      setCharacters(ch);
      setLoreEntries(lore);
      setSessions(ss);
      setPersonas(ps);
      setLedgerRecs(led);
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
  const noCardMode = charId === NONE_CARD_ID;
  const leadChar = noCardMode ? null : characters.find((c) => c.id === charId) ?? characters[0] ?? null;
  const leadSelectValue = noCardMode ? NONE_CARD_ID : leadChar?.id ?? "";
  const persona = personas.find((p) => p.id === personaId) ?? undefined;
  const prevSession = scene ? sessions.find((s) => (s.nodeId ?? null) === scene.id) : undefined;
  const prevSummary = prevSession?.rollingSummary?.trim() || undefined;

  // 注入预览（信息行用）：台账快照规模 + 伏笔欠账数
  const factsText = useMemo(() => ledgerFacts(ledgerRecs, nodes), [ledgerRecs, nodes]);
  const openDebts = useMemo(
    () => foreshadowDebt(nodes, ledgerRecs).filter((d) => d.status === "planted" && !d.paidByLedger).length,
    [nodes, ledgerRecs],
  );

  // ---------- 自动台账：digest 落台账待确认队列 ----------

  const captureRows = useCallback(
    async (items: DigestLedgerItem[]) => {
      if (items.length === 0) return 0;
      const sess = rpSessionRef.current;
      const lastMsg = sess?.messages[sess.messages.length - 1];
      const rows: LedgerRecord[] = items.map((it) => ({
        id: repos.uid(),
        projectId,
        type: it.type,
        content: it.content,
        actors: it.actors,
        ...(sess && lastMsg ? { provenance: { sessionId: sess.id, msgId: lastMsg.id } } : {}),
        status: "proposed" as const,
        createdAt: Date.now(),
      }));
      await repos.addProposals(rows);
      return rows.length;
    },
    [projectId],
  );

  const onDigestCapture = useCallback(
    (items: DigestLedgerItem[]) => {
      void captureRows(items)
        .then((n) => {
          if (n > 0) setCaptureMsg(`自动台账：${n} 条已发生事实进入台账「待确认队列」（台账页裁决）。`);
        })
        .catch((e) => setCaptureMsg(`自动台账写入失败：${errMsg(e)}`));
    },
    [captureRows],
  );

  // ---------- 会话持久化（同「ST 试跑」页的工作会话语义：每幕一条 testing） ----------

  const onPersist = useCallback(
    async (rturns: RpTurn[], sum: string) => {
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
          userName: rp?.setup.userName ?? persona?.name?.trim() ?? loadAppConfig().userName,
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
        // 静默：落库失败不打断聊天
      }
    },
    [projectId, scene, leadChar, persona, rp],
  );

  const rpInitial =
    rpSession && rpSession.messages.length > 0
      ? {
          turns: rpSession.messages.map((m) => ({ role: m.role, name: m.name, content: m.content })),
          summary: rpSession.rollingSummary ?? "",
        }
      : null;

  // ---------- 开台 ----------

  const start = () => {
    setStartError(null);
    setRp(null);
    setCaptureMsg(null);
    rpSessionRef.current = null;
    setRpSession(null);
    if (!scene) {
      setStartError("当前作品还没有可开台的「幕」：先去大纲工作台创建（或用共创访谈搭一个）。");
      return;
    }
    try {
      const byId = new Map(characters.map((c) => [c.id, c] as const));
      const castNames = leadChar
        ? Array.from(new Set([...scene.cast.map((id) => byId.get(id)?.name ?? ""), leadChar.name].filter(Boolean)))
        : Array.from(new Set(scene.cast.map((id) => byId.get(id)?.name ?? "").filter(Boolean)));
      const chain = lineageOf(nodes, scene.id);
      const chapter = chain.length >= 2 ? chain[chain.length - 2] : undefined;
      const enabled = loreEntries.filter((e) => e.enabled);
      const loreBlock = enabled
        .filter((e) => e.constant)
        .map((e) => e.content)
        .filter((c) => c.trim())
        .join("\n");
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
      });
      let setup: RpSetup;
      if (leadChar) {
        setup = {
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
          ledgerBlock: factsText || undefined,
          loreEntries: enabled,
          loreSettings: project?.lorebook ?? { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true },
        };
      } else {
        const narrator = synthesizeNarratorCard({ scene, chapter, castNames, worldview }, built.greeting);
        const nd = (narrator as { data?: Record<string, unknown> }).data ?? {};
        setup = {
          charName: typeof nd.name === "string" && nd.name ? nd.name : "旁白",
          userName: uname,
          description: typeof nd.description === "string" ? nd.description : "",
          scenario: typeof nd.scenario === "string" ? nd.scenario || undefined : undefined,
          personaBlock: persona ? personaPromptBlock(persona) : undefined,
          authorNote: built.authorNote,
          ledgerBlock: factsText || undefined,
          loreEntries: enabled,
          loreSettings: project?.lorebook ?? { scanDepth: 2, tokenBudget: 2048, recursiveScanning: true },
        };
      }
      // 本幕已有 testing 会话 → 续写
      const prior =
        sessions.find((s) => (s.nodeId ?? null) === scene.id && s.status === "testing" && s.messages.length > 0) ?? null;
      rpSessionRef.current = prior;
      setRpSession(prior);
      setRp({ setup, greeting: built.greeting, folder: built.folder });
      setRpMountKey((k) => k + 1);
    } catch (e) {
      setStartError(errMsg(e));
    }
  };

  // ---------- 结算本场：全量 digest（摘要+台账），写回会话 ----------

  const settleScene = async () => {
    const sess = rpSessionRef.current;
    if (!sess || sess.messages.length < 3 || settleBusy) {
      setCaptureMsg("还没什么可结算的：至少聊上几个来回。");
      return;
    }
    setSettleBusy(true);
    try {
      const turns: RpTurn[] = sess.messages.map((m) => ({ role: m.role, name: m.name, content: m.content }));
      const transcript = turns
        .filter((t) => t.role !== "system" && t.content.trim())
        .map((t) => `${t.name}：${t.content.trim()}`)
        .join("\n\n");
      const obj = await chatJSON<unknown>(rollingDigestPrompt(sess.rollingSummary ?? "", transcript), { role: "analyzer" });
      const d = sanitizeDigest(obj);
      const n = await captureRows(d.ledger);
      if (d.summary) {
        const saved = await repos.saveSession({ ...sess, rollingSummary: d.summary, messages: sess.messages });
        rpSessionRef.current = saved;
        setRpSession(saved);
        setSessions((prev) => [saved, ...prev.filter((s) => s.id !== saved.id)]);
      }
      setCaptureMsg(
        `本场结算：台账事实 ${n} 条进「待确认队列」${d.summary ? `，前情摘要更新为 ${d.summary.length} 字` : ""}。去台账页裁决后，这些事实会自动流进后续 RP 与提案的提示词。`,
      );
    } catch (e) {
      setCaptureMsg(`结算失败：${errMsg(e)}`);
    } finally {
      setSettleBusy(false);
    }
  };

  // ---------- 渲染 ----------

  if (!loaded) return <div className="panel">读取剧场数据…</div>;
  if (loadError) return <div className="panel">读取失败：{loadError}</div>;

  return (
    <div>
      <section className="panel">
        <h3>🎭 RP 剧场</h3>
        <p className="muted" style={{ fontSize: 12 }}>
          站内直接演这一幕：按 ST 默认标准组装（世界书每轮重扫·台账快照·伏笔欠账·前情摘要），对话自动落成本幕工作会话，
          历史折叠与「结算本场」会把已发生事实自动送进台账待确认队列。节拍命中复盘/反向修纲请用「ST 试跑」页。
        </p>
        <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
          <label className="field" style={{ minWidth: 240 }}>
            <span>幕（按大纲顺序）</span>
            <select value={scene?.id ?? ""} onChange={(e) => setSceneId(e.target.value)} style={{ minWidth: 240 }}>
              {scenes.length === 0 && <option value="">（还没有幕）</option>}
              {scenes.map((s, i) => (
                <option key={s.id} value={s.id}>
                  {i + 1}. {lineageOf(nodes, s.id).map((n) => n.title).join(" › ") || s.title}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 180 }}>
            <span>人物卡</span>
            <select value={leadSelectValue} onChange={(e) => setCharId(e.target.value)}>
              <option value={NONE_CARD_ID}>🎭 无卡（旁白演绎，自动生成旁白卡）</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name || "（无名）"}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ minWidth: 160 }}>
            <span>用户人设</span>
            <select value={personaId} onChange={(e) => setPersonaId(e.target.value)}>
              <option value="">（不设）</option>
              {personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || "（未命名）"}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={start} disabled={!scene}>
            {rp ? "换配置重开" : "开台"}
          </button>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          已注入正典：台账 {ledgerRecs.length} 条{openDebts > 0 ? ` · 伏笔欠账 ${openDebts} 笔` : ""}
          {prevSummary ? " · 本幕带上一场前情" : ""}
        </p>
        {startError && <p style={{ color: "#b3261e", fontSize: 13 }}>{startError}</p>}
      </section>

      {rp && scene && (
        <section className="panel">
          <RpRunner
            key={`${scene.id}-${rpMountKey}`}
            setup={rp.setup}
            charName={rp.setup.charName}
            userName={rp.setup.userName}
            sceneLabel={rp.folder}
            greeting={rp.greeting}
            initial={rpInitial}
            onPersist={(t, s) => void onPersist(t, s)}
            onDigest={onDigestCapture}
            onBringBack={() => void settleScene()}
          />
          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={() => void settleScene()} disabled={settleBusy}>
              {settleBusy ? "结算中…" : "🧾 结算本场（抽取台账+更新前情）"}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              「带回复盘」按钮在本页等同结算：只抽事实不改大纲。
            </span>
          </div>
          {captureMsg && <p className="muted" style={{ fontSize: 12 }}>{captureMsg}</p>}
        </section>
      )}
    </div>
  );
}
