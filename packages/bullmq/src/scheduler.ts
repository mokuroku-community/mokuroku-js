import type { JobDefinition, JobScheduleOptions, JobScheduler, QueueDefinition } from "@mokurokujs/core";
import type { Queue } from "bullmq";
import type { BullMQQueueManager } from "./queue-manager.js";
import type { BullMQQueueDefinition } from "./types.js";

/**
 * Scheduler hooks for BullMQ repeatable jobs.
 *
 * BullMQ repeatable job に関するスケジューラフック。
 */
export interface BullmqSchedulerHooks {
  /**
   * Called after a schedule is upserted.
   *
   * スケジュールの登録/更新後に呼ばれる。
   */
  onUpsert?: (params: { jobName: string; pattern: string; immediately?: boolean }) => void;

  /**
   * Called after a schedule is removed.
   *
   * スケジュール削除後に呼ばれる。
   */
  onRemove?: (params: { jobName: string }) => void;
}

export interface BullmqSchedulerOptions {
  /**
   * Shared BullMQ queue manager (recommended to share with the backend).
   *
   * BullMQ のキューマネージャー（backend と共有推奨）。
   */
  queueManager: BullMQQueueManager;

  /**
   * List of known queues (reserved for future use).
   *
   * 登録済みキュー定義一覧（将来用。現状は未使用）。
   */
  queues?: BullMQQueueDefinition[];

  /**
   * Default queue used when `job.options.queue` is not set.
   *
   * `job.options.queue` 未指定時に使うデフォルトキュー。
   */
  defaultQueue?: BullMQQueueDefinition;

  /**
   * Scheduler lifecycle hooks.
   *
   * スケジューラのライフサイクルフック。
   */
  hooks?: BullmqSchedulerHooks;
}

/**
 * {@link JobScheduler} implementation based on BullMQ repeatable jobs.
 *
 * BullMQ の repeatable job を使った {@link JobScheduler} 実装。
 */
export class BullmqJobScheduler implements JobScheduler {
  private readonly queueManager: BullMQQueueManager;
  private readonly defaultQueue: BullMQQueueDefinition;
  private readonly hooks: BullmqSchedulerHooks;

  constructor(options: BullmqSchedulerOptions) {
    this.queueManager = options.queueManager;
    this.hooks = options.hooks ?? {};
    this.defaultQueue = options.defaultQueue ?? {
      name: "default",
      config: { bullmq: {} },
    };
  }

  async upsert<TPayload>(job: JobDefinition<TPayload>, options: JobScheduleOptions<TPayload>): Promise<void> {
    const queueDef = job.options.queue ?? this.defaultQueue;
    const queue = this.getOrCreateQueue(queueDef);

    await queue.upsertJobScheduler(
      job.name,
      {
        pattern: options.pattern,
        immediately: options.immediately ?? false,
      },
      {
        name: job.name,
        data: options.payload,
        opts: {
          removeOnComplete:
            options.removeOnCompleteAfterSec != null ? { age: options.removeOnCompleteAfterSec } : undefined,
          removeOnFail: options.removeOnFailAfterSec != null ? { age: options.removeOnFailAfterSec } : undefined,
        },
      },
    );

    this.hooks.onUpsert?.({
      jobName: job.name,
      pattern: options.pattern,
      immediately: options.immediately,
    });
  }

  async remove<TPayload>(job: JobDefinition<TPayload>): Promise<void> {
    const queueDef = job.options.queue ?? this.defaultQueue;
    const queue = this.getOrCreateQueue(queueDef);

    await queue.removeJobScheduler(job.name);

    this.hooks.onRemove?.({
      jobName: job.name,
    });
  }

  /**
   * Get or create the BullMQ queue instance for this schedule.
   *
   * スケジュール対象の BullMQ queue を取得/作成する。
   */
  private getOrCreateQueue(queueDef: QueueDefinition): Queue {
    return this.queueManager.getOrCreateQueue(queueDef);
  }
}

/**
 * Create a BullMQ-backed scheduler.
 *
 * BullMQ を使うスケジューラを作成する。
 */
export function createBullmqScheduler(options: BullmqSchedulerOptions): JobScheduler {
  return new BullmqJobScheduler(options);
}
