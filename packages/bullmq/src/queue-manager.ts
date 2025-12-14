import { formatInvalidStateMessage, InvalidStateError } from "@mokurokujs/core";
import { type ConnectionOptions, type Job, Queue, Worker, type WorkerOptions } from "bullmq";
import { z } from "zod";

import { InvalidConfigError, MissingConfigError, WorkerAlreadyExistsError } from "./errors.js";

import type { JobHandlerContext, JobLogger, QueueDefinition, WorkerHooks } from "@mokurokujs/core";
import type { BullmqBackend } from "./backend.js";
import type { BullmqJobScheduler } from "./scheduler.js";
import type { BullMQConnectionDefinition, BullMQQueueDefinition, BullmqQueueConfig } from "./types.js";

export type { WorkerHooks } from "@mokurokujs/core";

type ValidatedBullmqConfig = BullmqQueueConfig & {
  connection?: ConnectionOptions;
};

const FunctionSchema = z.custom<(...args: unknown[]) => unknown>((v) => typeof v === "function");
const WorkerHooksSchema = z
  .object({
    onWorkerError: FunctionSchema.optional(),
    onStart: FunctionSchema.optional(),
    onSuccess: FunctionSchema.optional(),
    onRetry: FunctionSchema.optional(),
    onFailure: FunctionSchema.optional(),
  })
  .passthrough();
const UnknownObjectSchema = z.record(z.string(), z.any());
const BullmqConfigSchema = z
  .object({
    connection: UnknownObjectSchema.optional(),
    queueOptions: UnknownObjectSchema.optional(),
    workerOptions: UnknownObjectSchema.optional(),
    hooks: WorkerHooksSchema.optional(),
  })
  .passthrough();
const QueueDefinitionConfigSchema = z
  .object({
    bullmq: BullmqConfigSchema.optional(),
  })
  .passthrough()
  .optional();

/**
 * Validate and extract BullMQ config from {@link QueueDefinition}.
 *
 * We validate shape defensively because `config` is user-provided and typed as
 * `unknown` in the core package. `.passthrough()` keeps forward-compat fields.
 *
 * {@link QueueDefinition} の `config` から BullMQ 設定を検証して取り出す。
 * `config` は利用側が自由に渡せる `unknown` なので、形を防御的に検証する。
 * `.passthrough()` により将来フィールドが増えても破壊的にならない。
 */
function getValidatedBullmqConfig(queueDef: QueueDefinition): ValidatedBullmqConfig {
  const parsed = QueueDefinitionConfigSchema.safeParse(queueDef.config);
  if (!parsed.success) {
    throw new InvalidConfigError(queueDef.name, parsed.error.issues);
  }
  return (parsed.data?.bullmq ?? {}) as unknown as ValidatedBullmqConfig;
}

/**
 * BullMQ {@link Queue}/{@link Worker} instance manager.
 *
 * - Caches one {@link Queue} per queue name.
 * - Caches one {@link Worker} per queue name (creating a second one is an error).
 * - Intended to be shared between {@link BullmqBackend} and {@link BullmqJobScheduler}.
 *
 * BullMQ の {@link Queue}/{@link Worker} インスタンスを管理する。
 * - キュー名ごとに {@link Queue} を1つキャッシュする
 * - キュー名ごとに {@link Worker} を1つキャッシュする（二重作成はエラー）
 * - {@link BullmqBackend}（worker）と {@link BullmqJobScheduler} で共有利用する想定
 */
export class BullMQQueueManager {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Queue>();
  private readonly workers = new Map<string, Worker>();

  /**
   * Manager state used to reject new operations during shutdown.
   *
   * - `active`: normal operation
   * - `closing`: `closeAll()` is in progress
   *
   * シャットダウン中に新しい操作を拒否するための状態。
   * - `active`: 通常動作
   * - `closing`: `closeAll()` 実行中
   */
  private state: "active" | "closing" = "active";

  constructor(connection: ConnectionOptions | BullMQConnectionDefinition) {
    this.connection = this.resolveConnection(connection);
  }

  /**
   * Resolve BullMQ connection options.
   *
   * When a {@link QueueDefinition} is provided, this reads
   * `config.bullmq.connection`.
   * This lets callers provide connection info using the same "definition" shape.
   *
   * BullMQ の接続情報を解決する。
   * {@link QueueDefinition} が渡された場合は `config.bullmq.connection` から取り出す。
   */
  private resolveConnection(conn: ConnectionOptions | BullMQConnectionDefinition): ConnectionOptions {
    if ("name" in conn && "config" in conn) {
      const config = getValidatedBullmqConfig(conn);
      const resolved = config.connection;
      if (!resolved) {
        throw new MissingConfigError(conn.name, "connection");
      }
      return resolved as unknown as ConnectionOptions;
    }
    return conn as ConnectionOptions;
  }

