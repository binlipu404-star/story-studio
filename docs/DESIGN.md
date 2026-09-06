# Story Studio — 设计说明与自我剖析（审阅版）

> 版本锚点：git HEAD ≥ `4557e25` 之后的 v4 轮（人物卡/世界书升级为顶层全局资产库 + 规模化 UI 加固，随后 GitHub 公开部署）。src 共 50 个 ts/tsx 文件、约 1.5 万行；逻辑测试基线 **756 断言 / 22 个测试文件**（v4 新增 16 条 flow/library.ts 可见集断言；真实 PNG 卡不入库，未设 `SS_TEST_PNG` 时 5 条 PNG 断言转为 2 条 skip，即 CI 上 total=751 skipped=2 failed=0）。此前 718→716 的唯一减少来自删除死函数 `rpSystemPrompt` 附带的 2 条其专属断言，属删死代码的合理收缩，非覆盖退化。
> **术语对照**：产品把剧场的长期 RP 单元称为**「剧组」**（旧称「房间」，UI/文档已全量更名）。代码标识符与持久化键**保留 room 词根不动**（`activeRoom`/`queueRoomWrite`/`RPSession.kind:"theater"`/`ledger.roomId`/`prefs.lastRoomId` 等——改持久键需数据迁移，收益低风险高，明确不做）。读到「剧组」↔`room*` 并存即是此决策，不是遗漏。派生动词随隐喻走：开房→**开机**、整房重来→**整组重来**。
> 本文档面向接手审阅的 AI/工程师。所有陈述均以仓库代码为准，标注了文件与行级线索；第 12 节是自认缺陷清单，请优先审阅该节。
> 配套文件：`docs/ROADMAP.md`（里程碑史）、`README.md`（入口）、仓库根 `验收清单.md`（人工验收步骤，含 v3.1 手测清单）。

---

## 1. 产品定位与核心设计理念

**一句话**：纯浏览器端（无后端）的 AI 互动小说创作工具：构思访谈 → 总纲/细纲 → 角色/世界书 → 试跑（RP）→ 复盘回填 → 台账正典，兼容 SillyTavern（下称 ST）生态导入导出。

四条不可动摇的设计公理（贯穿全部代码，审阅者可拿它们检验任何实现是否"出轨"）：

1. **三条事实轴分离**：大纲树 = "意图"的唯一事实源；台账 = "已发生事实"的唯一事实源；RP 对话记录 = 底稿（原始素材）。三者各有独立生命周期，禁止互相静默改写。
2. **提案制**：一切 AI 产出先进 `proposed`，用户确认（`decide`）后才 `confirmed` 生效。`flow/snapshot.ts` 头注释明确：**只有 confirmed 台账进快照/欠账判定——未裁决的不是事实**。（已知张力见 §12.8：场记降级路径的例外。）
3. **副本隔离**（v3 剧场独立化的核心决策）：RP 剧组只认剧本**副本** `ScriptSnapshot`。主纲改动永不自动渗透进剧组（full 模式仅提示"可同步"，用户点按才刷新；chapters 模式连提示都无）；节拍完成标记只写 `room.progress`，**永不回写** `OutlineNode`。理由：聊天进行到一半时主纲被改会造成叙事精神分裂，这是产品级 bug 而非特性。
4. **允许残缺**：任何大纲节点可独立存在、独立试跑；没有"必须先完成访谈才能往下"的门禁。

**产品形态**：五页签单页应用（作品 / 🎭RP 剧场 / 画像 / 设置 / 调试台），无路由库，页签状态在 `App.tsx` 的 `useState` 里；深层页间跳转走两条总线（§8.6/§8.7）。

---

## 2. 总体架构

### 2.1 分层与依赖规则（自上而下）

```
pages/        页面层（9 个页面，组合一切；允许直接 import 任何下层）
components/   可复用组件（RpRunner / RoomLedgerPanel / JobMonitor / SettingsPanel）
flow/         ★ 纯逻辑编排层（20 个模块：rp/theater/script/agent/agentrun/snapshot/…）
st/           ★ ST 兼容层（card/lorebook/matcher/chatlog/persona —— 纯逻辑）
ai/           ★ AI 接入层（client 流式 / prompts 模板 / json 容错 / tokenizer / config）
store/        持久层（db.ts Dexie 声明 / repos.ts 门面 / templates.ts 种子数据）
core/         types.ts 共享契约 + jobBus.ts 任务总线
```

依赖方向纪律（部分靠约定、部分靠编译面物理强制）：

- `core/types.ts` 是**共享契约**：全库只许 `import type` 引用它；文件头明文"修改本文件须由集成者（主代理）统一执行"——这是多人（多子代理）并行开发时代留下的规约，审阅时可视为主线程单点演化的痕迹。
- `dexie` 的运行时 import 只允许出现在 `store/db.ts` 与 `store/repos.ts`（db.ts 头注释）。
- 页面层不直接触碰 `db.xxx` 表，统一经 `repos.ts` 门面（41 个导出函数）。

### 2.2 纯逻辑/UI 双域——本项目最重要的可测试性设计

`tsconfig.logic.json` 物理划出"纯逻辑域"：`src/core/types.ts`、`src/st/**`、`src/flow/**`、`src/ai/{json,tokenizer,prompts}.ts`。这些模块：

- 编译到 `dist-test/`（ESM），由 Node 直接 import 跑测试；
- **不得 import React / Dexie**；localStorage 只允许以"注入的薄壳"形式出现（`prefs.ts`/`handoff.ts`/`progress.ts` 内部有 `storage()` 探测，Node 下静默无操作）；
- 域内模块互相 import 必须带 `.js` 后缀（Node ESM 要求），**页面层不带**（Vite 解析）。这条不对称规则是全库强制约定，新代码漏后缀会在 `build:logic` 或运行时报错，但审阅时请先理解再"纠错"——不带后缀出现在 `flow/**` 才是 bug。
- `src/ai/client.ts` 与 `src/ai/config.ts` **不在**纯逻辑域（client 依赖 fetch/SSE）；`client.ts` 因此被 flow 域以 `*.js` 后缀 import（`agentrun.ts` 即如此），测试从不调用它。

