/**
 * Minimal logger interface used by mokuroku.
 *
 * mokuroku が利用する最小ロガーインターフェース。
 */
export interface JobLogger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/**
 * Backend-agnostic context passed to a job handler.
 *
 * MQ 非依存のハンドラー実行コンテキスト。
 * @see JobHandler
 * @see JobLogger
 */
export interface JobHandlerContext {
  jobName: string;
  jobId: string;
  /**
   * Attempt number for this execution (1-based).
   *
   * 今回の実行試行回数（1始まり）。
   */
  attempt: number;
  timestamp: Date;
  logger?: JobLogger;
  /**
   * Backend-native job object (if available).
   *
   * This is an escape hatch for adapters/compat layers that need access to
   * provider-specific features while keeping the main API backend-agnostic.
   *
   * バックエンド固有の Job オブジェクト（存在する場合）。
   * MQ 非依存の設計を保ちつつ、必要に応じてプロバイダ固有機能へアクセスするための逃げ道。
   */
  rawJob?: unknown;
}

/**
 * Job handler function.
 *
 * ジョブハンドラー関数。
 */
export type JobHandler<TPayload> = (payload: TPayload, ctx: JobHandlerContext) => Promise<void>;
