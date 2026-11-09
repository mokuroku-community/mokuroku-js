import { formatInvalidStateMessage, HandlerNotRegisteredError, InvalidStateError } from "@mokurokujs/core";

import { cancelled, validateLifecycle, withDeadline } from "./lifecycle-operation.js";

import type {
  BackendHooks,
  BulkEnqueueItem,
  EnqueueOptions,
  EnqueueResult,
  JobBackend,
  JobDefinition,
  JobHandler,
  JobHandlerContext,
  JobLifecycleOptions,
  JobLogger,
  JobRemovePolicy,
  QueueDefinition,
  RegisterHandlerOptions,
  WorkerHooks,
} from "@mokurokujs/core";
import type { Job, JobsOptions } from "bullmq";
import type { BullMQQueueManager } from "./queue-manager.js";
import type { createBullmqScheduler } from "./scheduler.js";
import type { BullMQQueueDefinition } from "./types.js";

export type { BackendHooks, WorkerHooks } from "@mokurokujs/core";
export type { BullmqQueueConfig } from "./types.js";

export interface BullmqBackendOptions {
  /**
   * Shared BullMQ queue/worker manager.
   *
   * Sharing this with {@link createBullmqScheduler}
   * ensures a single set of Queue/Worker instances per queue name.
   *
   * BullMQ の Queue/Worker マネージャー（共有推奨）。
   * {@link createBullmqScheduler}
   * と共有することで、キュー名ごとにインスタンスを一元管理できる。
   */
  queueManager: BullMQQueueManager;

  /**
   * Default queue used when `job.options.queue` is not set.
   *
   * `job.options.queue` 未指定時に使うデフォルトキュー。
   */
  defaultQueue?: BullMQQueueDefinition;

  /**
   * Logger used for internal events and hook diagnostics.
   *
   * 内部イベント/フック診断のログ出力に使う。
   */
  logger?: JobLogger;

  /**
   * Backend-level hooks for enqueue/job lifecycle events.
   *
   * enqueue/ジョブ実行イベントの backend レベルフック。
   */
  hooks?: BackendHooks;
}

/**
 * BullMQ-backed {@link JobBackend} implementation.
 *
 * Important behavior:
 * - Workers are created when starting workers after registering handlers.
 *   @see JobRuntime
 *   If you enqueue jobs without registering handlers, they will remain queued
 *   until a worker exists.
 *
 * BullMQ を用いた {@link JobBackend} 実装。
 * 重要な挙動:
 * - worker 起動時に handler 登録済みジョブを元に Worker を作成する。
 *   @see JobRuntime
 *   handler 未登録のまま enqueue されたジョブは、Worker が作られるまで処理されない。
 */
export class BullmqBackend implements JobBackend {
  private readonly queueManager: BullMQQueueManager;
  private readonly defaultQueue: BullMQQueueDefinition;
  private readonly logger?: JobLogger;
  private readonly hooks: BackendHooks;

  private readonly registrations = new Map<
    string,
    {
      queue: BullMQQueueDefinition;
      named: Map<string, { handler: JobHandler<unknown, unknown>; hooks?: WorkerHooks }>;
      defaultName?: string;
    }
  >();
  private starting?: Promise<void>;
  private startWork?: Promise<void>;
  private stopping?: Promise<void>;
  private controller?: AbortController;

  /**
   * Backend lifecycle state.
   *
   * - `idle`: not started
   * - `starting`: `start()` in progress
   * - `started`: workers running
   * - `stopping`: `stop()` in progress
   *
   * バックエンドのライフサイクル状態。
   */
  private state: "idle" | "starting" | "started" | "stopping" = "idle";

  constructor(options: BullmqBackendOptions) {
    this.queueManager = options.queueManager;
    this.logger = options.logger;
    this.hooks = options.hooks ?? {};
    this.defaultQueue = options.defaultQueue ?? {
      name: "default",
      config: { bullmq: {} },
    };
  }

  /**
   * Normalize a {@link QueueDefinition} into a {@link BullMQQueueDefinition}.
   *
   * {@link QueueDefinition} を {@link BullMQQueueDefinition} に正規化する。
   */
  private normalizeQueueDefinition(queueDef: QueueDefinition): BullMQQueueDefinition {
    if (!queueDef.config) {
      return { name: queueDef.name, config: { bullmq: {} } };
    }
    return queueDef as BullMQQueueDefinition;
  }

  /**
   * Convert {@link JobRemovePolicy} into BullMQ-compatible keep-jobs options.
   *
   * {@link JobRemovePolicy} を BullMQ の keep-jobs 形式へ変換する。
   */
  private convertRemovePolicy(policy: JobRemovePolicy | undefined): JobsOptions["removeOnComplete"] {
    if (typeof policy !== "object" || policy === null) {
      return policy;
    }
    if (policy.age !== undefined) {
      return { age: policy.age, count: policy.count };
    }
    return { count: policy.count ?? 0 };
  }

