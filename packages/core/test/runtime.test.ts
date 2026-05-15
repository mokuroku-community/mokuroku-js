import { describe, expect, it } from "vitest";

import type { BulkEnqueueItem, EnqueueOptions, EnqueueResult, JobBackend, RegisterHandlerOptions } from "../src/backend.js";
import type { JobHandler } from "../src/handler.js";
import { defineJob, type JobDefinition } from "../src/job.js";
import { defineQueue, type QueueDefinition } from "../src/queue.js";
import { JobRuntime } from "../src/runtime.js";

class RecordingBackend implements JobBackend {
  readonly enqueueCalls: {
    job: JobDefinition<unknown>;
    payload: unknown;
    options?: EnqueueOptions;
  }[] = [];
  readonly enqueueBulkCalls: {
    job: JobDefinition<unknown>;
    items: BulkEnqueueItem<unknown>[];
  }[] = [];
  readonly handlerCalls: {
    job: JobDefinition<unknown>;
    handler: JobHandler<unknown>;
    options?: RegisterHandlerOptions;
  }[] = [];
  readonly lifecycleCalls: { method: string; args: unknown[] }[] = [];

  async enqueue<TPayload>(
    job: JobDefinition<TPayload>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult> {
    this.enqueueCalls.push({
      job: job as JobDefinition<unknown>,
      payload,
      options,
    });

    return {
      jobId: options?.jobId ?? "generated-id",
      name: options?.jobName ?? job.name,
    };
  }

  async enqueueBulk<TPayload>(
    job: JobDefinition<TPayload>,
    items: BulkEnqueueItem<TPayload>[],
  ): Promise<EnqueueResult[]> {
    this.enqueueBulkCalls.push({
      job: job as JobDefinition<unknown>,
      items: items as BulkEnqueueItem<unknown>[],
    });

    return items.map((item, index) => ({
      jobId: item.options?.jobId ?? `generated-id-${index}`,
      name: item.options?.jobName ?? job.name,
    }));
  }

  registerHandler<TPayload>(
    job: JobDefinition<TPayload>,
    handler: JobHandler<TPayload>,
    options?: RegisterHandlerOptions,
  ): void {
    this.handlerCalls.push({
      job: job as JobDefinition<unknown>,
      handler: handler as JobHandler<unknown>,
      options,
    });
  }

  async start(): Promise<void> {
    this.lifecycleCalls.push({ method: "start", args: [] });
  }

  async stop(options?: { timeout?: number }): Promise<void> {
    this.lifecycleCalls.push({ method: "stop", args: [options] });
  }

  async pauseAll(): Promise<void> {
    this.lifecycleCalls.push({ method: "pauseAll", args: [] });
  }

  async resumeAll(): Promise<void> {
    this.lifecycleCalls.push({ method: "resumeAll", args: [] });
  }

  async pauseQueue(queue: QueueDefinition): Promise<void> {
    this.lifecycleCalls.push({ method: "pauseQueue", args: [queue] });
  }

  async resumeQueue(queue: QueueDefinition): Promise<void> {
    this.lifecycleCalls.push({ method: "resumeQueue", args: [queue] });
  }
}

describe(JobRuntime.name, () => {
  it("delegates enqueue with job defaults, payload, and enqueue-time overrides", async () => {
    const backend = new RecordingBackend();
    const runtime = new JobRuntime(backend);
    const queue = defineQueue("emails").build();
    const job = defineJob<{ email: string }>("send-email", {
      queue,
      attempts: 3,
      backoff: { type: "fixed", delay: 1_000 },
      removeOnComplete: false,
      removeOnFail: true,
    });

    const result = await runtime.enqueue(job, { email: "user@example.com" }, {
      attempts: 5,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { count: 10 },
      removeOnFail: { age: 3_600 },
      delay: 30_000,
      jobId: "tenant-1:send-email",
      jobName: "send-email-now",
    });

    expect(result).toEqual({
      jobId: "tenant-1:send-email",
      name: "send-email-now",
    });
    expect(backend.enqueueCalls).toHaveLength(1);
    expect(backend.enqueueCalls[0]).toMatchObject({
      job,
      payload: { email: "user@example.com" },
      options: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { count: 10 },
        removeOnFail: { age: 3_600 },
        delay: 30_000,
        jobId: "tenant-1:send-email",
        jobName: "send-email-now",
      },
    });
    expect(backend.enqueueCalls[0]?.job.options.queue).toBe(queue);
  });

  it("delegates enqueueBulk with each item payload and options", async () => {
    const backend = new RecordingBackend();
    const runtime = new JobRuntime(backend);
    const job = defineJob<{ id: number }>("sync-user");
    const items = [
      { payload: { id: 1 }, options: { jobId: "user-1", delay: 100 } },
      { payload: { id: 2 }, options: { jobId: "user-2", jobName: "sync-user-high-priority" } },
    ];

    const results = await runtime.enqueueBulk(job, items);

    expect(results).toEqual([
      { jobId: "user-1", name: "sync-user" },
      { jobId: "user-2", name: "sync-user-high-priority" },
    ]);
    expect(backend.enqueueBulkCalls).toEqual([{ job, items }]);
  });

  it("delegates handler registration with queue-bound job definitions", () => {
    const backend = new RecordingBackend();
    const runtime = new JobRuntime(backend);
    const queue = defineQueue("reports").build();
    const job = defineJob<{ reportId: string }>("generate-report", { queue });
    const handler: JobHandler<{ reportId: string }> = async () => {};
    const hooks = { onCompleted: async () => {} };

    runtime.handle(job, handler, { concurrency: 2, hooks });

    expect(backend.handlerCalls).toHaveLength(1);
    expect(backend.handlerCalls[0]).toMatchObject({
      job,
      handler,
      options: { concurrency: 2, hooks },
    });
    expect(backend.handlerCalls[0]?.job.options.queue).toBe(queue);
  });

  it("delegates worker lifecycle controls", async () => {
    const backend = new RecordingBackend();
    const runtime = new JobRuntime(backend);
    const queue = defineQueue("maintenance").build();

    await runtime.start();
    await runtime.pauseAll();
    await runtime.resumeAll();
    await runtime.pauseQueue(queue);
    await runtime.resumeQueue(queue);
    await runtime.stop({ timeout: 5_000 });

    expect(backend.lifecycleCalls).toEqual([
      { method: "start", args: [] },
      { method: "pauseAll", args: [] },
      { method: "resumeAll", args: [] },
      { method: "pauseQueue", args: [queue] },
      { method: "resumeQueue", args: [queue] },
      { method: "stop", args: [{ timeout: 5_000 }] },
    ]);
  });
});
