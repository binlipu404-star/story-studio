// ============================================================
// 进度记忆（v3.1-②）：各页面的「工作现场」持久化。
//
// 与 prefs（剧场全局配置）和 Dexie（作品数据）分开：这里只存 UI 现场——
// 选中项、草稿、页签、滚动位置……前缀统一 ss.progress.，设置页一键清除
// （「关闭清除」= 用户主动清，平时自动记）。
// 纯逻辑 + 注入式 storage：Node 可测，浏览器注入 localStorage。
// ============================================================

export const PROGRESS_PREFIX = "ss.progress.";

export interface ProgressStorage {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
  key: (i: number) => string | null;
  length: number;
}

const mem = new Map<string, string>();
/** 内存替身（Node 测试 / localStorage 不可用的隐私模式） */
export const memoryStorage: ProgressStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => void mem.set(k, v),
  removeItem: (k) => void mem.delete(k),
  key: (i) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};

function browserStorage(): ProgressStorage | null {
  try {
    if (typeof localStorage !== "undefined") {
      return {
        getItem: (k) => localStorage.getItem(k),
        setItem: (k, v) => localStorage.setItem(k, v),
        removeItem: (k) => localStorage.removeItem(k),
        key: (i) => localStorage.key(i),
        get length() {
          return localStorage.length;
        },
      };
    }
  } catch {
    /* 隐私模式 */
  }
  return null;
}

let backend: ProgressStorage | null = null;
export function setProgressStorage(s: ProgressStorage | null): void {
  backend = s;
}
function store(): ProgressStorage {
  if (!backend) backend = browserStorage() ?? memoryStorage;
  return backend;
}

export function progressKey(scope: string, id?: string): string {
  return id ? `${PROGRESS_PREFIX}${scope}.${id}` : `${PROGRESS_PREFIX}${scope}`;
}

/** 存现场（坏 JSON 之外的异常一律吞——进度记忆绝不能炸页面） */
export function saveProgress<T>(scope: string, id: string | undefined, value: T): void {
  try {
    store().setItem(progressKey(scope, id), JSON.stringify(value));
  } catch {
    /* 容量满等：进度记忆静默放弃 */
  }
}

export function loadProgress<T>(scope: string, id?: string): T | null {
  try {
    const raw = store().getItem(progressKey(scope, id));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function clearProgress(scope: string, id?: string): void {
  try {
    store().removeItem(progressKey(scope, id));
  } catch {
    /* 忽略 */
  }
}

/** 清除全部进度记忆（设置页按钮）；返回清掉的条数 */
export function clearAllProgress(): number {
  const s = store();
  const doomed: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const k = s.key(i);
    if (k && k.startsWith(PROGRESS_PREFIX)) doomed.push(k);
  }
  doomed.forEach((k) => {
    try {
      s.removeItem(k);
    } catch {
      /* 忽略 */
    }
  });
  return doomed.length;
}

/** 防抖器（纯逻辑可测）：delay 内多次触发只落最后一次 */
export function makeDebouncer(ms: number, fire: () => void): {
  bump: () => void;
  flushNow: () => void;
  cancel: () => void;
  pending: () => boolean;
} {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    bump: () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire();
      }, ms);
    },
    flushNow: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      fire();
    },
    cancel: () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    pending: () => timer !== null,
  };
}