  /**
   * Get an existing {@link Queue} instance or create a new one.
   *
   * Queue options are sourced from {@link QueueDefinition}:
   * `config.bullmq.queueOptions`.
   *
   * {@link Queue} インスタンスを取得または作成する。
   * キューオプションは {@link QueueDefinition} の `config.bullmq.queueOptions` から取得する。
   */
  getOrCreateQueue(queueDef: QueueDefinition): Queue {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "queue.getOrCreate",
          subject: `queue:${queueDef.name}`,
          state: `manager:${this.state}`,
        }),
        details: { queue: queueDef.name, managerState: this.state },
      });
    }

    const existing = this.queues.get(queueDef.name);
    if (existing) return existing;

    const config = getValidatedBullmqConfig(queueDef);
    const queue = new Queue(queueDef.name, {
      connection: this.connection,
      ...(config.queueOptions ?? {}),
    });
    this.queues.set(queueDef.name, queue);

    return queue;
  }

  /**
   * Create and start a {@link Worker} for a queue (backend usage).
   *
   * Hooks are evaluated in this order:
   * backend-level → queue-level → job-level
   *
   * @see WorkerHooks
   * @see JobHandlerContext
   *
   * {@link Worker} を作成して起動する（backend 用）。
   * フック呼び出し順は backend → queue → job。
   */
  async createWorker(
    queueDef: BullMQQueueDefinition,
    processor: (job: Job) => Promise<void>,
    options?: {
      logger?: JobLogger;
      backendHooks?: WorkerHooks;
      jobHooks?: Map<string, WorkerHooks>;
    },
  ): Promise<Worker> {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.create",
          subject: `queue:${queueDef.name}`,
          state: `manager:${this.state}`,
        }),
        details: { queue: queueDef.name, managerState: this.state },
      });
    }

    const existing = this.workers.get(queueDef.name);
    if (existing) {
      throw new WorkerAlreadyExistsError(queueDef.name);
    }

    const config = getValidatedBullmqConfig(queueDef);
    const workerOptions: WorkerOptions = {
      connection: this.connection,
      autorun: false,
      ...(config.workerOptions ?? {}),
    };

    const worker = new Worker(queueDef.name, processor, workerOptions);

    // QueueDefinition 由来のキュー単位フック。
    const queueHooks = config.hooks;

    // backend/queue/job の3レベルのフックを合成する。
    worker.on("active", (job) => {
      options?.logger?.debug("job.active", {
        jobName: job.name,
        jobId: job.id,
      });

      const ctx: JobHandlerContext = {
        jobName: job.name,
        jobId: String(job.id),
        attempt: job.attemptsMade + 1,
        timestamp: new Date(job.timestamp),
        logger: options?.logger,
      };
      options?.backendHooks?.onStart?.(ctx);
      queueHooks?.onStart?.(ctx);
      options?.jobHooks?.get(job.name)?.onStart?.(ctx);
    });

    worker.on("completed", (job) => {
      options?.logger?.info("job.completed", {
        jobName: job.name,
        jobId: job.id,
      });

      const ctx: JobHandlerContext = {
        jobName: job.name,
        jobId: String(job.id),
        attempt: job.attemptsMade + 1,
        timestamp: new Date(job.timestamp),
        logger: options?.logger,
      };
      options?.backendHooks?.onSuccess?.(ctx);
      queueHooks?.onSuccess?.(ctx);
      options?.jobHooks?.get(job.name)?.onSuccess?.(ctx);
    });

    worker.on("failed", (job, err) => {
      if (!job) return;

      const ctx: JobHandlerContext = {
        jobName: job.name,
        jobId: String(job.id),
        // BullMQ の仕様: `failed` イベント時点の `attemptsMade` は今回の試行を含んだ値になっている。
        attempt: job.attemptsMade,
        timestamp: new Date(job.timestamp),
        logger: options?.logger,
      };

      const maxAttempts = job.opts.attempts ?? 1;
      const remainingAttempts = maxAttempts - job.attemptsMade;

      if (remainingAttempts > 0) {
        options?.backendHooks?.onRetry?.(ctx, err, remainingAttempts);
        queueHooks?.onRetry?.(ctx, err, remainingAttempts);
        options?.jobHooks?.get(job.name)?.onRetry?.(ctx, err, remainingAttempts);
      } else {
        options?.backendHooks?.onFailure?.(ctx, err);
        queueHooks?.onFailure?.(ctx, err);
        options?.jobHooks?.get(job.name)?.onFailure?.(ctx, err);
      }

      options?.logger?.error("job.failed", {
        jobName: job.name,
        jobId: job.id,
        error: err,
      });
    });

    worker.on("error", (err) => {
      options?.logger?.error("worker.error", {
        queue: queueDef.name,
        error: err,
      });

      options?.backendHooks?.onWorkerError?.({
        queue: queueDef.name,
        error: err,
      });
      queueHooks?.onWorkerError?.({ queue: queueDef.name, error: err });
    });

    this.workers.set(queueDef.name, worker);

    // `autorun: false` にして、リスナーを付けてから起動する。
    // `run()` 失敗時に unhandled rejection にならないよう `catch` する。
    worker.run().catch((err) => {
      options?.logger?.error("worker.run.error", {
        queue: queueDef.name,
        error: err,
      });

      options?.backendHooks?.onWorkerError?.({
        queue: queueDef.name,
        error: err,
      });
      queueHooks?.onWorkerError?.({ queue: queueDef.name, error: err });
    });

    return worker;
  }

  /**
   * Close all workers and queues managed by this instance.
   *
   * If `timeout` is set, workers that do not shut down in time may be forced.
   *
   * 管理中の Worker/Queue をすべて閉じる。
   * `timeout` を指定した場合、期限内に止まらない Worker を強制停止することがある。
   */
  async closeAll(options?: { timeout?: number }): Promise<void> {
    if (this.state === "closing") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "manager.closeAll",
          subject: "queueManager",
          state: "manager:closing",
        }),
        details: { managerState: this.state },
      });
    }

    this.state = "closing";

    const workers = Array.from(this.workers.values());
    const queues = Array.from(this.queues.values());

    const closeWorkers = (force: boolean) => Promise.all(workers.map((worker) => worker.close(force)));
    const closeQueues = () => Promise.all(queues.map((queue) => queue.close()));

    if (options?.timeout == null) {
      await closeWorkers(false);
      await closeQueues();
    } else {
      // 期限付きで graceful close を試し、タイムアウトしたら強制停止する。
      const timeoutError = new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "manager.closeAll",
          subject: "queueManager",
          state: `timeout:${options.timeout}`,
        }),
        details: { timeout: options.timeout },
      });
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const gracefulClose = closeWorkers(false);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(timeoutError), options.timeout);
      });

      let timedOut = false;
      try {
        await Promise.race([gracefulClose, timeoutPromise]);
        await gracefulClose;
      } catch (error) {
        if (error === timeoutError) {
          timedOut = true;
          gracefulClose.catch(() => {});
        } else {
          throw error;
        }
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }

      if (timedOut) {
        await closeWorkers(true);
      }

      // worker 停止後に queue を閉じる（途中の Redis コマンドを壊さないため）。
      await closeQueues();
    }

    this.workers.clear();
    this.queues.clear();
    this.state = "active";
  }

  /**
   * Pause all workers.
   * New jobs will not be picked up, but in-flight jobs keep running.
   *
   * すべての Worker を一時停止する。
   * 新規ジョブの取得を止めるが、実行中ジョブは完了まで継続する。
   */
  async pauseAll(): Promise<void> {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.pauseAll",
          subject: "queueManager",
          state: `manager:${this.state}`,
        }),
        details: { managerState: this.state },
      });
    }

    const workers = Array.from(this.workers.values());
    await Promise.all(workers.map((worker) => worker.pause()));
  }

  /**
   * Resume all paused workers.
   *
   * すべての Worker を再開する。
   */
  async resumeAll(): Promise<void> {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.resumeAll",
          subject: "queueManager",
          state: `manager:${this.state}`,
        }),
        details: { managerState: this.state },
      });
    }

    const workers = Array.from(this.workers.values());
    await Promise.all(workers.map((worker) => worker.resume()));
  }

  /**
   * Pause the worker for a specific queue name.
   *
   * 指定したキュー名の Worker を一時停止する。
   */
  async pauseQueue(queueName: string): Promise<void> {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.pauseQueue",
          subject: `queue:${queueName}`,
          state: `manager:${this.state}`,
        }),
        details: { queue: queueName, managerState: this.state },
      });
    }

    const worker = this.workers.get(queueName);
    if (!worker) {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.pauseQueue",
          subject: `queue:${queueName}`,
          state: "worker:missing",
        }),
        details: { queue: queueName },
      });
    }

    await worker.pause();
  }

  /**
   * Resume the worker for a specific queue name.
   *
   * 指定したキュー名の Worker を再開する。
   */
  async resumeQueue(queueName: string): Promise<void> {
    if (this.state !== "active") {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.resumeQueue",
          subject: `queue:${queueName}`,
          state: `manager:${this.state}`,
        }),
        details: { queue: queueName, managerState: this.state },
      });
    }

    const worker = this.workers.get(queueName);
    if (!worker) {
      throw new InvalidStateError({
        message: formatInvalidStateMessage({
          action: "worker.resumeQueue",
          subject: `queue:${queueName}`,
          state: "worker:missing",
        }),
        details: { queue: queueName },
      });
    }

    await worker.resume();
  }

  /**
   * Get the resolved BullMQ connection options.
   *
   * 解決済みの BullMQ 接続情報を取得する。
   */
  getConnection(): ConnectionOptions {
    return this.connection;
  }
}
