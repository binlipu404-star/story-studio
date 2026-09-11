// v8-D 网页版本地中继：解析镜像 + 脚本/启动器不变量 + 文件版对账
import { readFileSync } from "node:fs";
import { relayParseTarget, WEB_RELAY_SCRIPT, WEB_RELAY_BAT, RELAY_DEFAULT_PORT } from "../../dist-test/flow/webRelay.js";

export default async function (t) {
  // 1. URL 解析镜像（与 proxy.rs::parse_target 同语义）
  {
    t.eq(
      relayParseTarget("/proxy/https/sub2api.x/v1/chat/completions"),
      "https://sub2api.x/v1/chat/completions",
      "1. https 网关+路径",
    );
    t.eq(relayParseTarget("/proxy/https/sub2api.x/v1?key=1"), "https://sub2api.x/v1?key=1", "1. query 原样带");
    t.eq(relayParseTarget("/proxy/http/127.0.0.1:1234/a"), "http://127.0.0.1:1234/a", "1. http+端口");
    t.eq(relayParseTarget("/proxy/https/sub2api.x"), "https://sub2api.x/", "1. 无尾路径 → 根路径");
    t.eq(relayParseTarget("/api/x"), null, "1. 非 /proxy/ 前缀 → null");
    t.eq(relayParseTarget("/proxy/ftp/host/p"), null, "1. 非法协议 → null");
    t.eq(relayParseTarget("/proxy/https//p"), null, "1. 空 host → null");
    t.eq(relayParseTarget("/health"), null, "1. health 不是转发目标");
  }

  // 2. 内嵌脚本不变量（模板字面量安全 + 关键面齐全）
  {
    t.ok(!WEB_RELAY_SCRIPT.includes("${"), "2. 脚本体无 ${（模板字面量安全）");
    t.ok(!WEB_RELAY_SCRIPT.includes("`"), "2. 脚本体无反引号");
    t.ok(WEB_RELAY_SCRIPT.startsWith("#!/usr/bin/env node"), "2. shebang 开头");
    t.ok(WEB_RELAY_SCRIPT.includes('"/health"') || WEB_RELAY_SCRIPT.includes('"/health'), "2. 有 /health 探针");
    t.ok(WEB_RELAY_SCRIPT.includes("access-control-allow-origin"), "2. 有 CORS 头");
    t.ok(WEB_RELAY_SCRIPT.includes('"OPTIONS"'), "2. 预检本地消化");
    t.ok(WEB_RELAY_SCRIPT.includes('listen(PORT, "127.0.0.1"'), "2. 只监听 127.0.0.1");
    t.ok(WEB_RELAY_SCRIPT.includes("upstream.destroy()"), "2. 客户端中断 → 上游停流");
    t.eq(RELAY_DEFAULT_PORT, 8788, "2. 默认端口 8788");
  }

  // 3. 双击启动器（start-relay.bat）不变量
  {
    t.ok(WEB_RELAY_BAT.startsWith("@echo off\r\n"), "3. @echo off 起手 + CRLF");
    t.ok(!/[^\x00-\x7F]/.test(WEB_RELAY_BAT), "3. 纯 ASCII（cmd 码页安全）");
    t.ok(WEB_RELAY_BAT.includes('cd /d "%~dp0"'), "3. 切到自身目录");
    t.ok(WEB_RELAY_BAT.includes("where node"), "3. Node 缺失检测");
    t.ok(WEB_RELAY_BAT.includes("story-studio-relay.mjs"), "3. 指名脚本");
    t.ok(WEB_RELAY_BAT.includes("pause"), "3. 出错/退出留窗");
  }

  // 4. 三方对账：内嵌正源 ↔ 仓库文件版（start-story-studio.bat 拉起的）逐字节一致
  {
    const fileSrc = readFileSync(new URL("../../scripts/story-studio-relay.mjs", import.meta.url), "utf8");
    t.eq(fileSrc, WEB_RELAY_SCRIPT, "4. 文件版与内嵌版逐字节一致（漂移=跑 npm run relay:sync）");
    // bat 的自动化：启动器存在 + 开发启动器已并线中继
    const devBat = readFileSync(new URL("../../start-story-studio.bat", import.meta.url), "utf8");
    t.ok(devBat.includes("story-studio-relay.mjs"), "4. start-story-studio.bat 并线中继");
    t.ok(devBat.includes('":8788"'), "4. 并线版有端口查重（不双起）");
  }
}
