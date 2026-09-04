# Story Studio

AI 互动小说创作工具：**构思访谈 → 总纲/细纲 → ST 试跑 → 台账沉淀**。
本地优先的纯前端应用（Vite + React + TS + IndexedDB），密钥与数据都只在你自己的浏览器里。

## 创作闭环

```
构思访谈（引导式提问，逐字段提案确认，上游改动自动标 stale）
   ↓
总纲生成（三幕/起承转合/英雄之旅）→ 大纲树（卷/章/幕 + 节拍 + 伏笔）
   ↓ 任意一幕，允许只细化到这里
ST 试跑：导出试跑包（卡 + 世界书 + greeting + author's note）→ 去 SillyTavern 演 → 导出 chat 导回
   ↓
自动比对：节拍命中表 / 偏差报告 / 台账提案（道具·事件·关系·伏笔）
   ↓ 三选一
采纳为节拍事实 · 反向修纲草案 · 按总纲提案下一幕
```

## 开发

```bash
npm install        # Node ≥ 20
npm run dev        # http://localhost:5173
npm run typecheck  # tsc --noEmit（全项目零错误是硬基线）
npm run test:logic # 纯逻辑冒烟测试（改过 src/st、src/flow、ai/json、ai/prompts 必跑）
npm run build      # 生产构建（tsc + vite build）
```

## 目录速览

```
src/
├─ core/types.ts     # 域模型契约（改它需全项目回归）
├─ ai/               # client(流式SSE/双模型) json tokenizer prompts(提示词库) config(localStorage)
├─ st/               # ST 兼容层：card(卡导入导出) lorebook(世界书) matcher(匹配引擎) chatlog(chat解析)
├─ flow/             # 纯逻辑：interview(档案状态机) outline(树数学/总纲映射/回写) tripack(试跑包)
├─ store/            # Dexie(IndexedDB) + repos CRUD 门面 + 模板
├─ pages/components  # UI
scripts/tests/*.test.mjs  # Node 冒烟测试（跑编译产物 dist-test/）
```

## 约定（重要）

- **运行时跨文件 import 必须带 `.js` 后缀**（Node ESM 直跑 dist-test 的前提）；纯类型用 `import type`。
- 一切 AI 产出先做**提案**，用户确认才落库；台账 append-only。
- 大纲树=意图唯一事实源；台账=已发生事实唯一事实源；冲突由用户仲裁。
- 数据版本：`Project.schema = 1`，改结构需写迁移。

## 设置

「设置」页配置两个模型端点（OpenAI 兼容 `/chat/completions`，浏览器直连、需 CORS 许可）：
**创作模型**（访谈/大纲草稿/试跑）与**分析模型**（抽取/比对，可换便宜快的）。
DeepSeek 官方兼容端点可直接用；第三方网关未开 CORS 时请在桌面壳阶段配代理。

## 状态

**M0~M4 + M7 已交付；规划 v2 的 N1（台账）/ N2（站内 RP）/ N3（纠偏闭环）/ N6（RP 剧场·自动台账）已落地，N5 完成 bundle 导出与小说化 jsonl 直通。分工已收敛：站内开聊（含纠偏、自动台账）全在「RP 剧场」，「ST 试跑」专管导包/导回复盘，两页经一次性交接互通。**
测试基线：逻辑测试 567 全绿（typecheck 零错误 / 生产构建通过）。
双击 `start-story-studio.bat` 一键启动（http://localhost:5199）。
手工验收步骤见《验收清单.md》，测试素材在 docs/fixtures/（世界书样本、试跑记录样本、真实 PNG 卡在工作区 素材/）。
**施工规划 v2（现状盘点 + N1~N5 新里程碑）见 [docs/ROADMAP.md](docs/ROADMAP.md)**；
原始讨论稿（v0.1，思想存档）在工作区根目录《AI小说创作工具-规划.md》。
