import { formatInvalidStateMessage, InvalidStateError } from "@mokurokujs/core";
import { type ConnectionOptions, type Job, Queue, type Worker, type WorkerOptions } from "bullmq";
import { z } from "zod";

import { InvalidConfigError, MissingConfigError, WorkerAlreadyExistsError } from "./errors.js";

import type { JobLifecycleOptions, QueueDefinition } from "@mokurokujs/core";
import type {
  BullMQConnectionDefinition,
  BullMQQueueDefinition,
  BullmqManagerError,
  BullmqQueueConfig,
  BullmqQueueManagerOptions,
} from "./types.js";

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
    connection: z
      .custom<ConnectionOptions>((value) => value !== null && typeof value === "object" && !Array.isArray(value))
      .optional(),
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

import { asError, ConnectionMonitor, connectionHandles } from "./connection-monitor.js";
import { cancelled, validateLifecycle, withDeadline } from "./lifecycle-operation.js";
import { ManagedWorker } from "./managed-worker.js";
import { attachWorkerHooks, type WorkerRegistrationOptions } from "./worker-hooks.js";

type Resource = Queue<unknown, unknown, string> | ManagedWorker;
interface Entry {
  queue: string;
  resource: "queue" | "worker";
  value: Resource;
  monitors: ConnectionMonitor[];
  dispose: () => void;
  cleanupErrors?: Error[];
}

/** Own resources, readiness and diagnostics. / 接続・リソースの寿命と障害通知を管理する。 */
export class BullMQQueueManager {
  private readonly connection: ConnectionOptions;
  private readonly queues = new Map<string, Entry>();
  private readonly workers = new Map<string, Entry>();
  private state: "active" | "closing" | "failed" = "active";
  private closing?: Promise<void>;
  private readonly waiters = new Set<(error: Error) => void>();

  constructor(
    connection: ConnectionOptions | BullMQConnectionDefinition,
    private readonly options: BullmqQueueManagerOptions = {},
  ) {
    if (
      typeof connection === "object" &&
      "name" in connection &&
      "config" in connection &&
      typeof connection.name === "string"
    ) {
      const definition = connection as BullMQConnectionDefinition;
      getValidatedBullmqConfig(definition);
      const resolved = definition.config?.bullmq?.connection;
      if (!resolved) throw new MissingConfigError(definition.name, "connection");
      this.connection = resolved;
    } else {
      this.connection = connection as ConnectionOptions;
    }
  }

  private assertActive(): void {
    if (this.state !== "active")
      throw new InvalidStateError({
        message: formatInvalidStateMessage({ action: "manager.operation", subject: "queueManager", state: this.state }),
        details: { managerState: this.state },
      });
  }

  private notify(event: BullmqManagerError): void {
    try {
      this.options.logger?.error(`manager.${event.reason}`, { ...event });
    } catch {
      /* Diagnostics cannot break lifecycle operations. */
    }
    try {
      this.options.onError?.(event);
    } catch (error) {
      try {
        this.options.logger?.error("manager.onError.failed", { error });
      } catch {
        /* Diagnostics must not interrupt resource ownership. */
      }
    }
  }

  private failure(error: Error): void {
    for (const reject of this.waiters) reject(error);
  }

  private track(queue: string, resource: "queue" | "worker", value: Resource): Entry {
    const entry: Entry = { queue, resource, value, monitors: [], dispose: () => {} };
    const error = (error: Error) => {
      if (entry.cleanupErrors) {
        entry.cleanupErrors.push(error);
        this.notify({ queue, resource, reason: "cleanup", error });
      } else this.notify({ queue, resource, reason: "error", error });
    };
    const emitter = value as {
      on(event: "error", listener: (error: Error) => void): unknown;
      off(event: "error", listener: (error: Error) => void): unknown;
    };
    emitter.on("error", error);
    const handles = connectionHandles(value, resource === "worker");
    entry.monitors = handles.map(
      (handle, index) =>
        new ConnectionMonitor(
          handle,
          (error) => {
            this.notify({
              queue,
              resource,
              reason: "connection-ended",
              connection: index === 0 ? "command" : "blocking",
              error,
            });
            this.failure(error);
          },
          () => this.state === "closing",
          index === 1,
        ),
    );
    entry.dispose = () => {
      for (const monitor of entry.monitors) monitor.dispose();
      emitter.off("error", error);
    };
    return entry;
  }

