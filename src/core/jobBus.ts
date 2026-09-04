// ============================================================
// 后台生成任务总线（模块级单例，脱离 React 生命周期）
// 长 AI 任务（如总纲生成）经 startJob 提交后由本总线持有：
// 组件卸载/切换页面都不会中断任务，完成即在任务闭包里落库；
// 全局悬浮的 JobMonitor 窗实时展示 job.log。
// ============================================================
import { useSyncExternalStore } from "react";
import { errMsg, isAbort } from "./uiUtils";

export type JobStatus = "running" | "done" | "error" | "aborted";

export interface Job {
  id: string;
  kind: "master" | "custom";
  label: string;
  projectId: string;
  status: JobStatus;
  startedAt: number;
  endedAt?: number;
  /** 流式原文 + 带时间戳的进度说明（监视窗展示） */
  log: string;
  error?: string;
}

export interface JobCtx {
  signal: AbortSignal;
  /** 流式增量：接给 chat 的 onDelta，原文进 log */
  onDelta: (text: string) => void;
  /** 追加一行带时间戳的进度说明 */
  note: (line: string) => void;
}

type JobTask = (ctx: JobCtx) => Promise<void>;

/** 监视窗最多保留的历史任务数（运行中的永不挤掉） */
const MAX_KEEP = 20;

const registry = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();
let snapshot: Job[] = [];
let seq = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function stamp(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

/** 重建不可变快照并广播（useSyncExternalStore 要求引用变化才重渲染） */
function publish(): void {
  const all = [...registry.values()].sort((a, b) => b.startedAt - a.startedAt);
  snapshot = all.slice(0, MAX_KEEP);
  // 运行中的一律保留；超出上限只裁最老的已完结项
  if (all.length > MAX_KEEP) {
    for (const j of all.slice(MAX_KEEP)) {
      if (j.status === "running") snapshot.push(j);
    }
  }
  for (const fn of listeners) fn();
}

/** 流式增量的高频发布节流（~8fps 足够人眼阅读） */
function schedulePublish(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    publish();
  }, 120);
}

export function startJob(input: {
  kind: Job["kind"];
  label: string;
  projectId: string;
  task: JobTask;
}): Job {
  const id = `job_${Date.now().toString(36)}_${(++seq).toString(36)}`;
  const job: Job = {
    id,
    kind: input.kind,
    label: input.label,
    projectId: input.projectId,
    status: "running",
    startedAt: Date.now(),
    log: "",
  };
  registry.set(id, job);
  publish();

  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  const ctx: JobCtx = {
    signal: ctrl.signal,
    onDelta: (t) => {
      job.log += t;
      schedulePublish();
    },
    note: (line) => {
      job.log += `\n[${stamp()}] ${line}\n`;
      publish();
    },
  };

  void (async () => {
    try {
      await input.task(ctx);
      job.status = ctrl.signal.aborted ? "aborted" : "done";
    } catch (e) {
      if (isAbort(e)) job.status = "aborted";
      else {
        job.status = "error";
        job.error = errMsg(e);
      }
    } finally {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      job.endedAt = Date.now();
      job.log +=
        `\n[${stamp()}] ` +
        (job.status === "done" ? "✔ 完成" : job.status === "aborted" ? "⏹ 已停止" : `✘ 失败：${job.error ?? "未知错误"}`) +
        "\n";
      controllers.delete(id);
      publish();
    }
  })();
  return job;
}

export function abortJob(id: string): void {
  controllers.get(id)?.abort();
}

export function clearFinishedJobs(): void {
  for (const [id, j] of registry) if (j.status !== "running") registry.delete(id);
  publish();
}

export function listJobs(): Job[] {
  return snapshot;
}

export function subscribeJobs(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useJobs(): Job[] {
  return useSyncExternalStore(subscribeJobs, listJobs);
}
