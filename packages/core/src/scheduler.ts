import type { JobDefinition } from "./job.js";

/**
 * Cron-based schedule options.
 *
 * cron ベースのスケジュール指定。
 */
export interface JobScheduleOptions<TPayload = unknown> {
  /**
   * Cron pattern string.
   *
   * cron パターン文字列。
   */
  pattern: string;

  /**
   * If true, enqueue the first run immediately after scheduling.
   *
   * true の場合、登録直後に1回目を即時実行（enqueue）する。
   */
  immediately?: boolean;

  /**
   * Fixed payload to enqueue for each scheduled run.
   *
   * スケジュール実行時に毎回渡す固定 payload。
   */
  payload?: TPayload;

  /**
   * Retain completed scheduled jobs for this many seconds.
   * Adapter-dependent (e.g. BullMQ uses `{ age }`).
   *
   * 完了したスケジュールジョブを保持する秒数。
   * アダプタ依存（例: BullMQ は `{ age }` を使用）。
   */
  removeOnCompleteAfterSec?: number;

  /**
   * Retain failed scheduled jobs for this many seconds.
   *
   * 失敗したスケジュールジョブを保持する秒数。
   */
  removeOnFailAfterSec?: number;
}

/**
 * Scheduler interface for cron/repeatable jobs.
 *
 * cron / repeatable job を扱う抽象インターフェース。
 */
export interface JobScheduler {
  upsert<TPayload>(job: JobDefinition<TPayload>, options: JobScheduleOptions<TPayload>): Promise<void>;

  remove<TPayload>(job: JobDefinition<TPayload>): Promise<void>;
}