### 2.3 运行时形态

- Vite + React 18 + TypeScript strict（`useDefineForClassFields:true`，此开关直接影响了 Dexie 表声明写法，见 §3.1 注释——这是一个真实踩过并写进注释的坑）。
- **无后端**：AI 请求由浏览器直连用户在设置页填写的 OpenAI 兼容端点（`vite.config.ts` 头注释：不允许 CORS 的端点属于桌面壳阶段能力，当前不可用）。
- 持久化三级：IndexedDB（Dexie，作品数据）→ localStorage（配置/偏好/进度/交接）→ File System Access API（可选的本地 jsonl 自动落盘）。
- 开发环境：Node v24，Windows；git 提交信息为中文长消息、里程碑粒度（每个 commit 自带完整语义，`git log` 即编年史）。

---

## 3. 数据模型

### 3.1 Dexie（IndexedDB）schema v4

库名 `story-studio`，8 张表（`store/db.ts`，注释详尽，建议审阅者直接读源）：

| 表 | 索引 | 说明 |
|---|---|---|
| projects | id, updatedAt | 作品；StoryBible 内嵌（体量小、整体版本化方便）；v4 增可选 castIds/loreIds（全局资产选用列表） |
| outlineNodes | id, projectId, [projectId+parentId], [projectId+level] | 大纲树 |
| characters | id, projectId | 角色（含 ST 卡原文 rawCard）；**v4 起为全局资产库**，projectId=主场作品（''=全局直建），仅溯源用 |
| loreEntries | id, projectId, [projectId+uid] | 世界书词条（ST 语义整型 uid）；**v4 起为全局资产库**，语义同 characters；uid 改为全库一条序列取号（复合索引退役但保留，零迁移） |
| sessions | id, projectId, kind | RP 会话/剧场剧组（kind="theater" 过滤） |
| ledger | id, projectId, [projectId+status], roomId | 台账（roomId 稀疏索引：作品级行无此键） |
| personas | id, updatedAt | 用户画像（全局跨作品，v2 增） |
| meta | key | 元数据（v4 增：FSA 目录句柄等，句柄作纯 value 不建索引） |

必须知道的 IndexedDB 语义坑（已写进源码注释）：

- 表字段用 `declare` 而非 `x!: Table<...>`：`useDefineForClassFields:true` 会把未初始化 `!` 字段编译成 `defineProperty(x, undefined)`，**覆掉 Dexie 构造期装好的表属性**。
- 复合键不接受 `null`：根节点（parentId=null）不入 `[projectId+parentId]` 索引，取根走 `[projectId+level]="volume"`（`repos.childrenOf` 由此实现）。

版本演进：v1 六表 → v2 personas → v3 sessions.kind + ledger.roomId（剧场独立化）→ v4 meta。**所有新增字段一律可选，无迁移代码**——旧数据缺字段即"未启用"语义，这是有意的向下兼容策略。

### 3.2 核心实体速览（`core/types.ts`，325 行，逐字段有注释）

- **Project**：title/synopsis/bible/lorebook + **v4 可选 castIds/loreIds**（从全局资产库选用的外部 id 列表；缺失 ⇔ 旧数据 = 只用自有资产）。删除选用列表不删资产本体；资产被删时门面同事务从各作品选用列表摘除引用。（曾有 `schema` 版本占位字段，因无任何读写方已于 94832dc 删除，见 §12.2。）
- **StoryBible**：`BibleField[]`（key 稳定键 + group 分组 + status: empty|rough|confirmed|**stale** + deps 依赖键）+ `BibleRevision[]`（修订前全量快照）。stale 传播逻辑在 `flow/interview.ts:mergeBibleUpdates`——上游字段变更时把 deps 引用它的字段标 stale，这是访谈页"哪里过期了"红点的来源。
- **OutlineNode**：四级 level（volume/chapter/scene/beat）、order 排序、intent 叙事目的、beats、cast、foreshadows（setup/payoffIn/status）、status 五态（idea→draft→refined→tested→locked，`flow/outline.ts:canTransition` 定义合法迁移）、revision 计数。
- **Character**：profile 五件套 + greeting/mesExample + `rawCard` 原样保留（**roundtrip 无损原则**：导入的 ST 卡导出时应一致）。v4 起 `projectId` 语义 =「主场作品」（溯源；全局页直建的卡为 `''`），可见性由 `Project.castIds` 决定（§8.9）。（曾有 `state`（台账动态状态摘要）与 `nick`（{{char}} 昵称）两字段，因无生产者/消费者已于 94832dc 删除，见 §12.2。）
- **LoreEntry**：完整 ST 语义映射（keys/secondaryKeys/constant/selective/caseSensitive/matchWholeWord/position/order/depth/sticky/group/scoring 等，见 types L111-138）。v4 起同 Character：全局资产 + 主场语义（§8.9）。
- **RPSession = "剧组"**（§7.2 细说）：基础字段（cast/userName/messages/rollingSummary/status）+ v3 剧组字段（kind/name/pace/scopeMode/sandbox/script/progress/config 快照）+ v3.1 增 `messagesArchive`（折叠留底）与 `RPMessage.reasoning/notes`。
- **LedgerRecord**：五类 type（event/item/relation/foreshadow/worldstate）+ actors（**名字字符串，无外键**）+ provenance{sessionId,msgId} 溯源 + roomId 绑定。
- **Persona**：全局画像，isDefault 全局至多一条（`repos.setDefaultPersona` 保证）。
- **AppConfig**：writer/analyzer 双端点（baseURL/model/apiKey/temperature/maxTokens），localStorage 持久，**不进 Dexie**。

### 3.3 localStorage 键名空间（全部经 grep 核实）

