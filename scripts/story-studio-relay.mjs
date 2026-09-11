#!/usr/bin/env node
// Story Studio Web 本地中继（单文件零依赖，Node 18+）：
// 浏览器直连零 CORS 头的网关（如 sub2api）必挂——本页在浏览器与网关之间
// 做一层本机转发，顺手补齐 CORS 头。只监听 127.0.0.1，不解析、不留存任何内容。
//
// 用法：node story-studio-relay.mjs        （默认端口 8788）
//       node story-studio-relay.mjs 9000   （或环境变量 PORT=9000）
// URL 契约（Story Studio 设置页「一键填入」生成的就是它）：
//   http://127.0.0.1:8788/proxy/https/网关主机[:端口]/真实路径?query
//
// ⚠ 本常量是正源：仓库文件 scripts/story-studio-relay.mjs（start-story-studio.bat
// 拉起的那份）由 scripts/extract-relay.mjs 从本常量再生成，勿手改文件版；
// webrelay.test.mjs 把两者逐字节对账锁死。
import http from "node:http";
import https from "node:https";

const PORT = Number(process.argv[2] || process.env.PORT || 8788);
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};
// 逐跳头+需重算头：转发与回传都要剔（同桌面壳 proxy.rs 清单）
const DROP_REQ = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "host", "content-length", "accept-encoding",
]);
const DROP_RES = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
  "content-length", "content-encoding",
]);

// 解析 /proxy/<scheme>/<host>/<path…>?<query>（与前端 relayParseTarget 同语义）
function parseTarget(rawUrl) {
  const qi = rawUrl.indexOf("?");
  const path = qi >= 0 ? rawUrl.slice(0, qi) : rawUrl;
  const query = qi >= 0 ? rawUrl.slice(qi) : "";
  if (path.indexOf("/proxy/") !== 0) return null;
  const rest = path.slice(7);
  const slash = rest.indexOf("/");
  const scheme = slash >= 0 ? rest.slice(0, slash) : rest;
  const after = slash >= 0 ? rest.slice(slash + 1) : "";
  if (scheme !== "http" && scheme !== "https") return null;
  const nextSlash = after.indexOf("/");
  const host = nextSlash >= 0 ? after.slice(0, nextSlash) : after;
  const tail = nextSlash >= 0 ? after.slice(nextSlash + 1) : "";
  if (!host) return null;
  return scheme + "://" + host + "/" + tail + query;
}

const server = http.createServer((req, res) => {
  for (const k in CORS) res.setHeader(k, CORS[k]);

  // 预检在本地消化（sub2api 等网关对 OPTIONS 直接 403，转发必死）
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  // 健康探针：设置页「探测」按钮打这里
  if (req.url === "/health" || req.url.startsWith("/health?")) {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const target = parseTarget(req.url || "/");
  if (!target) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("story-studio relay: 用法 /proxy/<http|https>/<host>/<路径>");
    return;
  }
  let u;
  try { u = new URL(target); } catch {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("story-studio relay: 目标地址不合法");
    return;
  }

  const headers = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (!DROP_REQ.has(req.rawHeaders[i].toLowerCase())) headers[req.rawHeaders[i]] = req.rawHeaders[i + 1];
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("error", () => {});
  req.on("end", () => {
    const body = chunks.length ? Buffer.concat(chunks) : null;
    const mod = u.protocol === "http:" ? http : https;
    const upstream = mod.request(u, { method: req.method, headers }, (ur) => {
      const hs = {};
      for (let i = 0; i < ur.rawHeaders.length; i += 2) {
        if (!DROP_RES.has(ur.rawHeaders[i].toLowerCase())) hs[ur.rawHeaders[i]] = ur.rawHeaders[i + 1];
      }
      res.writeHead(ur.statusCode || 502, hs);
      ur.pipe(res); // 逐块透传：SSE 真流式
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end("中继转发失败：" + e.message);
      } else {
        res.destroy();
      }
    });
    // 客户端中断（停止生成）→ 上游停流
    res.on("close", () => {
      if (!upstream.destroyed && !res.writableEnded) upstream.destroy();
    });
    if (body && req.method !== "GET" && req.method !== "HEAD") upstream.write(body);
    upstream.end();
  });
});

server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch {} });
server.listen(PORT, "127.0.0.1", () => {
  console.log("Story Studio 本地中继已启动：http://127.0.0.1:" + PORT + "/proxy/<scheme>/<host>/<路径>");
  console.log("只监听本机；Key 只在请求头里过路，不留存任何内容；Ctrl+C 退出。");
});
