// v8-D Web 版本地中继：解析镜像 + 内嵌脚本不变量
import { relayParseTarget, WEB_RELAY_SCRIPT, RELAY_DEFAULT_PORT } from "../../dist-test/flow/webRelay.js";

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
}
