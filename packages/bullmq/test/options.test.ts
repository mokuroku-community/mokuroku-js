import { defineJob } from "@mokurokujs/core";
import { UnrecoverableError } from "bullmq";
import { expect, it } from "vitest";

import { fixture, gate, redisSuite, until } from "./support.js";

redisSuite("options and actual retry transitions", () => {
  it("inherits Queue defaults, applies job defaults and preserves explicit false/zero in single and bulk", async () => {
    const f = fixture({
      queueOptions: {
        connection: {},
        defaultJobOptions: { attempts: 7, delay: 200, removeOnComplete: true, removeOnFail: 9, priority: 3 },
      },
    });
    const inherited = defineJob("inherited"),
      overrides = defineJob("override", { attempts: 4, removeOnFail: false });
    try {
      const a = await f.backend.enqueue(inherited, { a: 1 });
      const [b] = await f.backend.enqueueBulk(overrides, [
        { payload: { b: 2 }, options: { attempts: 0, delay: 0, removeOnComplete: false, jobId: "explicit-id" } },
      ]);
      expect((await f.raw.getJob(a.jobId))?.opts).toMatchObject({
        attempts: 7,
        delay: 200,
        removeOnComplete: true,
        removeOnFail: 9,
        priority: 3,
      });
      expect((await f.raw.getJob(b.jobId))?.opts).toMatchObject({
        attempts: 0,
        delay: 0,
        removeOnComplete: false,
        removeOnFail: false,
        priority: 3,
      });
    } finally {
      await f.close();
    }
  });
  it.each([
    40, 0, -1,
  ])("passes original errors and backoff arguments, stores actual retry classification for backoff %s", async (delay) => {
    const calls: unknown[][] = [],
      starts: number[] = [],
      success: number[] = [],
      retries: number[] = [],
      failures: number[] = [],
      times: number[] = [];
    const failure = new Error("retry-me");
    const f = fixture({
      workerOptions: {
        settings: {
          backoffStrategy: (...args) => {
            calls.push(args);
            return delay;
          },
        },
      },
      hooks: {
        onStart: (ctx) => starts.push(ctx.attempt),
        onSuccess: (ctx) => success.push(ctx.attempt),
        onRetry: (ctx, error) => {
          expect(error).toBe(failure);
          retries.push(ctx.attempt);
        },
        onFailure: (ctx, error) => {
          expect(error).toBe(failure);
          failures.push(ctx.attempt);
        },
      },
    });
    const job = defineJob("retry", { attempts: 2, backoff: { type: "custom" } });
    f.backend.registerHandler(job, async () => {
      times.push(Date.now());
      if (times.length === 1) throw failure;
    });
    try {
      await f.backend.enqueue(job, {});
      await f.backend.start();
      await until(async () => (await f.raw.getCompletedCount()) + (await f.raw.getFailedCount()) === 1);
      expect(calls).toHaveLength(1);
      expect(calls[0].slice(0, 3)).toEqual([1, "custom", failure]);
      expect(calls[0][3]).toMatchObject({ name: "retry" });
      expect(starts).toEqual(delay === -1 ? [1] : [1, 2]);
      expect(retries).toEqual(delay === -1 ? [] : [1]);
      expect(failures).toEqual(delay === -1 ? [1] : []);
      expect(success).toEqual(delay === -1 ? [] : [2]);
      if (delay > 0) expect(times[1] - times[0]).toBeGreaterThanOrEqual(delay);
    } finally {
      await f.close();
    }
  });
  it("classifies UnrecoverableError as terminal despite remaining attempts", async () => {
    const failed: number[] = [],
      retried: number[] = [];
    const failure = new UnrecoverableError("terminal");
    const f = fixture({
      hooks: {
        onRetry: (ctx) => retried.push(ctx.attempt),
        onFailure: (ctx, error) => {
          expect(error).toBe(failure);
          failed.push(ctx.attempt);
        },
      },
    });
    const job = defineJob("terminal", { attempts: 5 });
    f.backend.registerHandler(job, async () => {
      throw failure;
    });
    try {
      await f.backend.enqueue(job, {});
      await f.backend.start();
      await until(async () => (await f.raw.getFailedCount()) === 1);
      expect(failed).toEqual([1]);
      expect(retried).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("retains normal retries and correct first-attempt success hooks", async () => {
    const attempts: number[] = [],
      retries: number[] = [],
      successes: number[] = [];
    const f = fixture({
      hooks: { onRetry: (ctx) => retries.push(ctx.attempt), onSuccess: (ctx) => successes.push(ctx.attempt) },
    });
    const job = defineJob("normal", { attempts: 3, backoff: { type: "fixed", delay: 10 } });
    f.backend.registerHandler(job, async (_, ctx) => {
      attempts.push(ctx.attempt);
      if (ctx.attempt < 3) throw new Error("retry");
    });
    try {
      await f.backend.enqueue(job, {});
      await f.backend.start();
      await until(async () => (await f.raw.getCompletedCount()) === 1);
      expect(attempts).toEqual([1, 2, 3]);
      expect(retries).toEqual([1, 2]);
      expect(successes).toEqual([3]);
    } finally {
      await f.close();
    }
  });
  it("honors prefix, concurrency, limiter and metrics options with real jobs", async () => {
    const f = fixture({
      queueOptions: { connection: {}, prefix: "custom-prefix" },
      workerOptions: {
        concurrency: 2,
        limiter: { max: 2, duration: 150 },
        metrics: { maxDataPoints: 10 },
        autorun: true,
      },
    });
    const release = gate();
    let active = 0,
      maximum = 0;
    const times: number[] = [];
    const job = defineJob("configured");
    f.backend.registerHandler(job, async () => {
      active++;
      maximum = Math.max(maximum, active);
      times.push(Date.now());
      await release.promise;
      active--;
    });
    try {
      await f.backend.enqueueBulk(
        job,
        [1, 2, 3].map((value) => ({ payload: value })),
      );
      await f.backend.start();
      await until(() => times.length === 2);
      expect(maximum).toBe(2);
      release.resolve();
      await until(async () => (await f.raw.getCompletedCount()) === 3);
      expect(times[2] - times[0]).toBeGreaterThanOrEqual(140);
      expect((await f.raw.getMetrics("completed")).meta.count).toBe(3);
    } finally {
      release.resolve();
      await f.close();
    }
  });
});

redisSuite("delay and retention side effects", () => {
  it("honors enqueue delay and removes completed and failed jobs when explicitly requested", async () => {
    const f = fixture();
    const processed: { name: string; time: number }[] = [];
    const success = defineJob("delayed", { removeOnComplete: true }),
      failure = defineJob("failed", { removeOnFail: true });
    f.backend.registerHandler(success, async (_, ctx) => {
      processed.push({ name: ctx.jobName, time: Date.now() });
    });
    f.backend.registerHandler(failure, async (_, ctx) => {
      processed.push({ name: ctx.jobName, time: Date.now() });
      throw new Error("remove-me");
    });
    try {
      const before = Date.now();
      const item = await f.backend.enqueue(success, {}, { delay: 100, jobId: "delayed-job" });
      const failed = await f.backend.enqueue(failure, {});
      await f.backend.start();
      await until(() => processed.length === 2);
      const delayed = processed.find((record) => record.name === "delayed");
      if (!delayed) throw new Error("Delayed job was not processed");
      expect(delayed.time - before).toBeGreaterThanOrEqual(100);
      await until(async () => !(await f.raw.getJob(item.jobId)) && !(await f.raw.getJob(failed.jobId)));
    } finally {
      await f.close();
    }
  });
});
