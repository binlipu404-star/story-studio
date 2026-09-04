// ============================================================
// 最小 ZIP 写入器（N5 项目包导出；纯逻辑，Node/浏览器同构，零依赖）
//
// 只实现「stored（不压缩）+ UTF-8 文件名」：文本类负载（md/json/txt）本就
// 以可读性优先，store 模式让写入器小到可以被测试完全锁死。
// 结构 = 逐个本地文件头 + 中央目录 + EOCD（PKZIP 应用笔记 4.5.x）。
// ============================================================

export interface ZipEntry {
  name: string; // 正斜杠路径，UTF-8
  text: string; // UTF-8 文本内容
}

// ---------- CRC-32（IEEE 802.3 多项式 0xEDB88320，与 zip 规范一致） ----------

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  CRC_TABLE = table;
  return table;
}

export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------- 写入器 ----------

const ENC = /* @__PURE__ */ new TextEncoder();
// DOS 时间戳固定为 1980-01-01 00:00:00（date=0x0021）：确定性输出，测试可比对字节
const DOS_TIME = 0;
const DOS_DATE = 0x0021;
const FLAG_UTF8 = 0x0800;

/** 清洗 zip 条目名：反斜杠转正斜杠、去盘符/非法字符、去首尾斜杠与 ".." 段 */
export function safeZipName(name: string): string {
  return name
    .replace(/\\/g, "/")
    .replace(/[:*?"<>|\u0000-\u001f]/g, "_")
    .split("/")
    .filter((seg) => seg !== "" && seg !== "." && seg !== "..")
    .join("/");
}

/**
 * 组装 stored-zip 字节。同名条目保留先写者（后写者跳过——写入序即优先级）。
 * 返回完整 .zip 文件内容（可直接 new Blob([bytes]) 下载）。
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const seen = new Set<string>();
  const items: { nameBytes: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };
  const headerBuf = new ArrayBuffer(30);

  for (const e of entries) {
    const name = safeZipName(e.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const nameBytes = ENC.encode(name);
    const data = ENC.encode(e.text);
    const crc = crc32(data);

    const h = new DataView(headerBuf);
    h.setUint32(0, 0x04034b50, true); // local file header 签名
    h.setUint16(4, 20, true); // version needed
    h.setUint16(6, FLAG_UTF8, true);
    h.setUint16(8, 0, true); // method = store
    h.setUint16(10, DOS_TIME, true);
    h.setUint16(12, DOS_DATE, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true); // compressed size（store 下相同）
    h.setUint32(22, data.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true); // extra len

    const entryOffset = offset;
    push(new Uint8Array(headerBuf.slice(0)));
    push(nameBytes);
    push(data);
    items.push({ nameBytes, data, crc, offset: entryOffset });
  }

  // 中央目录
  const cdStart = offset;
  const cd = new ArrayBuffer(46);
  for (const it of items) {
    const h = new DataView(cd);
    h.setUint32(0, 0x02014b50, true); // central directory 签名
    h.setUint16(4, 20, true); // version made by
    h.setUint16(6, 20, true); // version needed
    h.setUint16(8, FLAG_UTF8, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, DOS_TIME, true);
    h.setUint16(14, DOS_DATE, true);
    h.setUint32(16, it.crc, true);
    h.setUint32(20, it.data.length, true);
    h.setUint32(24, it.data.length, true);
    h.setUint16(28, it.nameBytes.length, true);
    h.setUint16(30, 0, true); // extra
    h.setUint16(32, 0, true); // comment
    h.setUint16(34, 0, true); // disk
    h.setUint16(36, 0, true); // internal attrs
    h.setUint32(38, 0, true); // external attrs
    h.setUint32(42, it.offset, true);
    push(new Uint8Array(cd.slice(0)));
    push(it.nameBytes);
  }
  const cdSize = offset - cdStart;

  // EOCD
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, items.length, true);
  eocd.setUint16(10, items.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  eocd.setUint16(20, 0, true);
  push(new Uint8Array(eocd.buffer.slice(0)));

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