  getOrCreateQueue(queueDef: QueueDefinition): Queue<unknown, unknown, string> {
    this.assertActive();
    const existing = this.queues.get(queueDef.name);
    if (existing) return existing.value as Queue<unknown, unknown, string>;
    if ("status" in this.connection && this.connection.status === "end") {
      const error = new Error("Redis connection already ended");
      this.notify({
        queue: queueDef.name,
        resource: "queue",
        reason: "connection-ended",
        connection: "command",
        error,
      });
      throw error;
    }
    const config = getValidatedBullmqConfig(queueDef);
    const queue = new Queue<unknown, unknown, string>(queueDef.name, {
      ...(config.queueOptions ?? {}),
      connection: this.connection,
    });
    this.queues.set(queueDef.name, this.track(queueDef.name, "queue", queue));
    return queue;
  }

  /**
   * Create a stopped worker; call startWorkers() to wait for readiness and consume.
   * Unlike older versions, createWorker never starts consumption automatically.
   * 停止状態で Worker を作成する。全接続の準備と取得開始には startWorkers() を呼ぶ。
   * 旧版の自動起動から変更しており、autorun 設定は上書きされる。
   */
  async createWorker(
    queueDef: BullMQQueueDefinition,
    processor: (job: Job<unknown, unknown, string>) => Promise<unknown>,
    options?: WorkerRegistrationOptions,
  ): Promise<Worker<unknown, unknown, string>> {
    this.assertActive();
    if (this.workers.has(queueDef.name)) throw new WorkerAlreadyExistsError(queueDef.name);
    const config = getValidatedBullmqConfig(queueDef);
    const workerOptions: WorkerOptions = {
      prefix: config.queueOptions?.prefix,
      ...(config.workerOptions ?? {}),
      connection: this.connection,
      autorun: false,
    };
    // BullMQ validates these only AFTER allocating connections (5 and 6).
    // 接続を作成してから例外を投げる設定は、構築前に検証する。
    const settings: WorkerOptions & { maxStartedAttempts?: number } = {
      concurrency: 1,
      stalledInterval: 30_000,
      drainDelay: 5,
      maxStalledCount: 1,
      ...workerOptions,
    };
    if (!settings.connection) throw new Error("Worker requires a connection");
    if (typeof processor !== "function") throw new Error("Worker requires a processor function");
    if (typeof settings.maxStalledCount !== "number" || settings.maxStalledCount < 0)
      throw new Error("maxStalledCount must be greater or equal than 0");
    if (typeof settings.maxStartedAttempts === "number" && settings.maxStartedAttempts < 0)
      throw new Error("maxStartedAttempts must be greater or equal than 0");
    if (typeof settings.stalledInterval !== "number" || settings.stalledInterval <= 0)
      throw new Error("stalledInterval must be greater than 0");
    if (typeof settings.drainDelay !== "number" || settings.drainDelay <= 0)
      throw new Error("drainDelay must be greater than 0");
    if (typeof settings.concurrency !== "number" || settings.concurrency < 1 || !Number.isFinite(settings.concurrency))
      throw new Error("concurrency must be a finite number greater than 0");
    const worker = new ManagedWorker(queueDef.name, processor, workerOptions);
    const entry = this.track(queueDef.name, "worker", worker);
    const disposeHooks = attachWorkerHooks(worker, config.hooks, options);
    const dispose = entry.dispose;
    entry.dispose = () => {
      disposeHooks();
      dispose();
      worker.onRunEnded = undefined;
    };
    worker.onRunEnded = (reason, error) => {
      this.notify({ queue: queueDef.name, resource: "worker", reason, error });
      this.failure(error);
      for (const hook of [options?.backendHooks, config.hooks]) {
        try {
          hook?.onWorkerError?.({ queue: queueDef.name, error });
        } catch (callbackError) {
          try {
            this.options.logger?.error("worker.onWorkerError.failed", { error: callbackError });
          } catch {}
        }
      }
    };
    this.workers.set(queueDef.name, entry);
    return worker;
  }

