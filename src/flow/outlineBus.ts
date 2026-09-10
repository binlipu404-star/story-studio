// v7.1-W2：大纲变更广播总线（跨窗口，零轮询）
//
// 场景：用户"边写大纲边 RP"——在窗口 A 改大纲、窗口 B 的剧场全本剧组要能自动
// 察觉并弹「⚡ 主纲有更新」（不点仍用旧副本）。同窗口切页签本就重挂载重拉，
// 无需总线；跨窗口 IndexedDB 共享但页面不重挂载，靠这条总线补上。
//
// 设计：只在**真写入**后 post 一条 {projectId}；订阅方防抖后重拉一次。
// 不做定时轮询读库。BroadcastChannel 缺失时降级为「不广播」（行为退回旧版：
// 切窗口手动刷新），绝不抛。
type Listener = (projectId: string) => void;

const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    channel = new BroadcastChannel("story-studio-outline");
    channel.onmessage = (e: MessageEvent) => {
      const pid = (e.data as { projectId?: string } | null)?.projectId;
      if (typeof pid === "string") for (const fn of listeners) fn(pid);
    };
  } catch {
    channel = null;
  }
  return channel;
}

/** 写入大纲后调用（repos 门面与直通 bulkAdd 的调用点）。同页签内不触发自己。 */
export function notifyOutlineChanged(projectId: string): void {
  const ch = ensureChannel();
  if (!ch) return;
  try {
    ch.postMessage({ projectId });
  } catch {
    /* 广播失败不影响写入本身 */
  }
}

/** 订阅其它窗口/模块的大纲变更（返回退订）。 */
export function subscribeOutlineChanged(fn: Listener): () => void {
  ensureChannel();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
