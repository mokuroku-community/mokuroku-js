import type { JobHandlerContext, JobLogger, WorkerHooks } from "@mokurokujs/core";
import type { Job } from "bullmq";
import type { ManagedWorker } from "./managed-worker.js";

export interface WorkerRegistrationOptions {
  logger?: JobLogger;
  backendHooks?: WorkerHooks;
  jobHooks?: Map<string, WorkerHooks>;
  selectHooks?: (name: string) => WorkerHooks | undefined;
}

/** Keep the execution attempt and selected registration together. / 試行番号と選択したフックを保持する。 */
export function attachWorkerHooks(
  worker: ManagedWorker,
  queueHooks: WorkerHooks | undefined,
  options?: WorkerRegistrationOptions,
): () => void {
  const contexts = new WeakMap<Job, JobHandlerContext>();
  const context = (job: Job): JobHandlerContext =>
    contexts.get(job) ?? {
      jobName: job.name,
      jobId: String(job.id),
      attempt: job.attemptsMade + 1,
      timestamp: new Date(job.timestamp),
      logger: options?.logger,
      rawJob: job,
    };
  const hooks = (job: Job) => [
    options?.backendHooks,
    queueHooks,
    options?.selectHooks?.(job.name) ?? options?.jobHooks?.get(job.name),
  ];
  const invoke = (callback: () => void) => {
    try {
      callback();
    } catch (error) {
      options?.logger?.error("worker.hook.error", { error });
    }
  };
  const active = (job: Job) => {
    contexts.set(job, context(job));
    for (const hook of hooks(job)) invoke(() => hook?.onStart?.(context(job)));
  };
  const completed = (job: Job) => {
    for (const hook of hooks(job)) invoke(() => hook?.onSuccess?.(context(job)));
    contexts.delete(job);
  };
  const failed = (job: Job | undefined, error: Error) => {
    if (!job) return;
    const ctx = context(job);
    for (const hook of hooks(job))
      invoke(() => {
        if (job.finishedOn != null) hook?.onFailure?.(ctx, error);
        else hook?.onRetry?.(ctx, error, (job.opts.attempts ?? 1) - job.attemptsMade);
      });
    contexts.delete(job);
  };
  const error = (error: Error) => {
    for (const hook of [options?.backendHooks, queueHooks])
      invoke(() => hook?.onWorkerError?.({ queue: worker.name, error }));
  };
  worker.on("active", active);
  worker.on("completed", completed);
  worker.on("failed", failed);
  worker.on("error", error);
  return () => {
    worker.off("active", active);
    worker.off("completed", completed);
    worker.off("failed", failed);
    worker.off("error", error);
  };
}
