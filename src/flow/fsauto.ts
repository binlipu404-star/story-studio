// ============================================================
// 剧场本地文件夹自动写盘（v3-P4；File System Access API）
//
// 配方要点（联网核实：WICG/WHATWG/MDN/Chrome 官方博客）：
// - 目录句柄可作纯 value 存 IndexedDB（结构化克隆支持），但权限不持久——
//   刷新后大概率回到 prompt，requestPermission 必须在用户手势里调 → 需要
//   「重新连接」按钮，静默自动重授权做不到（诚实边界）。
// - createWritable() 默认整文件替换 + 交换文件原子落盘，必须 await close()。
// - 低频写（每轮一次）：串行链 + 尾沿去抖即可；文件全量快照覆盖，无增量拼接。
// - 错误分流：NotFoundError=文件夹没了（重选）；NotAllowedError=权限过期（重连）。
// - Firefox/Safari 无本地盘 picker：能力检测后降级为手动导出，功能整体不可用
//   但不报错。
// ============================================================

export interface FsAutoStatus {
  supported: boolean; // 浏览器能力
  connected: boolean; // 已选目录且当前权限 granted（或可静默恢复）
  dirName: string; // 上次连接的目录名（句柄失效也留着展示）
  needsAction: "none" | "reauth" | "reselect";
  lastError: string;
  lastWriteAt: number;
}

export const FS_DISABLED_STATUS: FsAutoStatus = {
  supported: false,
  connected: false,
  dirName: "",
  needsAction: "none",
  lastError: "",
  lastWriteAt: 0,
};

export type DirHandleLike = {
  name: string;
  queryPermission: (o: { mode: "readwrite" }) => Promise<PermissionStateLike>;
  requestPermission: (o: { mode: "readwrite" }) => Promise<PermissionStateLike>;
  getFileHandle: (name: string, opts: { create: boolean }) => Promise<FileHandleLike>;
};
type FileHandleLike = { createWritable: () => Promise<{ write: (data: string) => Promise<void>; close: () => Promise<void> }> };
type PermissionStateLike = "granted" | "prompt" | "denied";

export function fsSupported(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      window.isSecureContext &&
      typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function"
    );
  } catch {
    return false;
  }
}

/** 房间文件名：清洗 + 恒定短后缀（防两个房间清洗后撞名互相覆盖；规则稳定不变） */
export function roomFileName(name: string, roomId: string): string {
  const safe =
    (name || "")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/, "")
      .slice(0, 80)
      .trim() || "room";
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe);
  return `${reserved ? "_" : ""}${safe}-${(roomId || "0").slice(0, 6)}.jsonl`;
}

/**
 * 自动写盘控制器：句柄经 Dexie meta 表存取（存取函数由页面注入，保持本模块
 * 不 import dexie——Node 可测文件名/状态逻辑，链与去抖纯 JS）。
 */
export interface FsAutoIO {
  loadDir: () => Promise<DirHandleLike | null>;
  saveDir: (dir: DirHandleLike | null) => Promise<void>;
}

export class RoomDiskWriter {
  private io: FsAutoIO;
  private dir: DirHandleLike | null | "unchecked" = "unchecked";
  private chain: Promise<void> = Promise.resolve();
  private pending = new Map<string, string>(); // 文件名 → 最新全文（合并无损）
  private timer: ReturnType<typeof setTimeout> | null = null;
  status: FsAutoStatus = { ...FS_DISABLED_STATUS, supported: fsSupported() };
  onStatus?: (s: FsAutoStatus) => void;

  constructor(io: FsAutoIO) {
    this.io = io;
  }

