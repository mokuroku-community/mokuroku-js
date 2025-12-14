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

async function wait(ms: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
