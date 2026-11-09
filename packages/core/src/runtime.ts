import { InvalidStateError } from "./errors.js";

import type {
  BulkEnqueueItem,
  EnqueueOptions,
  EnqueueResult,
  JobBackend,
  JobLifecycleOptions,
  RegisterHandlerOptions,
} from "./backend.js";
import type { JobHandler } from "./handler.js";
import type { JobDefinition } from "./job.js";
import type { QueueDefinition } from "./queue.js";

/**
 * Main entry point for applications.
 *
 * This is a backend-agnostic facade that exposes a small surface area:
 * enqueue, register handlers, and control worker lifecycle.
 *
 * アプリケーション向けの入口。
 * バックエンド非依存の薄いファサードとして、enqueue/handler登録/ライフサイクル制御のみを公開する。
 *
 * This is a facade over {@link JobBackend}.
 * これは {@link JobBackend} のファサード。
 */
export class JobRuntime {
  private readonly backend: JobBackend;

  constructor(backend: JobBackend) {
    this.backend = backend;
  }

  /**
   * Enqueue a job.
   *
   * `options` can override parts of {@link JobDefinition} `options` at enqueue time.
   *
   * ジョブを enqueue する。
   * `options` により {@link JobDefinition} の `options` の一部を enqueue 時に上書きできる。
   *
   * @see EnqueueOptions
   * @see EnqueueResult
   */
  async enqueue<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    payload: NoInfer<TPayload>,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    return await this.backend.enqueue(job, payload, options);
  }

  /**
   * Enqueue multiple jobs in a batch.
   *
   * 複数ジョブをまとめて enqueue する。
   *
   * @see BulkEnqueueItem
   * @see EnqueueResult
   */
  async enqueueBulk<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    items: BulkEnqueueItem<NoInfer<TPayload>>[],
  ): Promise<EnqueueResult[]> {
    return await this.backend.enqueueBulk(job, items);
  }

  /**
   * Register a handler for a job.
   *
   * Some backends create workers based on handler registration, so register
   * handlers before calling `start()`.
   *
   * ジョブの handler を登録する。
   * バックエンドによっては handler 登録を根拠に Worker を作るため、`start()` の前に登録する。
   *
   * @see RegisterHandlerOptions
   */
  handle<TPayload, TResult = void>(
    job: JobDefinition<TPayload, TResult>,
    handler: JobHandler<NoInfer<TPayload>, NoInfer<TResult>>,
    options?: RegisterHandlerOptions,
  ): void {
    this.backend.registerHandler(job, handler, options);
  }

  /**
   * Wait for queue connections without starting workers.
   * Worker を起動せずにキュー接続の準備完了を待つ。
   */
  ready(queues?: readonly QueueDefinition[], options?: JobLifecycleOptions): Promise<void> {
    if (!this.backend.ready) {
      return Promise.reject(
        new InvalidStateError({
          message: "Backend does not support readiness",
          details: { capability: "ready" },
        }),
      );
    }
    return this.backend.ready(queues, options);
  }

  /**
   * Start workers (and any backend runtime resources).
   *
   * Worker を起動する（バックエンド側の実行リソースも含む）。
   */
  start(options?: JobLifecycleOptions): Promise<void> {
    return this.backend.start(options);
  }

  /**
   * Stop workers.
   *
   * The backend applies timeout as a deadline for the entire operation.
   *
   * バックエンドは timeout を操作全体の期限として扱う。
   */
  stop(options?: JobLifecycleOptions): Promise<void> {
    return this.backend.stop(options);
  }

  /**
   * Pause all workers.
   * New jobs will not be picked up, but in-flight jobs keep running.
   *
   * すべての Worker を一時停止する。
   * 新規ジョブの取得を止めるが、実行中ジョブは完了まで継続する。
   */
  pauseAll(): Promise<void> {
    return this.backend.pauseAll();
  }

  /**
   * Resume all paused workers.
   *
   * すべての Worker を再開する。
   */
  resumeAll(): Promise<void> {
    return this.backend.resumeAll();
  }

  /**
   * Pause workers for a specific queue.
   *
   * 指定したキューの Worker を一時停止する。
   */
  pauseQueue(queue: QueueDefinition): Promise<void> {
    return this.backend.pauseQueue(queue);
  }

  /**
   * Resume workers for a specific queue.
   *
   * 指定したキューの Worker を再開する。
   */
  resumeQueue(queue: QueueDefinition): Promise<void> {
    return this.backend.resumeQueue(queue);
  }
}
