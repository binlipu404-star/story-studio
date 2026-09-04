// ============================================================
// JobMonitor — 全局悬浮「生成过程监视窗」
// 挂在 App 根，切换页面/标签不会消失。订阅 jobBus，实时展示每个
// 后台任务的：状态、耗时、流式日志尾部；运行中可就地停止。
// ============================================================
import { useEffect, useRef, useState } from "react";
import { abortJob, clearFinishedJobs, useJobs, type Job, type JobStatus } from "../core/jobBus";

const STATUS_META: Record<JobStatus, { text: string; color: string; bg: string }> = {
  running: { text: "生成中", color: "#7a5b00", bg: "#fdf0c9" },
  done: { text: "完成", color: "#1c6b3a", bg: "#d8f0e0" },
  error: { text: "失败", color: "#8c2f22", bg: "#fbe0dc" },
  aborted: { text: "已停止", color: "#6f6a60", bg: "#efece4" },
};

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function elapsed(job: Job, now: number): string {
  const s = Math.round(((job.endedAt ?? now) - job.startedAt) / 1000);
  return s < 60 ? `${s}秒` : `${Math.floor(s / 60)}分${s % 60}秒`;
}

/** 日志尾部：只保留末尾若干字符，最新一行贴底 */
function tail(log: string, max = 4000): string {
  return log.length <= max ? log : `…（前文略）\n${log.slice(-max)}`;
}

function JobRow({ job, now }: { job: Job; now: number }) {
  const meta = STATUS_META[job.status];
  const logRef = useRef<HTMLPreElement | null>(null);
  // 运行中：新日志到达时把日志框滚到最新
  useEffect(() => {
    if (job.status === "running" && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [job.log, job.status]);

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "8px 10px" }}>
      <div className="row" style={{ justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {job.label}
        </span>
        <span style={{ fontSize: 12, lineHeight: "18px", padding: "0 8px", borderRadius: 999, background: meta.bg, color: meta.color, whiteSpace: "nowrap" }}>
          {meta.text}
        </span>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
        {clock(job.startedAt)} 起 · 用时 {elapsed(job, now)} · {job.log.length} 字
      </div>
      {job.error && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#8c2f22", wordBreak: "break-all" }}>{job.error}</div>
      )}
      {job.log && (
        <pre
          ref={logRef}
          style={{
            marginTop: 6,
            maxHeight: 140,
            overflowY: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontSize: 12,
            lineHeight: 1.5,
            background: "rgba(0,0,0,.04)",
            borderRadius: 8,
            padding: "6px 8px",
            fontFamily: "ui-monospace, Menlo, Consolas, monospace",
          }}
        >
          {tail(job.log)}
        </pre>
      )}
      {job.status === "running" && (
        <div className="row" style={{ marginTop: 8 }}>
          <button onClick={() => abortJob(job.id)}>⏹ 停止</button>
        </div>
      )}
    </div>
  );
}

export function JobMonitor() {
  const jobs = useJobs();
  const [open, setOpen] = useState(false);
  const running = jobs.filter((j) => j.status === "running").length;
  const [now, setNow] = useState(() => Date.now());

  // 仅在「有运行中任务」或「面板展开」时按秒刷新计时器，避免空转
  useEffect(() => {
    if (running === 0 && !open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running, open]);

  if (jobs.length === 0) return null; // running 是 jobs 子集，length=0 时 running 必为 0

  const badge = running > 0 ? ` · ${running} 进行中` : "";
  return (
    <div style={{ position: "fixed", right: 18, bottom: 18, zIndex: 50, width: 340, maxWidth: "calc(100vw - 36px)" }}>
      {open && (
        <div
          className="panel"
          style={{
            marginBottom: 10,
            maxHeight: "60vh",
            overflowY: "auto",
            boxShadow: "0 8px 28px rgba(0,0,0,.18)",
            background: "var(--panel)",
          }}
        >
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <strong>生成过程</strong>
            <div className="row">
              <button onClick={clearFinishedJobs} disabled={running === jobs.length}>
                清空已结束
              </button>
              <button onClick={() => setOpen(false)}>收起</button>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
          </div>
          <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
            任务在后台运行，切换页面不会中断；完成会自动写入大纲树。
          </p>
        </div>
      )}
      <button
        className="primary"
        onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", boxShadow: "0 4px 14px rgba(0,0,0,.18)" }}
      >
        {open ? "▾ 收起监视窗" : `⏳ 生成监视${badge}`}
      </button>
    </div>
  );
}