  private set(patch: Partial<FsAutoStatus>): void {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  /** 页面挂载时：恢复上次目录（不请求权限，权限留待首写/重连） */
  async restore(): Promise<void> {
    if (!this.status.supported) return;
    try {
      const dir = await this.io.loadDir();
      this.dir = dir ?? null;
      this.set({
        connected: dir !== null,
        dirName: dir?.name ?? "",
        needsAction: "none",
      });
    } catch {
      this.dir = null;
    }
  }

  /** 用户手势内调用：选目录（或重选），存句柄，随后补写全部 pending */
  async pick(): Promise<void> {
    if (!this.status.supported) throw new Error("当前浏览器不支持本地文件夹（可用导出 jsonl 代替）");
    const picker = (window as unknown as { showDirectoryPicker: (o: { id: string; mode: "readwrite" }) => Promise<DirHandleLike> })
      .showDirectoryPicker;
    const dir = await picker.call(window, { id: "story-studio-theater", mode: "readwrite" });
    await dir.requestPermission({ mode: "readwrite" });
    this.dir = dir;
    await this.io.saveDir(dir);
    this.set({ connected: true, dirName: dir.name, needsAction: "none", lastError: "" });
    this.flushNow();
  }

  /** 用户手势内调用：权限过期重连（同目录，不重选） */
  async reconnect(): Promise<void> {
    const dir = this.dir === "unchecked" ? await this.io.loadDir().then((d) => (this.dir = d)) : this.dir;
    if (!dir) throw new Error("还没有选择过文件夹");
    const p = await dir.requestPermission({ mode: "readwrite" });
    if (p !== "granted") throw new Error("未获得写权限");
    this.set({ connected: true, dirName: dir.name, needsAction: "none", lastError: "" });
    this.flushNow();
  }

  async disconnect(): Promise<void> {
    this.dir = null;
    await this.io.saveDir(null);
    this.set({ connected: false, dirName: "", needsAction: "none", lastError: "" });
  }

  /** 每轮稳定落定调一次：入队最新全量快照，去抖 400ms 后串行写 */
  queue(fileName: string, text: string): void {
    if (!this.status.supported) return;
    this.pending.set(fileName, text);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flushNow(), 400);
  }

  /** 立即把 pending 全部排队写入（串行链保证同刻只有一个 writer，防 siloed 互相覆盖） */
  flushNow(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const items = [...this.pending.entries()];
    if (items.length === 0) return;
    this.pending.clear();
    for (const [name, text] of items) {
      this.chain = this.chain
        .then(() => this.doWrite(name, text))
        .then((ok) => {
          // M6：写失败 → 回队 pending（期间来了更新快照则保新弃旧）；
          // pick/reconnect 手势恢复后 flushNow 自动补写，快照不再静默丢失
          if (!ok && !this.pending.has(name)) this.pending.set(name, text);
        })
        .catch(() => {
          if (!this.pending.has(name)) this.pending.set(name, text);
        });
    }
  }

  /** 返回是否已消费（false=写失败需回队重试；未连接目录视为无需写） */
  private async doWrite(fileName: string, text: string): Promise<boolean> {
    if (this.dir === "unchecked") this.dir = await this.io.loadDir();
    const dir = this.dir;
    if (!dir) return true; // 没连目录：静默（导出仍可用）
    try {
      const p = await dir.queryPermission({ mode: "readwrite" });
      if (p !== "granted") {
        // 不弹框（弹框要手势）：置状态，等用户点「重新连接」
        this.set({ connected: false, needsAction: "reauth", lastError: "写权限已过期，点「重新连接」恢复" });
        return false;
      }
      const fh = await dir.getFileHandle(fileName, { create: true });
      const w = await fh.createWritable(); // 默认截断替换；无需 truncate
      await w.write(text);
      await w.close(); // 不 close = 没落盘
      this.set({ connected: true, needsAction: "none", lastError: "", lastWriteAt: Date.now() });
      return true;
    } catch (e) {
      const name = e instanceof Error ? e.name : "";
      const msg = e instanceof Error ? e.message : String(e);
      if (name === "NotFoundError") {
        this.set({ connected: false, needsAction: "reselect", lastError: "文件夹已不可访问（被移动/删除），请重选" });
        await this.io.saveDir(null).catch(() => undefined);
        this.dir = null;
      } else if (name === "NotAllowedError" || name === "SecurityError") {
        this.set({ connected: false, needsAction: "reauth", lastError: "写权限失效，点「重新连接」恢复" });
      } else {
        this.set({ lastError: `写入失败：${msg}` });
      }
      return false;
    }
  }
}
