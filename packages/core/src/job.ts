import type { QueueDefinition } from "./queue.js";

/**
 * Retry backoff strategy.
 *
 * - `fixed`/`exponential`: handled by the backend if supported.
 * - `custom`: interpreted by the backend adapter (implementation-specific).
 *
 * リトライ時のバックオフ戦略。
 * - `fixed`/`exponential`: バックエンドが対応していれば利用される
 * - `custom`: バックエンドアダプタ側で解釈/実装する（実装依存）
 */
export type JobBackoff = { type: "fixed"; delay: number } | { type: "exponential"; delay: number } | { type: "custom" };

/**
 * Job retention policy after completion/failure.
 *
 * - `true`: remove immediately
 * - `false`: keep indefinitely (backend default)
 * - `number`: keep up to N jobs
 * - `{ age, count }`: remove when older than `age` seconds and/or over `count`
 *
 * ジョブの保持/削除ポリシー（完了/失敗後）。
 * - `true`: 即時削除
 * - `false`: 保持（バックエンド既定）
 * - `number`: 件数上限を超えたら古いものから削除
 * - `{ age, count }`: `age` 秒経過、または `count` 件超で削除
 */
export type JobRemovePolicy = boolean | number | { age?: number; count?: number };

/**
 * Backend-agnostic enqueue options attached to a job definition.
 * Some backends may ignore unsupported options.
 *
 * MQ非依存のジョブオプション。
 * バックエンドが未対応の項目は無視される場合がある。
 * @see QueueDefinition
 * @see JobDefinition
 */
export interface JobOptions {
  /**
   * Target queue for this job. If omitted, the backend default queue is used.
   *
   * 対象キュー。省略時はバックエンド側のデフォルトキューが使われる。
   */
  queue?: QueueDefinition;

  /**
   * Max attempts including the initial run (e.g. `3` means up to 2 retries).
   *
   * 最大試行回数（初回を含む）。例: `3` は最大2回のリトライ。
   */
  attempts?: number;

  /**
   * Backoff strategy between retries.
   *
   * リトライ間隔のバックオフ戦略。
   */
  backoff?: JobBackoff;

  /**
   * Job priority (only effective if the backend supports it).
   *
   * 優先度（バックエンドが対応している場合のみ有効）。
   */
  priority?: number;

  /**
   * Retention policy after successful completion.
   *
   * 成功時の保持/削除ポリシー。
   */
  removeOnComplete?: JobRemovePolicy;

  /**
   * Retention policy after failure (after retries are exhausted).
   *
   * 失敗時（リトライ枯渇後）の保持/削除ポリシー。
   */
  removeOnFail?: JobRemovePolicy;
}

/**
 * Job definition (name + default options).
 *
 * {@link JobDefinition} is backend-agnostic and can be shared between adapters.
 *
 * ジョブ定義（名前 + 既定オプション）。
 * {@link JobDefinition} は MQ 非依存で、アダプタ間で共通利用できる。
 */
export interface JobDefinition<TPayload> {
  readonly name: string;
  readonly options: Readonly<JobOptions>;
  /**
   * Type-only field to preserve payload type information.
   * Not used at runtime.
   *
   * payload 型を保持するための型専用フィールド。
   * 実行時には参照されない。
   */
  readonly __payloadType?: TPayload;
}

/**
 * Create a job definition.
 *
 * ジョブ定義を作成する（MQ 非依存）。
 */
export function defineJob<TPayload>(name: string, options: JobOptions = {}): JobDefinition<TPayload> {
  return { name, options };
}