  /**
   * Build BullMQ {@link JobsOptions} by combining job defaults and enqueue overrides.
   *
   * job 既定値と enqueue 上書きを合成して BullMQ の {@link JobsOptions} を作る。
   */
  private buildJobsOptions<TPayload>(
    jobDef: JobDefinition<TPayload, unknown>,
    enqueueOptions?: EnqueueOptions,
  ): JobsOptions {
    const values: JobsOptions = {
      attempts: enqueueOptions?.attempts ?? jobDef.options.attempts,
      backoff: enqueueOptions?.backoff ?? jobDef.options.backoff,
      priority: jobDef.options.priority,
      removeOnComplete: this.convertRemovePolicy(enqueueOptions?.removeOnComplete ?? jobDef.options.removeOnComplete),
      removeOnFail: this.convertRemovePolicy(enqueueOptions?.removeOnFail ?? jobDef.options.removeOnFail),
      delay: enqueueOptions?.delay,
      jobId: enqueueOptions?.jobId,
    };
    return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  }

  private assertNotStopping(): void {
    if (this.state === "stopping")
      throw new InvalidStateError({ message: "Backend is stopping", details: { backendState: this.state } });
  }

  async enqueue<TPayload>(
    jobDef: JobDefinition<TPayload, unknown>,
    payload: NoInfer<TPayload>,
    enqueueOptions?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    this.assertNotStopping();
    const queueDef = jobDef.options.queue ?? this.defaultQueue;
    const queue = this.queueManager.getOrCreateQueue(queueDef);

    // 注: Worker 作成は enqueue ではなく `registerHandler()` を根拠に行う。
    // handler のないキューに空 Worker を作らないため。

    const jobName = enqueueOptions?.jobName ?? jobDef.name;
    const job = await queue.add(jobName, payload, this.buildJobsOptions(jobDef, enqueueOptions));

    this.hooks.onEnqueue?.({
      jobName,
      payload,
      queue: queueDef.name,
    });

    return {
      jobId: job.id ?? "",
      name: job.name,
    };
  }

  async enqueueBulk<TPayload>(
    jobDef: JobDefinition<TPayload, unknown>,
    items: BulkEnqueueItem<NoInfer<TPayload>>[],
  ): Promise<EnqueueResult[]> {
    this.assertNotStopping();
    const queueDef = jobDef.options.queue ?? this.defaultQueue;
    const queue = this.queueManager.getOrCreateQueue(queueDef);

    const bulkJobs = items.map((item) => ({
      name: item.options?.jobName ?? jobDef.name,
      data: item.payload,
      opts: this.buildJobsOptions(jobDef, item.options),
    }));

    const jobs = await queue.addBulk(bulkJobs);

    // 一括 enqueue でも、利用側が全 payload を観測できるよう item ごとにフックを呼ぶ。
    for (const item of items) {
      this.hooks.onEnqueue?.({
        jobName: item.options?.jobName ?? jobDef.name,
        payload: item.payload,
        queue: queueDef.name,
      });
    }

    return jobs.map((job) => ({
      jobId: job.id ?? "",
      name: job.name,
    }));
  }

  registerHandler<TPayload, TResult = void>(
    jobDef: JobDefinition<TPayload, TResult>,
    handler: JobHandler<NoInfer<TPayload>, NoInfer<TResult>>,
    options?: RegisterHandlerOptions,
  ): void {
    if (this.state !== "idle")
      throw new InvalidStateError({
        message: "Handlers can only be registered while idle",
        details: { backendState: this.state },
      });
    const queue = this.normalizeQueueDefinition(jobDef.options.queue ?? this.defaultQueue);
    const registration = this.registrations.get(queue.name) ?? { queue, named: new Map(), defaultName: undefined };
    if (
      options?.defaultForQueue &&
      registration.defaultName !== undefined &&
      registration.defaultName !== jobDef.name
    ) {
      throw new InvalidStateError({
        message: "Queue already has a default handler",
        details: { queue: queue.name, jobName: jobDef.name },
      });
    }
    registration.named.set(jobDef.name, {
      handler: handler as JobHandler<unknown, unknown>,
      hooks: options?.hooks as WorkerHooks | undefined,
    });
    if (options?.defaultForQueue) registration.defaultName = jobDef.name;
    else if (registration.defaultName === jobDef.name) registration.defaultName = undefined;
    this.registrations.set(queue.name, registration);
  }

  async ready(queues?: readonly QueueDefinition[], options?: JobLifecycleOptions): Promise<void> {
    validateLifecycle(options);
    this.assertNotStopping();
    await this.queueManager.ready(queues ?? [this.defaultQueue], options);
  }

