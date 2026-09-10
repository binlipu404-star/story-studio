// ============================================================
// Tauri 桌面壳桥接（v7-A2）：环境探测 + 本地代理端口。
// 浏览器版里这些函数全部安静降级（isTauri=false / port=0），
// 调用方据此显隐桌面专属 UI——前端其余代码零感知。
// ============================================================

interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): TauriInternals | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

/** 是否运行在 Tauri 桌面壳内（浏览器版=false；壳注入的全局对象是唯一判据） */
export function isTauri(): boolean {
  return internals() !== undefined;
}

/** 壳内本地代理端口；0=不可用（浏览器版/代理未起）。异步：invoke 一次即缓存。 */
let portCache: Promise<number> | null = null;
export function getProxyPort(): Promise<number> {
  if (!portCache) {
    const inv = internals()?.invoke;
    portCache = inv
      ? inv("proxy_port").then((p) => (typeof p === "number" ? p : 0)).catch(() => 0)
      : Promise.resolve(0);
  }
  return portCache;
}

/**
 * 直连 baseURL → 代理前缀形态：
 *   https://sub2api.x/v1 → http://127.0.0.1:<port>/proxy/https/sub2api.x/v1
 * 已是代理形态/解析失败 → 原样返回。client.ts 拼 /chat/completions 天然成立。
 */
export function toProxyUrl(baseURL: string, port: number): string {
  if (!port) return baseURL;
  let u: URL;
  try {
    u = new URL(baseURL);
  } catch {
    return baseURL;
  }
  if (u.hostname === "127.0.0.1" || u.hostname === "localhost") return baseURL; // 已是代理/本地，不动
  if (u.search) return baseURL; // 带 query 的 baseURL 极罕见且剥前缀拼接易错，保守原样返回
  const path = u.pathname.replace(/^\/+/, "");
  return `http://127.0.0.1:${port}/proxy/${u.protocol.replace(/:$/, "")}/${u.host}${path ? `/${path}` : ""}`;
}
