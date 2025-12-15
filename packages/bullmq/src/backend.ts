import { formatInvalidStateMessage, HandlerNotRegisteredError, InvalidStateError } from "@mokurokujs/core";

import type {
  BackendHooks,
  BulkEnqueueItem,
  EnqueueOptions,
  EnqueueResult,
  JobBackend,
  JobDefinition,
  JobHandler,
  JobHandlerContext,
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

  private readonly handlers = new Map<string, JobHandler<unknown>>();
  /**
   * Job-level hooks configured via `registerHandler(..., { hooks })`.
   *
   * `registerHandler(..., { hooks })` で設定されるジョブ単位フック。
   */
  private readonly jobHooks = new Map<string, WorkerHooks>();

  /**
   * Mapping from handled job name → queue definition.
   *
   * This is the source of truth for worker creation:
   * - Only jobs that have handlers registered contribute to worker creation.
   * - Multiple jobs on the same queue are processed by a single worker.
   *
   * handler 登録済みジョブ名 → キュー定義の対応表。
   * Worker 作成の根拠として使う:
   * - handler 登録されたジョブのみが Worker 作成対象になる
   * - 同じキューに属する複数ジョブは1つの Worker で処理する
   */
  private readonly handledJobsQueueMap = new Map<string, BullMQQueueDefinition>();

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
   * Currently this is a pass-through because the shapes are compatible.
   *
   * {@link JobRemovePolicy} を BullMQ の keep-jobs 形式へ変換する。
   * 現状は形が互換なのでそのまま返す。
   */
  private convertRemovePolicy(
    policy: JobRemovePolicy | undefined,
  ): boolean | number | { age?: number; count?: number } | undefined {
    return policy;
  }

  /**
   * Build BullMQ {@link JobsOptions} by combining job defaults and enqueue overrides.
   *
   * job 既定値と enqueue 上書きを合成して BullMQ の {@link JobsOptions} を作る。
   */
  private buildJobsOptions<TPayload>(jobDef: JobDefinition<TPayload>, enqueueOptions?: EnqueueOptions): JobsOptions {
    return {
      attempts: enqueueOptions?.attempts ?? jobDef.options.attempts,
      backoff: enqueueOptions?.backoff ?? jobDef.options.backoff,
      priority: jobDef.options.priority,
      removeOnComplete: this.convertRemovePolicy(enqueueOptions?.removeOnComplete ?? jobDef.options.removeOnComplete),
      removeOnFail: this.convertRemovePolicy(enqueueOptions?.removeOnFail ?? jobDef.options.removeOnFail),
      delay: enqueueOptions?.delay,
    };
  }

  async enqueue<TPayload>(
    jobDef: JobDefinition<TPayload>,
    payload: TPayload,
    enqueueOptions?: EnqueueOptions,
  ): Promise<EnqueueResult> {
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
    jobDef: JobDefinition<TPayload>,
    items: BulkEnqueueItem<TPayload>[],
  ): Promise<EnqueueResult[]> {
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

  registerHandler<TPayload>(
    jobDef: JobDefinition<TPayload>,
    handler: JobHandler<TPayload>,
    options?: RegisterHandlerOptions,
  ): void {
    if (this.handlers.has(jobDef.name)) {
      this.logger?.warn(`Handler for job "${jobDef.name}" is being replaced`);
    }
    this.handlers.set(jobDef.name, handler as JobHandler<unknown>);
    const queueDef = this.normalizeQueueDefinition(jobDef.options.queue ?? this.defaultQueue);
    // `start()` がキューごとに1つだけ Worker を作れるよう対応表を記録する。
    this.handledJobsQueueMap.set(jobDef.name, queueDef);
    // 共有キューマネージャー側で合成できるよう、ジョブ単位フックを保存する。
    if (options?.hooks) {
      this.jobHooks.set(jobDef.name, options.hooks as WorkerHooks);
    }
  }

  async start(): Promise<void> {
    if (this.state === "started") {
      this.logger?.warn("Backend is already started, ignoring duplicate start() call");
      return;
    }
    if (this.state === "starting") {
      this.logger?.warn("Backend is currently starting, ignoring duplicate start() call");
      return;
    }
    if (this.state === "stopping") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "backend.start",
          subject: "backend",
          state: `backend:${this.state}`,
        }),
        details: { backendState: this.state },
      });
    }

    this.state = "starting";

    try {
      // handler 登録されたジョブのキューを集約し、キューごとに Worker を作る。
      const queuesByName = new Map<string, BullMQQueueDefinition>();

      for (const [, queueDef] of this.handledJobsQueueMap.entries()) {
        if (!queuesByName.has(queueDef.name)) {
          queuesByName.set(queueDef.name, queueDef);
        }
      }

      for (const [, queueDef] of queuesByName.entries()) {
        const processor = async (job: Job) => {
          const handler = this.handlers.get(job.name);
          if (!handler) {
            const error = new HandlerNotRegisteredError(job.name);
            this.logger?.error(error.message, {
              code: error.code,
              details: error.details,
            });
            throw error;
          }

          const ctx: JobHandlerContext = {
            jobName: job.name,
            jobId: String(job.id),
            attempt: job.attemptsMade + 1,
            timestamp: new Date(job.timestamp),
            logger: this.logger,
            rawJob: job,
          };

          await handler(job.data, ctx);
        };

        await this.queueManager.createWorker(queueDef, processor, {
          logger: this.logger,
          backendHooks: this.hooks,
          jobHooks: this.jobHooks,
        });
      }

      this.state = "started";
    } catch (error) {
      this.state = "idle";
      throw error;
    }
  }

  async stop(options?: { timeout?: number }): Promise<void> {
    if (this.state === "idle") {
      this.logger?.warn("Backend is not started, ignoring stop() call");
      return;
    }
    if (this.state === "stopping") {
      this.logger?.warn("Backend is already stopping, ignoring duplicate stop() call");
      return;
    }

    this.state = "stopping";

    try {
      await this.queueManager.closeAll(options);
      this.state = "idle";
    } catch (error) {
      this.state = "idle";
      throw error;
    }
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