| 键 | 归属 | 内容 |
|---|---|---|
| `story-studio.config` | ai/config.ts | AppConfig（API key 明文，见 §12.13） |
| `ss.theater.prefs` | flow/prefs.ts | 剧场偏好（v1 版本号字段，parsePrefs 宽容校验永不抛） |
| `ss.jump.{theater,recap,correction}` | flow/handoff.ts | 一次性投递箱（消费即删，TTL 10min） |
| `ss.progress.*` | flow/progress.ts | 页面进度记忆（仅 id/小草稿；隐私模式即失，已知边界） |

**prefs 与剧组 config 的关系**（易误解点）：prefs 是"下次开新组的初值"；剧组 `config` 是开台时落下的**快照**，之后各改各的、互不污染——这是"切剧组配置不串"的实现根基。

---

## 4. AI 接入层（`src/ai/`）

- **双角色**：`ChatRole = "writer" | "analyzer"`。writer 产文笔（RP/大纲草稿），analyzer 做抽取判断（复盘/摘要/场记）。两路各自独立端点，设置页可指不同模型。
- **`chat()`**：OpenAI 兼容 `/chat/completions`，SSE 流式解析，回调 `onToken/onReasoning`（推理模型的思维链单独通道），支持 abort。
- **`chatJSON<T>()`**：chat + `ai/json.ts:extractJson` 容错抽取（剥代码围栏/截最外层 {}[]/截尾逗号修复——测试 `prompts.test.mjs` 有覆盖）。
- **`chatTools()`**：function-calling 多轮循环；端点不返回 `choices[0].message.tool_calls` 或首请求即 4xx 时抛 **`ToolsUnsupportedError`**（专类异常）——这是场记降级的触发信号，不是通用错误。
- **`estimateTokens()`**：启发式——CJK 每字 1 token，其余每 4 字符 1 token，偏保守。**不是**任何真实分词器（§12.4）。
- **`prompts.ts`**（420 行）：全部模板集中地——访谈（interviewSystemPrompt 输出 BibleUpdate JSON）、总纲（MASTER_OUTLINE_SPEC JSON 协议 + masterToNodes 解析）、共创教练、幕拍生成、滚动摘要双版本（rollingSummaryPrompt 纯摘要 / rollingDigestPrompt 摘要+台账抽取）、试跑包（trialGreeting/trialAuthorNote/personaPromptBlock）、复盘（sessionRecapPrompt 输出节拍命中 JSON）。中文模板，指令措辞即产品语气。
- ~~已知冗余：`prompts.ts` 里另有一个 `rpSystemPrompt(RpSystemOpts)` **无任何调用者**（死代码，与被使用的 `flow/rp.ts:rpSystemPrompt` 同名不同物，见 §12.1/§12.3）。~~ 已删（94832dc）。

---

## 5. ST 兼容层（`src/st/`）

设计原则：**导入宽容，导出严格，roundtrip 保真**。

