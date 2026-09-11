// 从 dist-test 编译产物把内嵌中继脚本再生成到两处：
// 1) scripts/story-studio-relay.mjs —— 仓库正源文件版（start-story-studio.bat 拉起的）
// 2) .tmpdir/relay-live.mjs        —— 实跑验证用临时版
// 正源是 src/flow/webRelay.ts 的 WEB_RELAY_SCRIPT 常量；文件版勿手改，
// webrelay.test.mjs 逐字节对账锁死两版一致。
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { WEB_RELAY_SCRIPT } from "../dist-test/flow/webRelay.js";

writeFileSync("scripts/story-studio-relay.mjs", WEB_RELAY_SCRIPT, "utf8");
if (!existsSync(".tmpdir")) mkdirSync(".tmpdir");
writeFileSync(".tmpdir/relay-live.mjs", WEB_RELAY_SCRIPT, "utf8");
console.log("relay regenerated from source constant:", WEB_RELAY_SCRIPT.length, "chars x2");
