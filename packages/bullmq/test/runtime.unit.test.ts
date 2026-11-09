import { defineJob } from "@mokurokujs/core";
import { afterEach, expect, it, vi } from "vitest";

import { BullmqBackend } from "../src/backend.js";
import { BullMQQueueManager } from "../src/queue-manager.js";

import { createRequire } from "node:module";

import type { RedisClient } from "bullmq";

// Resolve ioredis from the BullMQ under validation; no peer dependency override.
const require = createRequire(import.meta.url);
const bullmqFile = process.env.BULLMQ_RUNTIME_FILE ?? require.resolve("bullmq");
const redisRequire = createRequire(bullmqFile);
const Redis = redisRequire("ioredis");
afterEach(() => vi.restoreAllMocks());
function endedClient(): RedisClient {
  const client = new Redis({ lazyConnect: true, maxRetriesPerRequest: null });
  client.disconnect();
  return client;
}

it("real BullMQ rejects an ended borrowed command client and producer cleanup preserves ownership", async () => {
  const client = endedClient(),
    disconnect = vi.spyOn(client, "disconnect"),
    quit = vi.spyOn(client, "quit");
  const errors: unknown[] = [];
  const manager = new BullMQQueueManager(client, { onError: (error) => errors.push(error) });
  const backend = new BullmqBackend({ queueManager: manager });
  try {
    await expect(backend.ready(undefined, { timeout: 100 })).rejects.toThrow();
    expect(errors).toContainEqual(expect.objectContaining({ reason: "connection-ended", connection: "command" }));
    await backend.stop();
    expect(disconnect).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
    expect(client.listenerCount("end")).toBe(0);
  } finally {
    await backend.stop();
  }
});
it("real BullMQ startup never runs after an ended borrowed command connection", async () => {
  const client = endedClient();
  const manager = new BullMQQueueManager(client),
    backend = new BullmqBackend({ queueManager: manager });
  backend.registerHandler(defineJob("job"), async () => {
    throw new Error("must not consume");
  });
  await expect(backend.start({ timeout: 100 })).rejects.toThrow();
  await backend.stop();
  expect(client.status).toBe("end");
  expect(client.listenerCount("end")).toBe(0);
});
it("constructs and closes a real managed Worker with both actual connection handles", async () => {
  const client = endedClient(),
    duplicate = endedClient();
  // Controlled connection fault: keep the Worker and Redis clients real, avoid any network dependency.
  vi.spyOn(client, "duplicate").mockReturnValue(duplicate);
  const events: unknown[] = [];
  const manager = new BullMQQueueManager(client, { onError: (event) => events.push(event) });
  const worker = await manager.createWorker(
    { name: "ended-worker", config: { bullmq: { workerOptions: { autorun: true } } } },
    async () => {},
  );
  expect(worker.isRunning()).toBe(false);
  await expect(manager.ready()).rejects.toThrow();
  await manager.closeAll();
  expect(events).toContainEqual(
    expect.objectContaining({ reason: "connection-ended", connection: "command", resource: "worker" }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ reason: "connection-ended", connection: "blocking", resource: "worker" }),
  );
  expect(duplicate.listenerCount("end")).toBe(0);
});
it("keeps the Redis client in a connection definition borrowed rather than cloning it", async () => {
  const client = endedClient();
  const manager = new BullMQQueueManager({ name: "connection-definition", config: { bullmq: { connection: client } } });
  expect(manager.getConnection()).toBe(client);
  await manager.closeAll();
});

it.each([
  { concurrency: 0 },
  { stalledInterval: 0 },
  { drainDelay: 0 },
])("rejects constructor validation %j without leaking real borrowed-client listeners", async (workerOptions) => {
  const client = endedClient();
  const before = ["error", "close", "ready", "end"].map((event) => client.listenerCount(event));
  const disconnect = vi.spyOn(client, "disconnect");
  const manager = new BullMQQueueManager(client);
  try {
    await expect(
      manager.createWorker({ name: "invalid-worker", config: { bullmq: { workerOptions } } }, async () => {}),
    ).rejects.toThrow();
    await manager.closeAll();
    expect(["error", "close", "ready", "end"].map((event) => client.listenerCount(event))).toEqual(before);
    expect(disconnect).not.toHaveBeenCalled();
  } finally {
    await manager.closeAll();
  }
});
