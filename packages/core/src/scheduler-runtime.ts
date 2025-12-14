import type { JobDefinition } from "./job.js";
import type { JobScheduleOptions, JobScheduler } from "./scheduler.js";

/**
 * Application-facing facade for job scheduling.
 *
 * アプリケーション向けスケジューラのファサード。
 *
 * Facade over {@link JobScheduler}.
 *
 * @see JobScheduler
 */
export class SchedulerRuntime {
  private readonly scheduler: JobScheduler;

  constructor(scheduler: JobScheduler) {
    this.scheduler = scheduler;
  }

  async upsert<TPayload>(job: JobDefinition<TPayload>, options: JobScheduleOptions<TPayload>): Promise<void> {
    await this.scheduler.upsert(job, options);
  }

  async remove<TPayload>(job: JobDefinition<TPayload>): Promise<void> {
    await this.scheduler.remove(job);
  }
}
