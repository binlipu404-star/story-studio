# 测试素材（手动验收用）

| 文件 | 用途 | 喂给哪个入口 |
|---|---|---|
| `worldinfo-sample.json` | ST **全局世界书**导出格式样本：蓝灯常驻词条、关键词词条（含英文 key）、主副键 selective、group 示例、disable 停用词条 | 「世界书 ▸ 导入世界书」。预期：4 条；导出全局格式再导回应稳定；停用词条不出现在匹配结果 |
| `trial-chat-sample.jsonl` | ST **聊天记录导出**格式样本：chat_metadata 头、swipes 取词、System 行（应跳过）、OOC 前缀、swipe_id 非 0 | 「ST 试跑 ▸ 导入试跑记录」。预期：解析出 5 条对话（第 3 条取 swipes[1]），System 行不进正文 |
| `../../素材/main_morgana-...spec_v2.png` | 真实 V2 **PNG 内嵌卡**（tEXt `chara`） | 「人物卡 ▸ 导入角色卡」。预期：卡名 Morgana，可导出 JSON 且回导一致 |

另：自动化的跨模块集成断言见 `scripts/tests/pipeline.test.mjs`（npm run test:logic 内含），这些素材主要服务于浏览器里的点击验收。
