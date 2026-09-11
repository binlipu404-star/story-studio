// 从 dist-test 编译产物提取内嵌中继脚本，落到 .tmpdir 实跑验证用
import { writeFileSync } from "node:fs";
import { WEB_RELAY_SCRIPT } from "../dist-test/flow/webRelay.js";

writeFileSync(".tmpdir/relay-live.mjs", WEB_RELAY_SCRIPT, "utf8");
console.log("extracted", WEB_RELAY_SCRIPT.length, "chars");