- **card.ts**：`importCardBytes` 按扩展名分流（PNG 手动遍历 chunk 扫 `tEXt(keyword="chara")` 基64 → `extractPngCardJson`；**不解析 zTXt 压缩块**——现实卡几乎都是 tEXt，属已知边界；JSON 直读）。`parseCardJsonText` 归一 v1/v2/v3 → `ParsedCard`（含 extensions 与内嵌 character_book 规范化）。`exportCardV2` 从 Character 回写 V2 卡 + 可选 book。`extractParenLabeledFields`/`appearanceFallback` 处理国产卡把外貌塞 description 的 `（外貌：…）` 惯例——这是"面向真实脏数据"的典型例子，值得审阅注意其解析优先级。
- **lorebook.ts**：`lorebookDefaults`（ST 全局参数默认值）/ `normalizeLorebook`（任意版本 world book → RawLorebook）/ `toLoreEntries`（→ 内部 LoreEntry）/ `exportLorebookGlobal` 与 `exportEmbeddedBook`（反向导出）。
- **matcher.ts**（触发引擎，全库算法密度最高）：`matchLore(entries, settings, ctx, estimate)` 实现 keys/secondaryKeys+selective（AND/NOT-ANY/NOT-ALL）/constant/caseSensitive/wholeWord/position(before_char、after_char)/order 排序/**depth 注入位**/**sticky+cooldown**/**group 打分（显式启用才计，后幕优先）**。sticky/cooldown 是**有状态定时语义**：实现为"以整段历史确定性地重放状态机"（L215 注释），而非存计数器——好处是无状态可重放、可测（`matcher-timed.test.mjs` 专测），代价是每次全史重算。`random` 从 ctx 注入以便测试确定性。
- **chatlog.ts**：ST chat 的 jsonl（`tavern-cards-chat-history` 头）解析与**反向导出** `toStChatJsonl`（mes/message 双写以兼容自家解析器吃回——导出物能被自己的导入器读回是显式测试目标）。
- **persona.ts**：角色卡/JSON → Persona 种子（`personaSeedToPersona`，isDefault 由调用方裁决后经 repos 落库——种子转换与全局唯一性裁决分离）。
- **outlinebook.ts**（flow 域）：把大纲幕序列编成 ST worldbook——幕粒度词条、`{{char}}/{{user}}` 宏保留、节拍键提取（`extractBeatKeys` 从拍文挑 ≤3 个触发键）、专属组名 STORY_GROUP 与协议声明（STORY_PROTOCOL 声明"已演退场=场间换书"等调度语义，曾按 ST 源码真相修正过一次——commit `893b3e2`）。

---

## 6. RP 引擎（`flow/rp.ts`，400 行，核心中的核心）

### 6.1 system 组装：分节 + 优先级 + 永不裁名单

`rpSystemSections(setup, loreBefore, loreAfter)` 产节。**priority 数字 = 超预算裁切顺序（小者先裁）；NEVER=永不裁**。当前全表：

| key | 中文段名 | priority | 备注 |
|---|---|---|---|
| roleDirective | 角色扮演主指令 | NEVER | ST 风默认指令 |
| extra | 本幕指引 | NEVER | 导演指令/纠偏也走此位（经 composeAuthorNote 合成） |
| pace | 推演节奏 | NEVER | tight/loose 两档指令 |
| bible | 构思档案 | **4** | v3.2 新增：作品定位要素固定注入（题材/文风/视角/世界/主角/冲突，纯函数确定性截断）。位置刻意在 loreBefore **之前**——世界书命中每轮在变，system 字节前缀在它那里断裂，档案摆断裂点之前的稳定区才吃得到供应商前缀缓存；裁序比 examples 还低（预算吃紧先丢作者意图，保剧组正典/副本） |
| loreBefore | 世界书·背景 | 10 | |
| card | 角色卡 | NEVER | description/personality/scenario 拼合 |
| persona | 用户画像 | **30** | 可裁！`【{{user}}（由用户扮演）】` |
| userNameHint | 用户实名 | **NEVER** | v3.1-⑤ 补强：画像名与历史旧称呼冲突时纠口 |
| ledger | 台账快照 | 40 | 剧组正典 |
| script | 剧本副本 | 45 | 沙盒组无 |
| examples | 对话范例 | **5** | 第一个被裁；带"禁止逐字复述"护栏 |
| loreAfter | 世界书·补充 | 15 | |
| authorNote | 作者注释 | NEVER | 标注"优先级最高但不得违反以上规则" |

（summary 不在 sections：`rpAssemble` 把它作为独立 system 消息追加，注释明文"**它就是记忆本体**"，永不裁。）

### 6.2 宏

`applyMacros` 支持 `{{char}}`/`{{user}}`（大小写不敏感），对 card/persona/examples/authorNote/userNameHint 等节逐一展开——**每轮装配现算**，名字永远新鲜；但历史消息正文里的旧称呼是落库文本，宏管不到（§6.5）。

### 6.3 `rpAssemble` 预算管线（两阶段裁切）

输入 setup+turns+{budgetTokens=8192, reserveTokens=768, keepTurns=6, depthOverride, random}。流程：matcher 命中 → 分节 → token 逐节计 → ①超预算时循环裁"可裁节"（priority 升序、同级先裁大的）→ ②仍超则从最旧裁历史（保最近 keepTurns 条兜底；裁剩首条挂"已裁 N 条（滚动摘要兜底）"note）→ 裁无可裁仍超 → `overflow=true`（**照发不拦**，UI 警示）。输出含 `sections` 预览计划（每节 kept/tokens/note），驱动 RpRunner 的彩色 token 条。

### 6.4 滚动摘要

`planRollingSummary(turns, {threshold, keep})` 纯函数决定折叠分界（RpRunner 侧参数 ROLL_THRESHOLD=2500 tokens / ROLL_KEEP=8）；折叠时 analyzer 走 rollingDigestPrompt：产新 summary + 抽取台账事实（`sanitizeDigest` 清洗 → onDigest 回调入剧组正典）。**v3.1-⑥ 后折叠不删原文**：被折回合挪入 `RPSession.messagesArchive`（只增，永不回注对话）。

### 6.5 已知张力（v3.1-⑤ 的成因，用户实际报障）

历史消息发给模型时只有 `{role, content}`——**turn.name 不进请求体**（rp.ts L277-283）。名字的全部影响力来自：system 各节宏（新鲜、正确）+ 历史正文里的散文式称呼（落库、可能陈旧）。旧剧组/旧画像时代的称呼被几十楼历史反复示范，对模型的示范效应压过单条 system 指令——这就是"AI 不认人设名"的机理。缓解 = `userNameHint`（NEVER 级指令：历史称呼是旧记录、从现在起统一改口、正文不许解释改名）。**缓解而非根治**：落库历史正文不改写（那是记录本体）；根治手段是导出留底后"重新开始"。审阅可评估：往历史消息注入 name、或改写旧正文，都曾被考虑并因"污染记录/破坏 roundtrip 原则"否决。

---

## 7. RP 剧场（v3 独立化 + v3.1 安全加固）——最大子系统

### 7.1 剧组模型

剧场是**跨作品的独立页签**：`RPSession.kind==="theater"` 的剧组列表（左栏），每剧组自带：剧本副本 script、推进 progress、正典（ledger.roomId 绑定）、config 快照（charId/personaId/预算/cadence/borrowProjectLedger/chapterIds/agentEnabled/cadenceMark）。三态模式：`full`（全本副本+感知主纲更新提示）、`chapters`（选章副本、对主纲不敏感——试跑用）、`sandbox`（无剧本自由即兴，greeting 为模板生成）。`flow/theater.ts:assembleRoom` 三路径装配出 `RpSetup+greeting`（lead 人卡路径 / 旁白路径=合成叙述者指令 / 沙盒路径），并注入 scriptBlock（副本+进展备忘 progressMemoText）与 ledgerBlock（本剧组正典，可另借作品级）。

### 7.2 场记 agent（v3 的"管家"）——物理最小权限设计

- **7 工具白名单**（`flow/agent.ts:SCRIPT_TOOLS`）：read_outline（只读**副本**）/ get_progress / mark_beat（只写 room.progress）/ where_is_story / next_step / read_ledger / append_ledger（写剧组正典）。**没有任何修改主纲的工具存在**——"场记不改主纲"不是靠提示词恳求，是靠工具面板上根本没有那把枪（SCRIPT_KIT_DIRECTIVE 同时向模型声明此边界）。
- `runScriptTool(ctx, name, argsJson)` 纯函数执行器：参数校验、错误文本回给模型自我修正，Node 可测（agent.test.mjs 30 断言）。
- **`flow/agentrun.ts`：模块级 run 注册表**（v3.1-① 的解法）。切顶层页签会卸载 TheaterPage——老实现里整理任务死在组件闭包里。现在 run 挂在模块级 `Map<roomId, AgentRunState>` 上：每个工具调用**即时**落库（经注入的 `OrganizeIO` 通道，不依赖组件存活）；页面重挂载 `subscribeAgentRun` 即重连活动流（当前步全量回放）；同剧组幂等防双跑；steps 环形缓冲 60 条。依赖全部注入（io + chatTools），本模块不碰 React 不碰 Dexie——这是全库依赖注入最干净的一处。
- 轮次：手动 maxRounds=4 / 自动=3；喂最近 24 条非空消息。`ToolsUnsupportedError` → **降级**：rollingDigestPrompt 纯摘要，抽取的台账**直接 confirmed 进正典**（用户明示决策，但违背公理 2——见 §12.8）。

### 7.3 楼层定时

`planLedgerCadence(userFloorsSinceLast, cadence)`（script.ts 纯函数）：每 N 个用户楼层自动整理；`config.cadenceMark` 是触发游标；cadence=1 默认（每楼自动）；RpRunner `onAssistantSettled(content, floorCount)` 驱动。

### 7.4 本地自动写盘（`flow/fsauto.ts`）

File System Access API 目录句柄存 Dexie meta（刷新后重连需用户手势授权——浏览器硬约束）。`RoomDiskWriter` 类：**每剧组串行写链** + 去抖 + 同名临时文件原子 rename + 句柄失效自动重连；`doWrite` 返回 `Promise<boolean>`，失败写回 pending 队列下轮重试（v3.1 修补）。文件名 `roomFileName(name, roomId)` 消毒去撞名。不支持的浏览器（Firefox/Safari）整体降级为手动导出 jsonl。

### 7.5 v3.1 写安全架构（⑥——本库最近一次、也是最重要的攻坚）

失血史（审计提交 9e454eb 修了 9 处）：流式/并发/切页任一时序都可能让"旧整行覆盖新行"。现行不变量集（全部在 TheaterPage/RpRunner/repos 三层协同）：

1. **单链串行**：所有剧组写必须走 `queueRoomWrite(roomId, fn)`（TheaterPage L301，Map<roomId, Promise 链>）——同一剧组的写永不交叠。
2. **读改写事务**：链内一律 `repos.updateSession(id, cur => …)`（repos L436，Dexie 事务内基于**最新行**合并），禁止拿着页面渲染态整行 save。
3. **截断守卫**：`suspiciousShrink(base, msgs, allowClear, allowFold)`（TheaterPage L364）：新消息数明显少于库内（超过 max(2, 50%)）且未获显式放行 → **拒写**并提示。`onPersist(turns, summary, allowClear, allowFold)` 四参透传——restart（用户确认清空）给 allowClear，折叠给 allowFold，其余路径恒 false。
4. **折叠留底**：allowFold 时被折回合并入 `messagesArchive`（TheaterPage L383-391，按 id 去重追加，永不回注）。
5. **稳定 id 端到端**：`RpTurn.id`（newTurnId，crypto.randomUUID 兜底时间戳）→ 持久化为 RPMessage.id → turnsToMessages **按 id 对齐**（无 id 旧数据按索引回退）——编辑/删除/并发写不错位。
6. **双标签页锁**：`navigator.locks.request('ss-rp-room-'+id, {ifAvailable:true})`（TheaterPage L152-159）拿不到 → 整页**只读** + 🔒 横幅 + RpRunner disabled。**不支持 locks 的浏览器不拦（老行为）**——已知边界。
7. **流式半句保护**：autosave 600ms 去抖 + pagehide/visibilitychange 立即 flush；regen 失败路径 `preserve` 参数还原现场，末条为 char 时转 swipe 候选（边角修复 0ecf190）。
8. **greeting 重水合守卫**（M4）：greeting prop 变化但本地已有用户楼层（id 集比对）→ 跳过重水合，不吞对话。
9. **删除保护**：删剧组先自动导出 jsonl 再 confirm；删末条消息 confirm。

**审阅要点**：这 9 条只有 1/2/3/4/5 有纯逻辑测试间接覆盖（经由可测函数），6-9 活在 React 生命周期里**无自动化测试**（§12.15）。

### 7.6 用户名 = 画像名（⑤）

数据流：`assembleRoom` 每轮现算 `uname = persona?.name?.trim() || room.userName || "读者"`（theater.ts L114），喂 setup.userName、宏、greeting 模板、userNameHint。UI 侧配置条有画像下拉（切换即写 personaId **并同步 userName**，v3.1-⑤ 补）。`AppConfig.userName` 已从类型删除（types L318 注释）。残留语义债：`room.userName` 回落链在"画像被删/personaId 为空"时仍可能供出陈旧名——`|| room.userName` 是旧剧组兼容与 staleness 风险的同一体（§12.6）。

### 7.7 剧场 UI 交互清单（TheaterPage 1105 行 + RpRunner 696 行 + RoomLedgerPanel 260 行）

左栏：新建（三态模式表单）/切换/重命名/删除（自动导出）/⬇jsonl 导出/进度记忆。配置条：节奏 / 借作品级台账 / 场记 agent 开关 / **画像** / 楼层定时 / 正典计数。右栏 RoomLedgerPanel：剧组正典列表 + 作品级提案裁决区 + "引入作品正典"桥。聊天区（RpRunner）：token 预算条（可编辑，onBudgetChange 500ms 去抖落剧组+prefs）/ system 预览 / 🧠 思维链折叠（reasoning + 场记 notes）/ swipe ↔ / 任意楼层编辑 / 删末条 / 重新生成 / 折叠摘要 / 重新开始 / 带回复盘 / 纠偏注入（限 3 条自动退旧）。

---

## 8. 作品管线（Interview → Outline → Trial → Recap；人物卡/世界书 v4 起是全局库，§8.9）

### 8.1 访谈（InterviewPage + flow/interview.ts）

AI 开放式访谈边谈边长草稿：`interviewSystemPrompt` 要求模型输出 `BibleUpdate[]` JSON（`extractJson` 容错）；`mergeBibleUpdates` 纯函数落库前做状态机合并 + **deps→stale 传播**；`firstFocus`/`bibleProgress` 驱动"下一问什么/完成度条"。三线出口：应用建树（masterToNodes）/ AI 填充细纲（空幕批量 3~8 拍）/ 草稿直通世界书。

**v3.2 辅助选材**：右栏头部「辅助选材」折叠面板，跨库勾选本作品的人物卡/世界书词条 + 全局用户人设，每轮以**独立 system 消息**（`interviewMaterialsBlock`，插在访谈 system 之后、历史之前）注入，块头明示"仅为参考，冲突先问作者"。勾选按 **id 升序**排列（与点选先后无关），纯函数渲染 ⇒ 勾选集不变 ⇒ 字节不变 ⇒ 前缀缓存可命中；勾选集合持久化在 `ss.progress.interview.*`（与草稿同批，恢复时原样收下、渲染时自然裁剪已删素材）。

**v3.2 剧场固定注入**：`assembleRoom` 每轮把构思档案的**有值字段**压成 `bibleBlock`（`bibleElementsBlock`：逐字段 160 字截断、总量 1400 字封顶、溢出同序裁尾 + 尾注"计划 vs 实际冲突以实际发生为准"）。作为 `bible` 节进 system（priority 4，位置在 loreBefore 前，理由见 §6.1 表）；剧本组/旁白组/沙盒组三条装配路径全部携带。

### 8.2 大纲（OutlinePage 1497 行——全库最大页面）

四级树；`validatePlacement`（level 层级校验：父必须更粗一级）/`canTransition`（状态机）/`preorder`/`lineageOf`/`sceneSequence` 全在 outline.ts。AI 共创三结构（three-act/kishotenketsu/hero）、`masterToNodes` 把 JSON 草稿映射为节点（**每次均铸新 id**，`opts.uid` 注入；返回 `{nodes, warnings, logline}` 供 `bulkAdd` 一次落库，不支持增量再应用）、`treeToMarkdown` 导出。复盘回填：`applyRecapToNode`（节拍命中→done/改文/新增）与 `reweaveBeats`（按实录重织拍）。

### 8.3 台账闭环（flow/snapshot.ts）

`ledgerSnapshot(nodes, ledger, atNode)` 时间点快照（含轮转预算）；`foreshadowDebt`（伏笔欠账：planted 未 payoff 且已过计划回收点）；`ledgerFacts`/`debtText` 拼注入文本；`sanitizeDigest` 清洗 AI 台账。裁决队列 UI 在 RoomLedgerPanel（作品级 proposed 区，确认才进正典——公理 2 的 UI 化身）。`repos.decide/editLedger/deleteLedger` 门面（editLedger 修正文不动状态——裁决与修订分离）。

### 8.4 试跑包（TrialPage + flow/trialpack.ts + zip.ts + bundle.ts）

`buildTrialPack`：合成叙述者卡（无卡时 synthesizeNarratorCard）+ greeting/note/readme/worldbook → `flow/zip.ts` **手写 stored-zip 写入器**（crc32 自实现；zip 名消毒 safeZipName）→ 一键下载，可进 ST 直接开聊。反向：`chatlog.toStChatJsonl` 导出 → ST 演完 → 导入回复盘。`bundle.ts` 项目整包（大纲 md/档案/台账/卡/世界书/jsonl）。

### 8.5 复盘

`sessionRecapPrompt`（节拍命中 JSON）→ `applyRecapToNode` → 用户裁决改纲或纠偏；`composeAuthorNote(base, directives)`（rp.ts）把纠偏指令合成进 authorNote（限流退旧）。

### 8.6 handoff.ts——页签卸载下的一次性投递箱

页面切换即卸载组件，跨页态走 localStorage 投递箱：**消费即删 + 项目作用域 + TTL 10min**（未来时间戳 >60s 也拒），`parseHandoff` 纯函数逐字段校验（坏投递也清掉）。三动线：剧场带回复盘→试跑自动复盘 / 试跑续写→剧场自动开台 / 复盘纠偏→剧场预填。

### 8.7 nav.ts——顶层页签总线

`goTab(tab)` = `window.dispatchEvent(CustomEvent('ss:go-tab'))`，App 根监听。刻意不引路由库。

### 8.8 jobBus（core/jobBus.ts，156 行）

模块级长任务注册表（startJob/abortJob/useJobs 订阅），JobMonitor 挂 App 根——切页签不消失。批量 AI 任务（细纲填充等）带进度/中止。这是 agentrun 之外的第二个"生命周期脱离组件"模式，两者动机相同实现各自独立（可合并的技术债，§12）。

### 8.9 v4 全局资产库（人物卡/世界书——本轮最大改动）

**菜单结构**：顶层七页 = 作品 / 🎭 RP 剧场 / 👤 人物卡 / 📚 世界书 / 画像 / 设置 / 调试台。人物卡与世界书从作品工作区页签升为与剧场同级的**全局资产库页**（`CastPage`/`LorePage` 不再接受 projectId prop）；作品工作区对应位置换成「📦 资产」面板（`components/ProjectAssetsPanel.tsx`：选用勾选 + 世界书参数——参数本就是作品级 `Project.lorebook`，从旧世界书页迁入）。

**数据模型（零迁移，schema 仍 v4）**：`Character/LoreEntry.projectId` 语义降为「主场作品」（溯源用；全局页直建 = `''`）；`Project.castIds?/loreIds?` 可选 = 外部选用列表，**缺失 ⇔ 旧数据 = 只用自有**。可见集公式：**可见 = 自有（projectId 命中）∪ 选用（id 命中列表）**，纯逻辑在 `flow/library.ts:filterVisible`（只过滤不重排——行序仍归 repos 门面，前缀缓存字节稳定性契约不破）。所有作品侧消费方（大纲出场人物/试跑主演/访谈选材/剧场装配与自动开机）读入口都是 `repos.listCharacters/listLoreEntries`，门面单点换血自动生效。

**引用完整性**：`removeCharacter/removeLoreEntry(s)` 同事务从**所有** Project 选用列表摘除引用；`deleteProjectCascade` **不再删两资产表**（全局资产不随作品消亡），读侧对悬空 id 一律 `?? / find` 容忍。`nextUid` 改全库取号（全表扫最大值；≤数千量级可接受，已注释）。批量启用/禁用、删除整本等全局页操作作用在**当前过滤视图**上，按钮带条数，视图=全库时 confirm 里明说。

**剧场隔离不破**：`assembleRoom` 仍只吃调用方传入的 characters/loreEntries（=该作品可见集），不感知全局库本身——v3 的装配隔离哲学原样保留，只是"调用方 gather 的来源"变了。

---

## 9. 工程惯例（审阅时请按这些约定判卷）

1. **严格门**：`typecheck`（strict + noUnusedLocals + isolatedModules）→ `test:logic`（build:logic + run-tests，**基线 756 只增不减**）→ `build` → git 提交。每步全绿才许提交，commit message 里带测试数（编年史可查 368→413→…→740→756；718→716 是唯一一次经论证的死代码收缩，见版本锚点）。
2. **测试微框架**：`scripts/tests/*.test.mjs` 默认导出 `async (t)`，t={ok,eq,skip}；从 `dist-test/` import 编译产物——测的是真实运行代码而非源码副本。无第三方测试库。
3. **防御式解析**是家法：`parsePrefs/parseHandoff/loadAppConfig/sanitizeDigest/extractJson/parseCardJsonText` 全部"永不抛错，坏数据逐字段回落默认/返回 null"。评审时看到空 catch + 注释是风格而非疏忽（均有注释说明为何可忽略）。
4. **注释风格**：每文件头部块注释讲"为什么+踩过的坑"（useDefineForClassFields 覆表、IndexedDB 复合键 null、vite EBUSY——vite.config `watch.ignored` 即第三坑的疤痕）。
5. **命名**：纯逻辑模块 = 名词域 + 动词函数；React 组件层允许 useCallback/useRef 密布的"钩子面条"（页面层自我克制为零抽象：无组件库、内联样式、单一 index.css）。
6. **fire-and-forget 用 `void` 显式标注**；不可测的浏览器 API（localStorage/navigator.locks/FSA/crypto）一律包薄壳并在 Node 下静默降级。
7. **依赖极简**：运行时只有 react/react-dom/dexie。zip/crc32/tokenizer/json 修复/ST 协议解析全部手写——换取零供应链面与行为可控。
8. **多代理演化痕迹**：仓库由主代理 + 并行子代理写就（types 单点修改规则、注入式 IO 边界都源于此）。提交历史中每个大提交 = 一个完整验收包。

---

## 10. 安全与隐私边界

- **API key 存 localStorage 明文**（`story-studio.config`），请求由浏览器直发第三方端点。对"本地单机创作工具"这是接受的取舍，但：共享机器 = key 泄露面；`.gitignore` 已防 config.json/.env/*tavily* 入库。
- AI 内容全进第三方端点——产品未做任何"不要上传"承诺。
- 无 CSP/无 SRI/无鉴权（纯静态工具）。FSA 写盘范围=用户手选的单一目录。

---

## 11. 性能与容量已知特征

- matcher 每轮全史重放 sticky/cooldown 状态机（O(历史长×词条数)）——百楼级无感，千楼未压测。
- 剧组 messages 整数组随行读写：几百楼 + reasoning 后单行可 >1MB，Dexie 结构化克隆可承受但 autosave 600ms 去抖是必要的。
- estimateTokens 与真实端点分词误差 ±20~40%，预算条仅供预览。
- **v4 全局库规模化**：repos 可见集/全局列表都改 `toArray()` 全表扫后内存过滤（词条数千级 <10ms，可接受；换来的是语义单点收敛）。UI 侧按 100+ 卡 / 500+ 词条审计加固过：列表行 memo（编辑击键不重渲全表）、名称/徽标 ellipsis 三件套、`select{max-width:100%}` 与 `.grid2 minmax(0,1fr)`（防原生 select 长 option 与长内容撑破 232px 剧场左栏/grid 列）、confirm 长名截 20 字、全局页搜索过滤 + 批量操作限当前视图、勾选列表 Set 查找 + 收起不渲染。长列表性能仍属"未压测"档——万级词条需虚拟化，见 §12.17。

---

## 12. 已知缺陷与技术债（严肃自评，请优先审阅）

**死代码/死字段**（1–2 已于 94832dc 清偿，留档备查）
1. ~~`ai/prompts.ts:430 rpSystemPrompt(RpSystemOpts)` 零调用者；且与 `flow/rp.ts:169 rpSystemPrompt` **同名不同物**——极易误读，建议删除或改名。~~ **已删**（连带其 2 条专属测试断言，718→716）。
2. ~~`RPMessage.ooc/branchOf/editedFrom` 三字段无任何生产者/消费者（OOC 与分支树未实现）；`Project.schema` 版本字段无人读写；`Character.state` 闭环浅（台账不自动回写它）。~~ **已删**（含 `Character.nick`、prefs 的 `lastCharId/lastPersonaId/scopeMode` 只写不读、handoff 的 `auto` 死分支）。OOC/分支树若将来实装，按语义重新引入字段即可。
3. 根目录 `scripts/probe-*.mjs`（probe-db-v2 等）是一次性实证脚本，不在测试基线内，价值已兑现但仍在库。

**语义债**
4. `estimateTokens` 是启发式；预算判定与真实上下文窗口无对齐义务。
5. `ss.progress.*` 只存 id/小草稿且 localStorage——隐私模式即失；清浏览器数据即失。设计意图=便利件而非记录。
6. 历史正文中的旧用户名不可被现配置纠正（§6.5）；`room.userName` 回落链在画像被删时供出陈旧名。
7. `suspiciousShrink` 阈值（max(2, 50%)）是启发式——合法的大删除若未经确认路径会被拦（用户会看到拒写提示而非静默丢数据：fail-safe 方向正确，但体验有毛边）。
8. **降级场记把 AI 判断直接写成 confirmed 正典**（agentrun L186-205）——与公理 2"提案制"正面冲突。当时用户明示接受（无工具端点的兜底），审阅者应把它当作有意识的债务而非疏漏，并评估"降级也进 proposed + UI 批量裁决"的改法。
9. 台账 actors 无外键：角色改名后新旧事实的 actors 字符串不聚合，欠账/时间线的"相关者"过滤会漏。

**平台边界（均为环境硬约束下的降级，非代码缺陷但要写进说明书）**
10. `navigator.locks` 不可用（Firefox/Safari/旧 Edge）→ 双标签页同剧组**无保护**，回到 last-write-wins。
11. FSA 仅 Chromium；重授权需用户手势；多标签页共享目录句柄"最后关闭者赢"。
12. CORS 限制：不允许跨源的推理端点不可用（无代理层，无桌面壳）。
13. API key 明文持久在 localStorage（`story-studio.config`）——纯浏览器形态无秘密保管层，共用机器即共见；桌面壳/后端代理是根治路径（见 §2.3 边界）。

**结构性债**
14. 页面巨型化：OutlinePage 1497 / TheaterPage 1105 / TrialPage 944 行；无 ErrorBoundary（任何渲染期异常白屏整页）；无路由（深链不可能）；无组件抽象纪律（内联样式复制粘贴——94832dc 已把跨页**非 UI** 纯工具收敛到 `core/uiUtils.ts`，内联样式与 Badge 仍按纪律留在页内）。
15. **React 层零自动化测试**：756 断言全部覆盖非 UI 逻辑；§7.5 的九条写安全不变量里 6-9 条只靠人工验收（`验收清单.md`）。Dexie 层同样无常规测试（仅一次性 fake-indexeddb probe）。
16. 双"生命周期脱离组件"实现（jobBus 与 agentrun）结构相似未收敛；prefs/progress/handoff 三个 localStorage 壳也各自发明了一次 storage() 探测——可提炼但未提炼（有意识：三处校验语义不同，合并收益低于风险）。
17. **v4 全局库的已知边界**：`listAll*`/可见集全表扫（万级需索引或虚拟化）；`nextUid` 全表扫取号；选用列表读侧悬空容忍但**作品改名/删卡不级联改** OutlineNode.cast 与 RPSession.cast 里的 id（读侧同样容错，语义=历史引用允许悬空）；全局页批量删除按"当前过滤视图"作用——过滤后全选删除与全库删除在按钮文案上区分，但纪律仍是用户自查。项目包导出打包的是**可见集**（含共享自他作品的资产）——ST 通用格式无差别，但"从包里重建全局库"的回灌器尚不存在。

---

## 13. 审阅者验证入口（全部命令在 story-studio/ 下）

```bash
npm run typecheck      # 期望 exit 0
npm run test:logic     # 本机（设 SS_TEST_PNG 指向真实 PNG 卡）期望 total=756 failed=0；CI 无卡时 total=751 skipped=2 failed=0。若你新增测试，只许 >756
npm run build          # tsc --noEmit && vite build
npm run test:fixtures  # 用 docs/fixtures 下真实 ST 样本跑解析器
git log --oneline      # 21 个提交 = 完整编年史（45ef4ab → 94832dc）
```

人工路径：README「快速开始」→ 设置页填一个 OpenAI 兼容端点 → 作品页新建→访谈→大纲→试跑导包；剧场页新建剧组→聊天→观察场记活动流与 token 预算条。

高价值质询点（我们自检时最不确定的三处）：①§7.5 不变量在"regen 中切页签再切回"组合下的真实表现；②matcher sticky/cooldown 全史重放与 ST 实际语义的最后偏差；③userNameHint 纠口在长历史剧组的实际服从率。

---

## 附录 A：文件职责一览（src，50 文件）

- **core/**：`types.ts` 域契约 · `jobBus.ts` 长任务总线 · `uiUtils.ts` 跨页非 UI 小工具（errMsg/isAbort/下载/剪贴板/时间）
- **store/**：`db.ts` Dexie v4 · `repos.ts` 门面（v4 增 listAll*/select*/removeLoreEntries 等全局库函数） · `templates.ts` Bible 字段种子
- **ai/**：`client.ts` SSE/chat/chatJSON/chatTools/ToolsUnsupportedError · `config.ts` 双端点配置 · `prompts.ts` 中文模板全集 · `json.ts` 容错抽取 · `tokenizer.ts` 估算
- **st/**：`card.ts` 卡解析/导出/PNG · `lorebook.ts` 世界书规范化 · `matcher.ts` 触发引擎 · `chatlog.ts` ST jsonl · `persona.ts` 画像导入
- **flow/**：`rp.ts` RP 引擎 · `theater.ts` 剧组装配 · `script.ts` 副本/推进 · `agent.ts` 工具白名单/执行器 · `agentrun.ts` run 注册表 · `snapshot.ts` 台账快照 · `interview.ts` Bible 合并 · `outline.ts` 树逻辑/复盘 · `outlinebook.ts` 剧情世界书 · `trialpack.ts` 试跑包 · `zip.ts`/`bundle.ts` 打包 · `library.ts` v4 可见集纯逻辑 · `handoff.ts` 投递箱 · `nav.ts` 页签总线 · `prefs.ts` 偏好 · `progress.ts` 进度 · `fsauto.ts` 本地写盘
- **pages/**：Projects / Interview / Outline / Trial / Personas / Theater / Playground(调试台) / **Cast（v4 全局卡库页）** / **Lore（v4 全局词条库页）**
- **components/**：`RpRunner` 聊天机 · `RoomLedgerPanel` 台账裁决 · `JobMonitor` · `SettingsPanel` · **`ProjectAssetsPanel`（v4 作品侧选用面板：勾选 + 世界书参数）**

## 附录 B：交互习惯速写（写码者画像）

一切破坏性动作先 confirm；一切外部数据先 parse 后信任；一切跨页态先问"组件会不会死"；一切 AI 输出先 sanitize；一切"事实"先 proposed。UI 文案即产品说明书（错误提示告诉用户下一步做什么，例如 🔒 横幅直接说"回到那个标签页继续，或关掉它重进"）。
