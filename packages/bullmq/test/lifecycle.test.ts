import { defineJob, InvalidStateError } from "@mokurokujs/core";
import { type RedisClient, Worker } from "bullmq";
import { expect, it, vi } from "vitest";

import { BullmqBackend } from "../src/backend.js";
import { BullMQQueueManager } from "../src/queue-manager.js";
import { connection, fixture, gate, redisClient, redisSuite, until } from "./support.js";

import { createRequire } from "node:module";
import { createServer } from "node:net";

const require = createRequire(import.meta.url);
const Redis = createRequire(require.resolve("bullmq"))("ioredis");
async function freshBorrowedClient(): Promise<RedisClient> {
  const client: RedisClient = new Redis(connection());
  await client.ping();
  return client;
}

redisSuite("real Redis lifecycle", () => {
  it("ready creates producers only and producer-only stop releases owned clients", async () => {
    const f = fixture();
    try {
      await f.backend.ready();
      const q = f.manager.getOrCreateQueue(f.queue),
        client = await redisClient(q);
      expect(client.status).toBe("ready");
      expect(await f.raw.getWorkers()).toHaveLength(0);
      await f.backend.stop();
      expect(client.status).toBe("end");
      await f.backend.ready();
      expect(await redisClient(f.manager.getOrCreateQueue(f.queue))).not.toBe(client);
    } finally {
      await f.close();
    }
  });
  it.each(["queue", "command", "blocking"])("notifies an individually killed %s connection", async (kind) => {
    const f = fixture();
    let worker: Worker<unknown, unknown, string> | undefined;
    const create = f.manager.createWorker.bind(f.manager);
    vi.spyOn(f.manager, "createWorker").mockImplementation(async (...args) => {
      worker = await create(...args);
      return worker;
    });
    f.backend.registerHandler(defineJob("job"), async () => {});
    try {
      await f.backend.start();
      if (!worker) throw new Error("Worker was not created");
      const client =
        kind === "queue"
          ? await redisClient(f.manager.getOrCreateQueue(f.queue))
          : kind === "command"
            ? await redisClient(worker)
            : await redisClient(worker, true);
      // No automatic reconnect for this individual client, leaving other connections intact.
      if (!("retryStrategy" in client.options)) throw new Error("Expected a standalone Redis client");
      client.options.retryStrategy = () => null;
      const id = await client.call("CLIENT", "ID");
      const killer = await redisClient(f.raw);
      await killer.call("CLIENT", "KILL", "ID", String(id));
      await until(() =>
        f.events.some((event) => {
          const e = event as { reason: string; resource: string; connection?: string };
          return (
            e.reason === "connection-ended" &&
            e.resource === (kind === "queue" ? "queue" : "worker") &&
            e.connection === (kind === "blocking" ? "blocking" : "command")
          );
        }),
      );
    } finally {
      await f.close();
      vi.restoreAllMocks();
    }
  });
  it("drains a handler gate before closing any Queue and rejects new work during stop", async () => {
    const f = fixture(),
      entered = gate(),
      release = gate();
    const job = defineJob("gated");
    f.backend.registerHandler(job, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await f.backend.enqueue(job, {});
      await f.backend.start();
      await entered.promise;
      const q = f.manager.getOrCreateQueue(f.queue);
      let done = false;
      const stop = f.backend.stop().then(() => {
        done = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(done).toBe(false);
      expect((q as unknown as { closed: boolean }).closed).toBe(false);
      await expect(f.backend.enqueue(job, {})).rejects.toBeInstanceOf(InvalidStateError);
      await expect(f.backend.start()).rejects.toBeInstanceOf(InvalidStateError);
      release.resolve();
      await stop;
      expect((q as unknown as { closed: boolean }).closed).toBe(true);
    } finally {
      release.resolve();
      await f.close();
    }
  });
  it("keeps a borrowed client alive and restores listener counts", async () => {
    const f = fixture();
    const borrowed = await redisClient(f.raw);
    const before = [borrowed.listenerCount("end"), borrowed.listenerCount("close"), borrowed.listenerCount("error")];
    const manager = new BullMQQueueManager(borrowed);
    const backend = new BullmqBackend({ queueManager: manager, defaultQueue: f.queue });
    backend.registerHandler(defineJob("job"), async () => {});
    try {
      await backend.ready();
      await backend.start();
      await backend.stop();
      expect(await borrowed.ping()).toBe("PONG");
      expect([borrowed.listenerCount("end"), borrowed.listenerCount("close"), borrowed.listenerCount("error")]).toEqual(
        before,
      );
    } finally {
      await backend.stop();
      await f.close();
    }
  });
  it.each(["resolve", "reject"])("reports a controlled real Worker run %s", async (kind) => {
    const f = fixture();
    const failure = new Error("controlled run failure");
    const run = vi
      .spyOn(Worker.prototype, "run")
      .mockImplementation(() => (kind === "resolve" ? Promise.resolve() : Promise.reject(failure)));
    f.backend.registerHandler(defineJob("job"), async () => {});
    try {
      await expect(f.backend.start()).rejects.toThrow();
      expect(f.events).toContainEqual(
        expect.objectContaining({ reason: kind === "resolve" ? "run-fulfilled" : "run-rejected" }),
      );
    } finally {
      run.mockRestore();
      await f.close();
    }
  });
  it("continues all real resource cleanup after close failures including emitted errors", async () => {
    const f = fixture();
    const other = { name: `${f.queue.name}-other` };
    await f.backend.ready([f.queue, other]);
    const a = f.manager.getOrCreateQueue(f.queue),
      b = f.manager.getOrCreateQueue(other);
    const closeA = a.close.bind(a),
      closeB = b.close.bind(b),
      failure = new Error("emitted cleanup");
    vi.spyOn(a, "close").mockImplementation(async () => {
      await closeA();
      a.emit("error", failure);
    });
    const slow = gate();
    vi.spyOn(b, "close").mockImplementation(async () => {
      await slow.promise;
      await closeB();
      throw new Error("rejected cleanup");
    });
    let settled = false;
    const stop = f.backend
      .stop()
      .catch((error) => error)
      .then((error) => {
        settled = true;
        return error;
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    slow.resolve();
    const error = await stop;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(2);
    expect((a as unknown as { closed: boolean }).closed && (b as unknown as { closed: boolean }).closed).toBe(true);
    await f.raw.close();
    vi.restoreAllMocks();
  });
  it("bounds an unresponsive TCP Redis handshake and cleans late connections", async () => {
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing TCP address");
    const manager = new BullMQQueueManager({ host: "127.0.0.1", port: address.port, retryStrategy: () => null });
    const backend = new BullmqBackend({ queueManager: manager });
    try {
      await expect(backend.ready(undefined, { timeout: 30 })).rejects.toThrow();
      await backend.stop({ timeout: 1000 });
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("bounds connection refusal with no skipped successful startup", async () => {
    const manager = new BullMQQueueManager({
      host: "127.0.0.1",
      port: 1,
      retryStrategy: () => null,
      connectTimeout: 20,
    });
    const backend = new BullmqBackend({ queueManager: manager });
    try {
      await expect(backend.ready(undefined, { timeout: 100 })).rejects.toThrow();
    } finally {
      await backend.stop({ timeout: 1000 });
    }
  });
  it("monitors resumed real runs after a local pause without reporting normal pauses or close", async () => {
    const f = fixture();
    f.backend.registerHandler(defineJob("job"), async () => {});
    try {
      await f.backend.start();
      await f.backend.pauseAll();
      await f.backend.resumeAll();
      const item = await f.backend.enqueue(defineJob("job"), {});
      await until(async () => (await f.raw.getJob(item.jobId))?.finishedOn !== undefined);
      await f.backend.stop();
      expect(f.events).toEqual([]);
    } finally {
      await f.close();
    }
  });
});

redisSuite("real Redis recovery and resumed loop faults", () => {
  it.each([2, 3])("recovers real resources when Worker %s constructor rejects concurrency zero", async (position) => {
    const f = fixture();
    const borrowed = await freshBorrowedClient();
    const events = ["error", "close", "ready", "end"];
    const before = events.map((event) => borrowed.listenerCount(event));
    const disconnect = vi.spyOn(borrowed, "disconnect");
    const quit = vi.spyOn(borrowed, "quit");
    const manager = new BullMQQueueManager(borrowed);
    const backend = new BullmqBackend({ queueManager: manager });
    const created: Worker<unknown, unknown, string>[] = [];
    const original = manager.createWorker.bind(manager);
    vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
      const worker = await original(...args);
      created.push(worker);
      return worker;
    });
    for (let i = 0; i < position; i++) {
      const queue = {
        name: `${f.queue.name}-${i}`,
        config: { bullmq: { workerOptions: { concurrency: i === position - 1 ? 0 : 1 } } },
      };
      backend.registerHandler(defineJob(`job${i}`, { queue }), async () => {});
    }
    try {
      await expect(backend.start()).rejects.toThrow("concurrency");
      expect(created).toHaveLength(position - 1);
      for (const worker of created) {
        expect(worker.isRunning()).toBe(false);
        expect((await redisClient(worker, true)).status).toBe("end");
      }
      expect(events.map((event) => borrowed.listenerCount(event))).toEqual(before);
      expect(disconnect).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(await borrowed.ping()).toBe("PONG");
    } finally {
      await backend.stop();
      vi.restoreAllMocks();
      await borrowed.quit();
      await f.close();
    }
  });
  it("keeps command monitoring enabled while paused", async () => {
    const f = fixture();
    let worker: Worker<unknown, unknown, string> | undefined;
    const original = f.manager.createWorker.bind(f.manager);
    vi.spyOn(f.manager, "createWorker").mockImplementation(async (...args) => {
      worker = await original(...args);
      return worker;
    });
    f.backend.registerHandler(defineJob("job"), async () => {});
    try {
      await f.backend.start();
      await f.backend.pauseAll();
      if (!worker) throw new Error("Worker was not created");
      const client = await redisClient(worker);
      if (!("retryStrategy" in client.options)) throw new Error("Expected a standalone Redis client");
      client.options.retryStrategy = () => null;
      const id = await client.call("CLIENT", "ID");
      await (await redisClient(f.raw)).call("CLIENT", "KILL", "ID", String(id));
      await until(() =>
        f.events.some((event) => {
          const value = event as { reason: string; connection?: string };
          return value.reason === "connection-ended" && value.connection === "command";
        }),
      );
      await expect(f.backend.resumeAll()).rejects.toThrow();
    } finally {
      vi.restoreAllMocks();
      await f.close();
    }
  });
  it.each([
    "resolve",
    "reject",
  ])("observes the native resumed loop's controlled %s without a manual run", async (kind) => {
    const f = fixture();
    let worker: Worker<unknown, unknown, string> | undefined;
    const original = f.manager.createWorker.bind(f.manager);
    vi.spyOn(f.manager, "createWorker").mockImplementation(async (...args) => {
      worker = await original(...args);
      return worker;
    });
    // Run the actual loop; only its returned promise can be ended by this fault.
    // 実ループを動かし、監視対象の戻り値だけに終了を注入する。
    const nativeRun = Worker.prototype.run;
    const runs: { finish: () => void; fail: (error: Error) => void; settled: boolean }[] = [];
    const run = vi.spyOn(Worker.prototype, "run").mockImplementation(function (this: Worker<unknown, unknown, string>) {
      let finish!: () => void;
      let fail!: (error: Error) => void;
      const fault = new Promise<void>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      });
      const record = { finish, fail, settled: false };
      runs.push(record);
      return Promise.race([nativeRun.call(this), fault]).finally(() => {
        record.settled = true;
      });
    });
    f.backend.registerHandler(defineJob("job"), async () => {});
    try {
      await f.backend.start();
      if (!worker) throw new Error("Worker was not created");
      const initial = await f.backend.enqueue(defineJob("job"), {});
      await until(async () => (await f.raw.getJob(initial.jobId))?.finishedOn !== undefined);
      await f.backend.pauseAll();
      expect(runs).toHaveLength(1);
      // 5.16 keeps its original run; newer 5 and 6 have a mainLoop that exits on pause.
      const activeWorker = worker;
      const restarts = "mainLoopRunning" in activeWorker;
      if (restarts) await until(() => !activeWorker.isRunning());
      const originalRun = runs[0];
      expect(originalRun.settled).toBe(restarts);
      expect(f.events).toEqual([]);
      await f.backend.resumeAll();
      await until(() => run.mock.calls.length === (restarts ? 2 : 1));
      expect(worker.isRunning()).toBe(true);
      const resumed = await f.backend.enqueue(defineJob("job"), {});
      await until(async () => (await f.raw.getJob(resumed.jobId))?.finishedOn !== undefined);
      const activeRun = runs.at(-1);
      if (!activeRun) throw new Error("Missing native resumed run");
      expect(activeRun === originalRun).toBe(!restarts);
      const failure = new Error("resumed run failure");
      if (kind === "resolve") activeRun.finish();
      else activeRun.fail(failure);
      await until(() =>
        f.events.some(
          (event) => (event as { reason: string }).reason === (kind === "resolve" ? "run-fulfilled" : "run-rejected"),
        ),
      );
      await f.backend.stop();
      expect(f.events).toEqual([
        expect.objectContaining({
          reason: kind === "resolve" ? "run-fulfilled" : "run-rejected",
          ...(kind === "reject" ? { error: failure } : {}),
        }),
      ]);
    } finally {
      // Preserve the observer through real shutdown; normal close must stay silent.
      await f.close();
      run.mockRestore();
      vi.restoreAllMocks();
    }
  });
  it("continues real Queue cleanup after stop's whole-operation timeout", async () => {
    const f = fixture(),
      release = gate();
    await f.backend.ready();
    const q = f.manager.getOrCreateQueue(f.queue),
      close = q.close.bind(q);
    vi.spyOn(q, "close").mockImplementation(async () => {
      await release.promise;
      await close();
    });
    try {
      await expect(f.backend.stop({ timeout: 1 })).rejects.toThrow();
      expect((q as unknown as { closed: boolean }).closed).toBe(false);
      expect(() => f.manager.getOrCreateQueue({ name: "late-queue" })).toThrow(InvalidStateError);
      release.resolve();
      await until(() => (q as unknown as { closed: boolean }).closed);
      await until(async () => {
        try {
          await f.backend.ready();
          return true;
        } catch {
          return false;
        }
      });
      expect(f.manager.getOrCreateQueue(f.queue)).not.toBe(q);
    } finally {
      release.resolve();
      vi.restoreAllMocks();
      await f.close();
    }
  });
});

redisSuite("borrowed readiness cancellation and constructor validation", () => {
  it.each([
    { concurrency: 0 },
    { stalledInterval: 0 },
    { drainDelay: 0 },
    { maxStalledCount: -1 },
    { maxStartedAttempts: -1 },
  ])("rejects %j before allocating real Worker clients", async (workerOptions) => {
    const f = fixture();
    const borrowed = await freshBorrowedClient();
    const events = ["error", "close", "ready", "end"];
    const before = events.map((event) => borrowed.listenerCount(event));
    const manager = new BullMQQueueManager(borrowed);
    const duplicate = vi.spyOn(borrowed, "duplicate");
    const disconnect = vi.spyOn(borrowed, "disconnect");
    const quit = vi.spyOn(borrowed, "quit");
    try {
      await expect(
        manager.createWorker({ name: f.queue.name, config: { bullmq: { workerOptions } } }, async () => {}),
      ).rejects.toThrow();
      await manager.closeAll();
      expect(events.map((event) => borrowed.listenerCount(event))).toEqual(before);
      expect(duplicate).not.toHaveBeenCalled();
      expect(disconnect).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
      expect(await borrowed.ping()).toBe("PONG");
    } finally {
      await manager.closeAll();
      vi.restoreAllMocks();
      await borrowed.quit();
      await f.close();
    }
  });

  it.each([
    "stop",
    "timeout",
  ])("removes pending borrowed readiness listeners on %s and keeps Redis usable", async (kind) => {
    const f = fixture();
    const borrowed = await freshBorrowedClient();
    const events = ["ready", "end", "close", "error"];
    const before = events.map((event) => borrowed.listenerCount(event));
    const manager = new BullMQQueueManager(borrowed);
    const backend = new BullmqBackend({ queueManager: manager, defaultQueue: f.queue });
    const disconnect = vi.spyOn(borrowed, "disconnect");
    const quit = vi.spyOn(borrowed, "quit");
    const status = Object.getOwnPropertyDescriptor(borrowed, "status");
    if (!status) throw new Error("Missing borrowed client status");
    try {
      await backend.ready();
      const monitoring = events.map((event) => borrowed.listenerCount(event));
      // Only hold readiness at the status boundary: the borrowed socket remains live.
      // 接続を切断せず、再接続待ちの status 境界だけを固定する。
      Object.defineProperty(borrowed, "status", { configurable: true, get: () => "reconnecting" });
      const ready = backend.ready([], kind === "timeout" ? { timeout: 50 } : undefined).catch((error) => error);
      await until(() => borrowed.listenerCount("ready") === monitoring[0] + 1);
      if (kind === "stop") await backend.stop();
      expect(await ready).toBeInstanceOf(InvalidStateError);
      expect(events.map((event) => borrowed.listenerCount(event))).toEqual(kind === "stop" ? before : monitoring);
      // Reveal the live ioredis status, prove no disconnect/quit and late ready is harmless.
      Object.defineProperty(borrowed, "status", status);
      expect(await borrowed.ping()).toBe("PONG");
      borrowed.emit("ready");
      await backend.stop();
      expect(events.map((event) => borrowed.listenerCount(event))).toEqual(before);
      expect(disconnect).not.toHaveBeenCalled();
      expect(quit).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(borrowed, "status", status);
      await backend.stop();
      vi.restoreAllMocks();
      await borrowed.quit();
      await f.close();
    }
  });
});
