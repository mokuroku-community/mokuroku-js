import { defineJob, InvalidStateError } from "@mokurokujs/core";
import { describe, expect, it, vi } from "vitest";

import { BullmqBackend, type BullmqBackendOptions } from "../src/backend.js";
import { defineQueueForBullMQ } from "../src/helper.js";
import { BullMQQueueManager } from "../src/queue-manager.js";

import { randomUUID } from "node:crypto";

import type { BullmqQueueConfig } from "../src/types.js";

const describeIfRuntimeAvailable = process.env.TEST_REDIS_DISABLED === "1" ? describe.skip : describe;

function getRedisConnection() {
  const host = process.env.TEST_REDIS_HOST;
  const port = Number(process.env.TEST_REDIS_PORT);
  const password = process.env.TEST_REDIS_PASSWORD;

  if (!host || Number.isNaN(port)) {
    throw new Error("Redis connection info is not available. Check global setup.");
  }

  return {
    host,
    port,
    ...(password ? { password } : {}),
  };
}

function createQueueDefinition(overrides?: Partial<BullmqQueueConfig>) {
  const name = `test-queue-${randomUUID()}`;
  const builder = defineQueueForBullMQ(name, {
    queueOptions: {
      connection: getRedisConnection(),
      defaultJobOptions: {
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 1,
      },
    },
    ...overrides,
  });
  return builder.build();
}

function createBackend(options?: { hooks?: BullmqBackendOptions["hooks"] }) {
  const queueManager = new BullMQQueueManager(getRedisConnection());
  return new BullmqBackend({
    queueManager,
    hooks: options?.hooks,
  });
}

function createBackendWithQueueManager(options?: { hooks?: BullmqBackendOptions["hooks"] }) {
  const queueManager = new BullMQQueueManager(getRedisConnection());
  return {
    backend: new BullmqBackend({
      queueManager,
      hooks: options?.hooks,
    }),
    queueManager,
  };
}

async function wait(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await wait(50);
  }
  throw new Error("Timed out waiting for condition");
}

