// ============================================================
// 顶层页签导航总线：深层页面（如 ST 试跑）请求切换到顶层「RP 剧场」
// window CustomEvent——避免 App 向下传层层 prop。
// ============================================================

export const GO_TAB_EVENT = "ss:go-tab";

export type TopTab = "projects" | "theater" | "cast" | "lore" | "personas" | "settings" | "play";

export function goTab(tab: TopTab): void {
  try {
    window.dispatchEvent(new CustomEvent(GO_TAB_EVENT, { detail: { tab } }));
  } catch {
    // 非浏览器环境（测试）静默
  }
}
