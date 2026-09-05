// ============================================================
// RP 剧场偏好记忆（v3）：作品/人卡/画像/节奏/模式/预算/台账频率的本地持久化
// localStorage 存 JSON；纯函数负责校验合并（坏数据/旧版本 → 默认值兜底），
// storage 读写只是薄壳。Node 可测。
// ============================================================

export interface TheaterPrefs {
  v: 1;
  lastProjectId: string;
  pace: "tight" | "loose";
  ledgerCadence: number; // 每 N 个用户楼层整理一次台账；0=关；1=每楼自动（v3.1 默认）
  budgetTokens: number;
  reserveTokens: number;
  borrowProjectLedger: boolean; // 剧组正典之外是否手动借用作品级台账
  lastRoomId: string; // 上次打开的剧组（刷新回到原对话）
}

export const DEFAULT_PREFS: TheaterPrefs = {
  v: 1,
  lastProjectId: "",
  pace: "loose",
  ledgerCadence: 1,
  budgetTokens: 8192,
  reserveTokens: 768,
  borrowProjectLedger: false,
  lastRoomId: "",
};

const KEY = "ss.theater.prefs";

/** 校验合并：只认已知字段与合法值域，其余落默认。永不抛错。 */
export function parsePrefs(raw: string | null | undefined): TheaterPrefs {
  const base = { ...DEFAULT_PREFS };
  if (!raw) return base;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return base;
  }
  if (typeof o !== "object" || o === null) return base;
  const r = o as Record<string, unknown>;
  const str = (k: keyof TheaterPrefs): void => {
    if (typeof r[k] === "string") (base[k] as string) = r[k] as string;
  };
  str("lastProjectId");
  str("lastRoomId");
  if (r.pace === "tight" || r.pace === "loose") base.pace = r.pace;
  if (typeof r.ledgerCadence === "number" && Number.isFinite(r.ledgerCadence)) {
    const n = Math.floor(r.ledgerCadence);
    if (n >= 0 && n <= 100) base.ledgerCadence = n;
  }
  if (typeof r.budgetTokens === "number" && r.budgetTokens >= 1024 && r.budgetTokens <= 4_000_000) base.budgetTokens = Math.floor(r.budgetTokens);
  if (typeof r.reserveTokens === "number" && r.reserveTokens >= 0 && r.reserveTokens <= 100_000) base.reserveTokens = Math.floor(r.reserveTokens);
  if (typeof r.borrowProjectLedger === "boolean") base.borrowProjectLedger = r.borrowProjectLedger;
  return base;
}

export function serializePrefs(p: TheaterPrefs): string {
  return JSON.stringify({ ...p, v: 1 });
}

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadPrefs(): TheaterPrefs {
  const s = storage();
  if (!s) return { ...DEFAULT_PREFS };
  try {
    return parsePrefs(s.getItem(KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(p: TheaterPrefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, serializePrefs(p));
  } catch {
    // 存失败不影响会话（下次默认值重来）
  }
}

/** 清除剧场偏好（设置页「清除进度记忆」调用） */
export function clearPrefs(): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(KEY);
  } catch {
    /* 忽略 */
  }
}