describeIfRuntimeAvailable(BullmqBackend.name, () => {
  describe("#start", () => {
    it("processes registered jobs and triggers backend/queue/job hooks", async () => {
      const backendHooks = {
        onEnqueue: vi.fn(),
        onStart: vi.fn(),
        onSuccess: vi.fn(),
      };
      const queueHooks = {
        onStart: vi.fn(),
        onSuccess: vi.fn(),
      };
      const jobHooks = {
        onStart: vi.fn(),
        onSuccess: vi.fn(),
      };
      const backend = createBackend({ hooks: backendHooks });
      const queueDef = createQueueDefinition({ hooks: queueHooks });
      const job = defineJob<{ email: string }>(`welcome-${randomUUID()}`, {
        queue: queueDef,
        removeOnComplete: true,
      });

      let resolveProcessed: (() => void) | undefined;
      const processed = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });

      backend.registerHandler(
        job,
        async (payload) => {
          expect(payload.email).toMatch(/^user-/);
          resolveProcessed?.();
        },
        { hooks: jobHooks },
      );

      await backend.start();
      try {
        await backend.enqueue(job, { email: `user-${randomUUID()}@example.com` });
        await processed;
      } finally {
        await backend.stop();
      }

      expect(backendHooks.onEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobName: job.name,
          queue: queueDef.name,
        }),
      );
      expect(backendHooks.onStart).toHaveBeenCalledTimes(1);
      expect(queueHooks.onStart).toHaveBeenCalledTimes(1);
      expect(jobHooks.onStart).toHaveBeenCalledTimes(1);
      expect(backendHooks.onSuccess).toHaveBeenCalledTimes(1);
      expect(queueHooks.onSuccess).toHaveBeenCalledTimes(1);
      expect(jobHooks.onSuccess).toHaveBeenCalledTimes(1);
    });

    it("deduplicates jobs enqueued with the same jobId", async () => {
      const backend = createBackend();
      const queueDef = createQueueDefinition();
      const job = defineJob<{ id: string }>(`dedupe-${randomUUID()}`, {
        queue: queueDef,
      });
      const jobId = `dedupe:${randomUUID()}`;

      let resolveProcessed: (() => void) | undefined;
      let runCount = 0;
      const processed = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });

      backend.registerHandler(job, async () => {
        runCount += 1;
        resolveProcessed?.();
      });

      const first = await backend.enqueue(job, { id: "first" }, { jobId });
      const second = await backend.enqueue(job, { id: "second" }, { jobId });

      await backend.start();
      try {
        await processed;
        await wait(300);
      } finally {
        await backend.stop();
      }

      expect(first.jobId).toBe(jobId);
      expect(second.jobId).toBe(jobId);
      expect(runCount).toBe(1);
    });

    it("accepts the same jobId again after a completed job is removed", async () => {
      const { backend, queueManager } = createBackendWithQueueManager();
      const queueDef = createQueueDefinition();
      const job = defineJob<{ id: string }>(`dedupe-removed-${randomUUID()}`, {
        queue: queueDef,
        removeOnComplete: true,
      });
      const jobId = `dedupe-removed:${randomUUID()}`;

      let runCount = 0;
      let resolveFirstProcessed: (() => void) | undefined;
      let resolveSecondProcessed: (() => void) | undefined;
      const firstProcessed = new Promise<void>((resolve) => {
        resolveFirstProcessed = resolve;
      });
      const secondProcessed = new Promise<void>((resolve) => {
        resolveSecondProcessed = resolve;
      });

      backend.registerHandler(job, async () => {
        runCount += 1;
        if (runCount === 1) {
          resolveFirstProcessed?.();
          return;
        }
        resolveSecondProcessed?.();
      });

      await backend.start();
      try {
        const first = await backend.enqueue(job, { id: "first" }, { jobId, removeOnComplete: true });
        await firstProcessed;
        const queue = queueManager.getOrCreateQueue(queueDef);
        await waitUntil(async () => {
          const stored = await queue.getJob(jobId);
          return stored === undefined || stored === null;
        });

        const second = await backend.enqueue(job, { id: "second" }, { jobId, removeOnComplete: true });
        await secondProcessed;

        expect(first.jobId).toBe(jobId);
        expect(second.jobId).toBe(jobId);
      } finally {
        await backend.stop();
      }

      expect(runCount).toBe(2);
    });

    it("keeps the existing delayed job when enqueueing the same jobId again", async () => {
      const { backend, queueManager } = createBackendWithQueueManager();
      const queueDef = createQueueDefinition();
      const job = defineJob<{ id: string }>(`dedupe-delayed-${randomUUID()}`, {
        queue: queueDef,
      });
      const jobId = `dedupe-delayed:${randomUUID()}`;

      const first = await backend.enqueue(job, { id: "first" }, { jobId, delay: 60_000 });
      const second = await backend.enqueue(job, { id: "second" }, { jobId, delay: 120_000 });

      try {
        const queue = queueManager.getOrCreateQueue(queueDef);
        const stored = await queue.getJob(jobId);

        expect(first.jobId).toBe(jobId);
        expect(second.jobId).toBe(jobId);
        expect(stored?.data).toEqual({ id: "first" });
        expect(stored?.opts.delay).toBe(60_000);
      } finally {
        await queueManager.closeAll();
      }
    });

    it("deduplicates bulk enqueue items with the same jobId", async () => {
      const backend = createBackend();
      const queueDef = createQueueDefinition();
      const job = defineJob<{ id: string }>(`dedupe-bulk-${randomUUID()}`, {
        queue: queueDef,
      });
      const jobId = `dedupe-bulk:${randomUUID()}`;

      let resolveProcessed: (() => void) | undefined;
      let runCount = 0;
      const processed = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });

      backend.registerHandler(job, async () => {
        runCount += 1;
        resolveProcessed?.();
      });

      const results = await backend.enqueueBulk(job, [
        { payload: { id: "first" }, options: { jobId } },
        { payload: { id: "second" }, options: { jobId } },
      ]);

      await backend.start();
      try {
        await processed;
        await wait(300);
      } finally {
        await backend.stop();
      }

      expect(results).toHaveLength(2);
      expect(results[0]?.jobId).toBe(jobId);
      expect(results[1]?.jobId).toBe(jobId);
      expect(runCount).toBe(1);
    });
  });

  describe("#pauseQueue", () => {
    it("rejects when backend is idle and resumes work after being restarted", async () => {
      const backend = createBackend();
      const queueDef = createQueueDefinition();
      const job = defineJob<{ id: string }>(`pause-${randomUUID()}`, {
        queue: queueDef,
      });

      await expect(backend.pauseQueue(queueDef)).rejects.toBeInstanceOf(InvalidStateError);

      let resolveProcessed: (() => void) | undefined;
      let runCount = 0;
      const processed = new Promise<void>((resolve) => {
        resolveProcessed = resolve;
      });

      backend.registerHandler(job, async () => {
        runCount += 1;
        resolveProcessed?.();
      });

      await backend.start();
      try {
        await backend.pauseQueue(queueDef);

        await backend.enqueue(job, { id: randomUUID() });
        await wait(300);
        expect(runCount).toBe(0);

        await backend.resumeQueue(queueDef);
        await processed;
      } finally {
        await backend.stop();
      }

      expect(runCount).toBe(1);
    });
  });
});
