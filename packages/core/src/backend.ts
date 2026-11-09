import type { JobHandler } from "./handler.js";
import type { JobBackoff, JobDefinition, JobRemovePolicy } from "./job.js";
import type { QueueDefinition } from "./queue.js";

/**
 * Result of an enqueue call.
 *
 * enqueue の結果。
 */
export interface EnqueueResult {
  /**
   * Backend-specific job identifier.
   *
   * バックエンド固有のジョブID。
   */
  jobId: string;
  /**
   * Enqueued job name.
   *
   * enqueue されたジョブ名。
   */
  name: string;
}

/**
 * Enqueue-time overrides (backend-agnostic).
 * These values override the defaults in {@link JobDefinition#options}.
 *
 * enqueue 時の上書きオプション（MQ非依存）。
 * {@link JobDefinition#options} の既定値を上書きする。
 */
export interface EnqueueOptions {
  /**
   * Overrides {@link JobDefinition#options#attempts}.
   *
   * {@link JobDefinition#options#attempts} を上書きする。
   */
  attempts?: number;
  /**
   * Overrides {@link JobDefinition#options#backoff}.
   *
   * {@link JobDefinition#options#backoff} を上書きする。
   */
  backoff?: JobBackoff;
  /**
   * Overrides {@link JobDefinition#options#removeOnComplete}.
   *
   * {@link JobDefinition#options#removeOnComplete} を上書きする。
   */
  removeOnComplete?: JobRemovePolicy;
  /**
   * Overrides {@link JobDefinition#options#removeOnFail}.
   *
   * {@link JobDefinition#options#removeOnFail} を上書きする。
   */
  removeOnFail?: JobRemovePolicy;
  /**
   * Overrides job name used for enqueue (default: {@link JobDefinition#name}).
   * Useful when you want the same handler logic but separate job names.
   *
   * enqueue するジョブ名の上書き（既定: {@link JobDefinition#name}）。
   * 同じ処理ロジックを使いつつジョブ名を分けたい場合に使う。
   */
  jobName?: string;
  /**
   * Delay before the job becomes eligible to run (milliseconds).
   *
   * 遅延実行（ミリ秒）。
   */
  delay?: number;
  /**
   * Override or set the backend-specific job identifier.
   * When the backend supports it, enqueueing twice with the same `jobId`
   * keeps the first job and lets the backend ignore the duplicate.
   *
   * バックエンド固有のジョブIDを指定する。
   * バックエンドが対応している場合、同じ `jobId` で2回 enqueue すると
   * 最初のジョブが保持され、重複分はバックエンド側で無視される。
   */
  jobId?: string;
}

/**
 * Item for `enqueueBulk`.
 *
 * `enqueueBulk` 用のアイテム。
 */
export interface BulkEnqueueItem<TPayload> {
  payload: TPayload;
  options?: EnqueueOptions;
}

/**
 * Options for handler registration.
 *
 * `hooks` is intentionally `unknown`: backend adapters may define their own
 * hook types and cast/validate them.
 *
 * ハンドラー登録時のオプション。
 * `hooks` は `unknown` としておき、バックエンドアダプタ側で独自型に変換/検証できるようにする。
 */
export interface RegisterHandlerOptions {
  /**
   * Use this handler as the fallback for its queue.
   * このハンドラーを対象キューのフォールバックとして使う。
   */
  defaultForQueue?: boolean;
  hooks?: unknown;
  [key: string]: unknown;
}

/**
 * Lifecycle operation options. Timeout is an operation deadline in milliseconds.
 * ライフサイクル操作の設定。timeout は操作全体の期限（ミリ秒）。
 */
export interface JobLifecycleOptions {
  timeout?: number;
}

/**
 * Backend adapter interface implemented by queue providers (BullMQ, etc.).
 *
 * キュープロバイダ（BullMQ 等）が実装するバックエンドアダプタのインターフェース。
 */
export interface JobBackend {
  enqueue<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;

  enqueueBulk<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    items: BulkEnqueueItem<TPayload>[],
  ): Promise<EnqueueResult[]>;

  registerHandler<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    handler: JobHandler<TPayload, unknown>,
    options?: RegisterHandlerOptions,
  ): void;

  ready?(queues?: readonly QueueDefinition[], options?: JobLifecycleOptions): Promise<void>;

  start(options?: JobLifecycleOptions): Promise<void>;
  stop(options?: JobLifecycleOptions): Promise<void>;

  /**
   * Pause all workers.
   * New jobs will not be picked up, but in-flight jobs keep running.
   *
   * すべての Worker を一時停止する。
   * 新規ジョブの取得を止めるが、実行中ジョブは完了まで継続する。
   */
  pauseAll(): Promise<void>;

  /**
   * Resume all paused workers.
   *
   * すべての Worker を再開する。
   */
  resumeAll(): Promise<void>;

  /**
   * Pause workers for a specific queue.
   *
   * 指定したキューの Worker を一時停止する。
   */
  pauseQueue(queue: QueueDefinition): Promise<void>;

  /**
   * Resume workers for a specific queue.
   *
   * 指定したキューの Worker を再開する。
   */
  resumeQueue(queue: QueueDefinition): Promise<void>;
}
