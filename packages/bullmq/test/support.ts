import { Queue } from "bullmq";
import { describe } from "vitest";

import { BullmqBackend } from "../src/backend.js";
import { BullMQQueueManager } from "../src/queue-manager.js";

import { randomUUID } from "node:crypto";

import type { BullmqQueueConfig } from "../src/types.js";

export const redisSuite = process.env.TEST_REDIS_DISABLED === "1" ? describe.skip : describe;
export function connection() {
  if (!process.env.TEST_REDIS_HOST) throw new Error("Redis is required for this suite");
  return {
    host: process.env.TEST_REDIS_HOST,
    port: Number(process.env.TEST_REDIS_PORT),
    password: process.env.TEST_REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  };
}
export function fixture(config: BullmqQueueConfig = {}) {
  const queue = { name: `lifecycle-${randomUUID()}`, config: { bullmq: config } };
  const events: unknown[] = [];
  const manager = new BullMQQueueManager(connection(), { onError: (event) => events.push(event) });
  const backend = new BullmqBackend({ queueManager: manager, defaultQueue: queue });
  const raw = new Queue<unknown, unknown, string>(queue.name, {
    connection: connection(),
    prefix: config.queueOptions?.prefix,
  });
  return {
    queue,
    manager,
    backend,
    raw,
    events,
    async close() {
      try {
        await backend.stop();
      } catch (error) {
        await raw.close().catch(() => {});
        throw error;
      }
      await raw.close();
    },
  };
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for observable state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}

// Independent public Redis escape hatch in 6; 5 exposes command client on QueueBase.
export async function redisClient(resource: object, blocking = false): Promise<import("bullmq").RedisClient> {
  const shape = resource as {
    getBackend?: () => {
      client: Promise<import("bullmq").RedisClient>;
      blockingClient?: Promise<import("bullmq").RedisClient>;
    };
    client?: Promise<import("bullmq").RedisClient>;
    blockingConnection?: { client: Promise<import("bullmq").RedisClient> };
  };
  const client = shape.getBackend
    ? blocking
      ? shape.getBackend().blockingClient
      : shape.getBackend().client
    : blocking
      ? shape.blockingConnection?.client
      : shape.client;
  if (!client) throw new Error("Redis client unavailable");
  return client;
}
