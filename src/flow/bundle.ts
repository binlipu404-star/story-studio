// ============================================================
// 项目 bundle 组装（N5）：把整个作品打包成可迁移/可备份的文件集，再压成 zip。
// 内容 = 创作三事实层全量：大纲（md+json）/ 台账 / RP 转写 + ST 生态件（卡/世界书）
// 纯逻辑：输入全为已取好的数据，输出文件名+文本；zip 字节交给 flow/zip。
// ============================================================

import type { Character, LedgerRecord, LoreEntry, OutlineNode, Project, RPSession } from "../core/types";
import { treeToMarkdown } from "./outline.js";
import { exportCardV2 } from "../st/card.js";
import { exportLorebookGlobal } from "../st/lorebook.js";
import { buildZip, type ZipEntry } from "./zip.js";

export interface BundleInput {
  project: Project;
  nodes: OutlineNode[];
  characters: Character[];
  loreEntries: LoreEntry[];
  ledger: LedgerRecord[]; // 全状态（status 字段自带）
  sessions: RPSession[]; // 建议传入 updatedAt 倒序
}

const json = (v: unknown): string => JSON.stringify(v, null, 1);

function fileNameSafe(s: string, fallback: string): string {
  const t = (s || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim();
  return t || fallback;
}

const MAX_TRANSCRIPT_CHARS = 60_000;
const MAX_TRANSCRIPTS = 8;

/** 组装 bundle 的文件清单（不压缩；测试直接对清单断言） */
export function bundleFiles(input: BundleInput): ZipEntry[] {
  const { project, nodes, characters, loreEntries, ledger, sessions } = input;
  const title = fileNameSafe(project.title, "story");
  const files: ZipEntry[] = [];

  files.push({
    name: `${title}/README.txt`,
    text: [
      `Story Studio 项目包：${project.title}`,
      `导出时间：${new Date().toISOString()}`,
      "",
      "内含（创作三事实层 + ST 生态件）：",
      "  outline.md      大纲树（人读版，卷/章/幕/节拍/伏笔）",
      "  outline.json    大纲树（机读版，可回灌）",
      "  project.json    作品档案（构思访谈字段含状态标记）",
      "  ledger.json     台账（proposed/confirmed/rejected 全状态+溯源）",
      "  transcripts/    RP 会话转写（每场一份，前情摘要附顶）",
      "  cards/          人物卡（ST Character Card V2）",
      "  worldbook.json  世界书（ST 全局格式，仅启用词条）",
      "",
      "回到 Story Studio：数据都在 IndexedDB；本包用于备份、迁移与进 SillyTavern。",
    ].join("\n"),
  });

  const md = treeToMarkdown(nodes);
  files.push({ name: `${title}/outline.md`, text: md || "（大纲为空）" });
  files.push({ name: `${title}/outline.json`, text: json(nodes) });
  files.push({ name: `${title}/project.json`, text: json(project) });
  files.push({ name: `${title}/ledger.json`, text: json(ledger) });

  const nodeTitle = new Map<unknown, string>(nodes.map((n) => [n.id, n.title] as const));
  const taken = new Set<string>();
  sessions.slice(0, MAX_TRANSCRIPTS).forEach((s, i) => {
    const label = fileNameSafe(nodeTitle.get(s.nodeId) ?? "", `session-${i + 1}`);
    let name = `${title}/transcripts/${String(i + 1).padStart(2, "0")}-${label}.txt`;
    while (taken.has(name)) name = name.replace(/\.txt$/, "-2.txt");
    taken.add(name);
    const body = s.messages
      .map((m) => `${m.name || m.role}：${m.content}`)
      .join("\n\n")
      .slice(0, MAX_TRANSCRIPT_CHARS);
    files.push({
      name,
      text: [
        `# ${label}`,
        `状态：${s.status}｜角色：${s.cast.length} 人｜{{user}}：${s.userName}`,
        s.rollingSummary ? `【前情摘要】${s.rollingSummary}` : "",
        "",
        body + (s.messages.reduce((n, m) => n + m.content.length + 2, 0) > MAX_TRANSCRIPT_CHARS ? "\n…（转写截断）" : ""),
      ]
        .filter(Boolean)
        .join("\n"),
    });
  });

  characters.forEach((c, i) => {
    files.push({
      name: `${title}/cards/${fileNameSafe(c.name, `char-${i + 1}`)}.json`,
      text: json(exportCardV2(c)),
    });
  });

  const enabled = loreEntries.filter((e) => e.enabled);
  if (enabled.length > 0) {
    files.push({ name: `${title}/worldbook.json`, text: json(exportLorebookGlobal(enabled)) });
  }

  return files;
}

/** 一步到位：项目包 zip 字节（文件名前缀 = 作品标题目录） */
export function bundleZipBytes(input: BundleInput): Uint8Array {
  return buildZip(bundleFiles(input));
}