  start(options?: JobLifecycleOptions): Promise<void> {
    try {
      validateLifecycle(options);
      if (this.stopping) this.assertNotStopping();
      if (this.starting) return this.starting;
      this.assertNotStopping();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.state === "started") return Promise.resolve();
    this.state = "starting";
    const controller = new AbortController();
    this.controller = controller;
    const operation = this.queueManager
      .waitForReady(controller.signal, async () => {
        for (const registration of this.registrations.values()) {
          if (controller.signal.aborted) throw cancelled();
          this.queueManager.getOrCreateQueue(registration.queue);
          const select = (name: string) =>
            registration.named.get(name) ??
            (registration.defaultName === undefined ? undefined : registration.named.get(registration.defaultName));
          const processor = async (job: Job<unknown, unknown, string>) => {
            const selected = select(job.name);
            if (!selected) throw new HandlerNotRegisteredError(job.name);
            const ctx: JobHandlerContext = {
              jobName: job.name,
              jobId: String(job.id),
              attempt: job.attemptsMade + 1,
              timestamp: new Date(job.timestamp),
              logger: this.logger,
              rawJob: job,
            };
            return await selected.handler(job.data, ctx);
          };
          await this.queueManager.createWorker(registration.queue, processor, {
            logger: this.logger,
            backendHooks: this.hooks,
            selectHooks: (name) => select(name)?.hooks,
          });
        }
      })
      .then(async () => {
        if (controller.signal.aborted) throw cancelled();
        await this.queueManager.startWorkers(controller.signal);
        if (controller.signal.aborted) throw cancelled();
        this.state = "started";
      })
      .catch(async (error: unknown) => {
        this.state = "stopping";
        try {
          await this.queueManager.closeAll();
        } catch (cleanupError) {
          throw new AggregateError(
            cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError],
            "Startup failed and cleanup failed",
            { cause: error },
          );
        }
        throw error;
      })
      .finally(() => {
        this.starting = undefined;
        this.startWork = undefined;
        this.controller = undefined;
        if (this.state !== "started" && !this.stopping) this.state = "idle";
      });
    this.startWork = operation;
    this.starting = withDeadline(operation, options, () => {
      controller.abort();
      if (this.startWork) this.state = "stopping";
      else {
        // A late success has already left the startup cleanup chain.
        // 起動完了後に期限超過を検知した場合も Worker / Queue を回収する。
        void this.stop().catch(() => {}); // Manager diagnostics retain cleanup failures.
      }
    });
    return this.starting;
  }

  stop(options?: JobLifecycleOptions): Promise<void> {
    try {
      validateLifecycle(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.stopping) return this.stopping;
    this.state = "stopping";
    this.controller?.abort();
    const work = (async () => {
      if (this.startWork)
        await this.startWork.catch((error: unknown) => {
          if (error instanceof AggregateError && error.cause !== undefined) throw error;
        });
      await this.queueManager.closeAll();
    })();
    this.stopping = withDeadline(work, options);
    void work.then(
      () => {
        this.state = "idle";
        this.stopping = undefined;
      },
      () => {
        this.state = "idle";
        this.stopping = undefined;
      },
    );
    return this.stopping;
  }

  async pauseAll(): Promise<void> {
    if (this.state !== "started") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "backend.pauseAll",
          subject: "backend",
          state: `backend:${this.state}`,
        }),
        details: { backendState: this.state },
      });
    }
    await this.queueManager.pauseAll();
  }

  async resumeAll(): Promise<void> {
    if (this.state !== "started") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "backend.resumeAll",
          subject: "backend",
          state: `backend:${this.state}`,
        }),
        details: { backendState: this.state },
      });
    }
    await this.queueManager.resumeAll();
  }

  async pauseQueue(queue: QueueDefinition): Promise<void> {
    if (this.state !== "started") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "backend.pauseQueue",
          subject: `queue:${queue.name}`,
          state: `backend:${this.state}`,
        }),
        details: { backendState: this.state, queue: queue.name },
      });
    }
    await this.queueManager.pauseQueue(queue.name);
  }

  async resumeQueue(queue: QueueDefinition): Promise<void> {
    if (this.state !== "started") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "backend.resumeQueue",
          subject: `queue:${queue.name}`,
          state: `backend:${this.state}`,
        }),
        details: { backendState: this.state, queue: queue.name },
      });
    }
    await this.queueManager.resumeQueue(queue.name);
  }
}

/**
 * Create a BullMQ-backed {@link JobBackend}.
 *
 * BullMQ を使う {@link JobBackend} を作成する。
 */
export function createBullmqBackend(options: BullmqBackendOptions): JobBackend {
  return new BullmqBackend(options);
}
