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

## 部署（GitHub Pages）

纯前端应用：数据在各人浏览器的 IndexedDB 里，AI 端点与密钥在页面「设置」里自配，**服务端零依赖、流水线不需要密钥**。
`.github/workflows/deploy-web.yml` 在 push 到 main 时跑 typecheck + 逻辑测试 + build，全绿才把 `dist/` 发到 Pages
（仓库 Settings → Pages 查看地址，形如 `https://<user>.github.io/<repo>/`）。`vite.config.ts` 的 `base: "./"` 用相对
资源路径，换仓库名/挂子路径都无需改配置。

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

**M0~M4 + M7 已交付；N1~N6 + N5（bundle/jsonl）已落地。v3 剧场独立化完成：「🎭 RP 剧场」是顶层页签（与作品/画像同级），以剧组为单位长期 RP——剧本副本（全本可同步/章选不敏感）、紧凑/舒缓节奏、剧组独立正典、场记 agent（7 工具白名单，物理无主纲写权限）、本地文件夹自动写 jsonl。站内开聊全在剧场，「ST 试跑」专管导包/导回复盘。v3.1 体验修补：场记切页不断+即时落库+截断修复、全系统进度记忆（可一键清除）、预算自动记忆、台账迁入剧场且每剧组独立、用户名随画像、对话历史流式自动保存+破坏操作确认、可折叠思维链（含场记活动）+每楼自动进度标记。v4 全局资产库：「👤 人物卡 / 📚 世界书」升为与剧场同级的顶层菜单——卡和词条是全局数据，每个作品在「📦 资产」页签勾选共用（可见 = 自有 ∪ 选用，零迁移）；删作品不删资产、删资产自动摘除各作品引用；并按 100+ 卡 / 500+ 词条规模加固了列表布局（memo 行 / 省略号 / 搜索过滤 / 批量限视图）。v5 世界书整本书化（schema 仍零迁移）：导入 .json = 一整本书（书名/扫描参数入库，不再拆散成散装词条）；「📚 世界书」页按书卡管理（整本启用/停用总开关、改名、按书导出、删除整本），展开可书内逐条编辑；作品「📦 资产」里**按整本选用**世界书（可选多本，按勾选顺序拼接注入）；旧散装词条首开自动归入「旧版词条」一书。v6 大纲工作台重构（schema 仍零迁移）：删繁就简只剩「✍️ 手动编写 / 💬 对话创作」两视图——树行 ⠿ 拖拽柄随意拖动排序（卷章幕换序、跨章移动、拖进容器成子级，纯函数校验+整组重编号），编辑器补「移动到…」；对话创作整页重做（聊天气泡 + 右侧草稿实时预览树，对话与草稿刷新不丢，「应用到大纲树」弹窗列明细可顺手填节拍）；反「只说不做」红线贯穿大纲与构思访谈两页——每轮显示草稿/提案的真实变化，AI 空口宣称"已完成"而界面无产出时黄条当场戳穿并给重试。**
测试基线：逻辑测试 864 全绿（typecheck 零错误 / 生产构建通过）。
双击 `start-story-studio.bat` 一键启动（http://localhost:5199）。
手工验收步骤见《验收清单.md》，测试素材在 docs/fixtures/（世界书样本、试跑记录样本；真实 PNG 卡不入库，本机有的话设环境变量 `SS_TEST_PNG=<png 路径>` 再跑 test:logic，未设时相关断言自动 skip）。
**施工规划 v2（现状盘点 + N1~N5 新里程碑）见 [docs/ROADMAP.md](docs/ROADMAP.md)**；
原始讨论稿（v0.1，思想存档）在工作区根目录《AI小说创作工具-规划.md》。
