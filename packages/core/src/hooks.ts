import type { RegisterHandlerOptions } from "./backend.js";
import type { JobHandlerContext } from "./handler.js";

/**
 * Worker-level hooks (shared type).
 *
 * These hooks can be configured at multiple levels (backend / queue / job),
 * depending on the adapter.
 *
 * Worker レベルのイベントフック（共通型）。
 * アダプタによって backend / queue / job など複数レベルで設定できる。
 */
export interface WorkerHooks {
  /**
   * Worker-level error event.
   *
   * This is not a job failure; it's for infrastructure/runtime errors
   * (e.g. Redis connection issues, internal exceptions).
   *
   * Note: adapters may intentionally not expose this at the job level.
   *
   * @see RegisterHandlerOptions
   *
   * Worker 自体の error イベント。
   * ジョブ失敗ではなく、インフラ/実行系の例外（例: Redis 接続、内部例外）を扱う。
   * 注: アダプタによっては job レベルでは呼ばれない。
   *
   * @see RegisterHandlerOptions
   */
  onWorkerError?: (params: { queue: string; error: Error }) => void;

  /**
   * Called when a job starts executing.
   *
   * `ctx.attempt` is the current attempt number (1-based).
   *
   * ジョブ処理開始時に呼ばれる。
   * `ctx.attempt` は今回の試行回数（1始まり）。
   */
  onStart?: (ctx: JobHandlerContext) => void;

  /**
   * Called when a job completes successfully.
   *
   * `ctx.attempt` is the attempt number that succeeded (1-based).
   *
   * ジョブ成功時に呼ばれる。
   * `ctx.attempt` は成功した試行回数（1始まり）。
   */
  onSuccess?: (ctx: JobHandlerContext) => void;

  /**
   * Called when a job fails but will be retried.
   *
   * `remainingAttempts` is how many attempts are left after this failure.
   *
   * ジョブが失敗し、まだリトライが残っている時に呼ばれる。
   * `remainingAttempts` はこの失敗後に残る試行回数。
   */
  onRetry?: (ctx: JobHandlerContext, error: Error, remainingAttempts: number) => void;

  /**
   * Called when a job has exhausted retries and is considered failed.
   *
   * リトライを使い切って完全に失敗した時に呼ばれる。
   */
  onFailure?: (ctx: JobHandlerContext, error: Error) => void;
}

/**
 * Backend-level hooks.
 *
 * Extends {@link WorkerHooks} and adds enqueue-time hooks.
 *
 * Backend レベルのイベントフック。
 * {@link WorkerHooks} を拡張し、enqueue 時のフックを追加する。
 */
export interface BackendHooks extends WorkerHooks {
  /**
   * Called after a job is enqueued.
   *
   * ジョブが enqueue された時に呼ばれる。
   */
  onEnqueue?: (params: { jobName: string; payload: unknown; queue?: string }) => void;
}