  /** Wait existing resources without starting consumption. / 取得を開始せず全接続を待つ。 */
  async waitForReady(signal?: AbortSignal, begin?: () => Promise<void> | void): Promise<void> {
    this.assertActive();
    const controller = new AbortController();
    let rejectFailure!: (error: Error) => void;
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    const abort = () => rejectFailure(cancelled());
    this.waiters.add(rejectFailure);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) throw cancelled();
      const operation = (async () => {
        await begin?.();
        if (signal?.aborted) throw cancelled();
        const entries = [...this.queues.values(), ...this.workers.values()];
        await Promise.all(
          entries.flatMap((entry) => entry.monitors.map((monitor) => monitor.ready(controller.signal))),
        );
        if (signal?.aborted) throw cancelled();
      })();
      await Promise.race([failure, operation]);
    } finally {
      controller.abort();
      this.waiters.delete(rejectFailure);
      signal?.removeEventListener("abort", abort);
    }
  }

  /** Wait for connections within a deadline that includes queue creation. / Queue 作成を含む期限内で接続を待つ。 */
  async ready(queues: readonly QueueDefinition[] = [], options?: JobLifecycleOptions): Promise<void> {
    validateLifecycle(options);
    const started = Date.now();
    this.assertActive();
    const controller = new AbortController();
    const operation = this.waitForReady(controller.signal, () => {
      for (const queue of queues) this.getOrCreateQueue(queue);
    });
    await withDeadline(operation, options, () => controller.abort(), started);
  }

  /** Start only after all resources are ready; latch immediate run exits. / 全接続準備後に取得する。 */
  async startWorkers(signal?: AbortSignal): Promise<void> {
    await this.waitForReady(signal);
    await this.waitForReady(signal, async () => {
      for (const entry of this.workers.values()) {
        if (signal?.aborted) throw cancelled();
        // The rejection observer is attached by ManagedWorker for every invocation.
        void (entry.value as ManagedWorker).run().catch(() => {});
      }
      await Promise.resolve();
    });
  }

  closeAll(options?: JobLifecycleOptions): Promise<void> {
    try {
      validateLifecycle(options);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.closing) return this.closing;
    if (this.state === "failed")
      return Promise.reject(new InvalidStateError({ message: "Manager cleanup failed; create a new manager" }));
    this.state = "closing";
    this.failure(cancelled());
    for (const entry of [...this.workers.values(), ...this.queues.values()]) entry.cleanupErrors = [];
    const close = async (entry: Entry): Promise<Error[]> => {
      const errors = entry.cleanupErrors ?? [];
      try {
        await entry.value.close();
      } catch (error) {
        const normalized = asError(error);
        if (!errors.includes(normalized)) {
          errors.push(normalized);
          this.notify({ queue: entry.queue, resource: entry.resource, reason: "cleanup", error: normalized });
        }
      } finally {
        entry.dispose();
      }
      return errors;
    };
    const cleanup = (async () => {
      const workerErrors = await Promise.all([...this.workers.values()].map(close));
      const queueErrors = await Promise.all([...this.queues.values()].map(close));
      const errors = [...workerErrors.flat(), ...queueErrors.flat()];
      if (errors.length) {
        this.state = "failed";
        throw new AggregateError(errors, "Failed to close BullMQ resources");
      }
      this.workers.clear();
      this.queues.clear();
      this.state = "active";
    })();
    this.closing = withDeadline(cleanup, options);
    void cleanup.then(
      () => {
        this.closing = undefined;
      },
      () => {
        this.closing = undefined;
      },
    );
    return this.closing;
  }

  private worker(queue: string): ManagedWorker {
    this.assertActive();
    const entry = this.workers.get(queue);
    if (!entry) throw new InvalidStateError({ message: `No worker for queue ${queue}`, details: { queue } });
    return entry.value as ManagedWorker;
  }
  async pauseAll(): Promise<void> {
    this.assertActive();
    await Promise.all([...this.workers.keys()].map((name) => this.pauseQueue(name)));
  }
  /** Check every connection once, then resume local workers. / 全接続を一度確認してローカル Worker を再開する。 */
  async resumeAll(): Promise<void> {
    this.assertActive();
    await this.waitForReady();
    await Promise.all([...this.workers.values()].map((entry) => (entry.value as ManagedWorker).resume()));
  }
  async pauseQueue(name: string): Promise<void> {
    await this.worker(name).pause();
  }
  async resumeQueue(name: string): Promise<void> {
    const worker = this.worker(name);
    await this.waitForReady();
    await worker.resume();
  }
  getConnection(): ConnectionOptions {
    return this.connection;
  }
}
