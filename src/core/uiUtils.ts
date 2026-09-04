// ============================================================
// 跨页共享的浏览器小工具（非 UI：不含任何组件/内联样式）
// 设计纪律 §9.5/§13：页面层允许内联样式自我克制为零抽象，
// 但纯工具（错误文案/下载/剪贴板）此前在 10+ 个文件逐字复制，
// 收敛到此单一来源。修复一处，处处生效（如 Firefox 下载修复）。
// ============================================================

/** 异常 → 给用户看的单行文案 */
export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 用户主动中止（fetch/reader 抛 AbortError），调用方据此静默而非报错 */
export function isAbort(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { name?: unknown }).name === "AbortError";
}

/** 统一 Blob 下载：挂进 DOM 再 click（Firefox 不挂 DOM 不触发），延时 revoke 保下载完成 */
export function downloadFile(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 下载文本文件（默认 text/plain；剧场导出用 ndjson 传 mime） */
export function downloadText(name: string, content: string, mime = "text/plain;charset=utf-8"): void {
  downloadFile(name, new Blob([content], { type: mime }));
}

/** 下载 JSON（pretty 缩进） */
export function downloadJson(fileName: string, data: unknown): void {
  downloadFile(fileName, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}

/** 下载二进制（zip 包）。slice(0) 拷贝出确定 owned 的 ArrayBuffer，满足 BlobPart 类型 */
export function downloadBlob(name: string, bytes: Uint8Array): void {
  downloadFile(name, new Blob([bytes.slice(0).buffer as ArrayBuffer], { type: "application/zip" }));
}

/** 复制：优先 navigator.clipboard；失败/不可用降级隐藏 textarea select + execCommand */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 非安全上下文/权限拒绝：走降级 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 本地化时间戳（列表行「更新于」） */
export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
