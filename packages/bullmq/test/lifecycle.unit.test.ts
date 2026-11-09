// The doubles isolate connection scheduling; these do not certify Redis connectivity.

import { defineJob, InvalidStateError } from "@mokurokujs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventEmitter } from "node:events";

const boundary = vi.hoisted(() => ({ queues: [] as unknown[], workers: [] as unknown[], keepRunOnPause: false }));
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Client extends EventEmitter {
  status = "ready";
  disconnect() {
    this.status = "end";
    this.emit("end");
  }
}
class Connection extends EventEmitter {
  _client = new Client();
  gate = deferred<Client>();
  constructor() {
    super();
    this.gate.resolve(this._client);
  }
  get client() {
    return this.gate.promise;
  }
  async disconnect() {
    this._client.emit("close");
  }
}
class QueueDouble extends EventEmitter {
  connection = new Connection();
  closed = false;
  closeGate: Promise<void> | undefined;
  constructor(
    readonly name: string,
    readonly opts: Record<string, unknown>,
  ) {
    super();
    boundary.queues.push(this);
  }
  get client() {
    return this.connection.client;
  }
  waitUntilReady() {
    return this.client;
  }
  async close() {
    await this.closeGate;
    this.closed = true;
  }
}
class WorkerDouble extends QueueDouble {
  blockingConnection = new Connection();
  runs: ReturnType<typeof deferred>[] = [];
  paused = false;
  closing = false;
  constructor(
    name: string,
    readonly processor: (job: unknown) => Promise<unknown>,
    opts: Record<string, unknown>,
  ) {
    super(name, opts);
    boundary.queues.pop();
    boundary.workers.push(this);
  }
  async waitUntilReady() {
    await this.client;
    return this.blockingConnection.client;
  }
  run() {
    const run = deferred();
    this.runs.push(run);
    return run.promise;
  }
  isPaused() {
    return this.paused;
  }
  async pause() {
    this.paused = true;
    await this.blockingConnection.disconnect();
    if (!boundary.keepRunOnPause) {
      const run = this.runs.at(-1);
      if (!run) throw new Error("Missing running loop");
      run.resolve();
    }
  }
  resume() {
    this.paused = false;
    if (!boundary.keepRunOnPause) void this.run();
  }
  async close() {
    this.closing = true;
    this.runs.at(-1)?.resolve();
    await super.close();
  }
}
vi.doMock("bullmq", () => ({ Queue: QueueDouble, Worker: WorkerDouble }));
const { BullmqBackend } = await import("../src/backend.js");
const { BullMQQueueManager } = await import("../src/queue-manager.js");
const queue = { name: "alpha", config: { bullmq: {} } };
const queues = () => boundary.queues as QueueDouble[];
const workers = () => boundary.workers as WorkerDouble[];
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  boundary.keepRunOnPause = false;
  boundary.queues.length = 0;
  boundary.workers.length = 0;
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const events: unknown[] = [];
  const manager = new BullMQQueueManager({}, { onError: (event) => events.push(event) });
  const backend = new BullmqBackend({ queueManager: manager, defaultQueue: queue });
  const job = defineJob<unknown, unknown>("fallback");
  return { manager, backend, job, events };
}

describe("adapter lifecycle without a Redis runtime", () => {
  it("producer-only stop actually closes queues", async () => {
    const { manager, backend } = fixture();
    manager.getOrCreateQueue(queue);
    await backend.stop();
    expect(queues()[0].closed).toBe(true);
  });
  it("rejects conflicting queue defaults before replacing routing", () => {
    const { backend, job } = fixture();
    backend.registerHandler(job, async () => "first", { defaultForQueue: true });
    expect(() => backend.registerHandler(defineJob("other"), async () => {}, { defaultForQueue: true })).toThrow(
      InvalidStateError,
    );
  });
  it("returns fallback results without rewriting the persisted job name", async () => {
    const { backend, job } = fixture();
    backend.registerHandler(job, async (_, ctx) => ctx.jobName, { defaultForQueue: true });
    await backend.start();
    try {
      await expect(
        workers()[0].processor({ name: "saved-name", data: {}, id: "17", attemptsMade: 0, timestamp: 0 }),
      ).resolves.toBe("saved-name");
    } finally {
      await backend.stop();
    }
  });
  it("waits for Queue readiness instead of only Worker readiness", async () => {
    const { manager, backend, job } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred<Client>();
    queues()[0].connection.gate = gate;
    backend.registerHandler(job, async () => {});
    let done = false;
    const start = backend.start().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    gate.resolve(queues()[0].connection._client);
    await start;
    await backend.stop();
  });
  it("collects every cleanup failure and still waits for a slow Queue", async () => {
    const { manager } = fixture();
    manager.getOrCreateQueue(queue);
    manager.getOrCreateQueue({ name: "beta" });
    manager.getOrCreateQueue({ name: "slow" });
    const first = new Error("first close"),
      second = new Error("second close");
    vi.spyOn(queues()[0], "close").mockRejectedValue(first);
    vi.spyOn(queues()[1], "close").mockRejectedValue(second);
    const gate = deferred();
    queues()[2].closeGate = gate.promise;
    let settled = false;
    const result = manager
      .closeAll()
      .catch((error) => error)
      .then((value) => {
        settled = true;
        return value;
      });
    await tick();
    expect(settled).toBe(false);
    gate.resolve();
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([first, second]);
    expect(queues()[2].closed).toBe(true);
    expect(() => manager.getOrCreateQueue(queue)).toThrow(InvalidStateError);
  });
  it("observes unexpected run fulfillment", async () => {
    const { backend, job, events } = fixture();
    backend.registerHandler(job, async () => {});
    await backend.start();
    workers()[0].runs[0].resolve();
    await tick();
    expect(events).toContainEqual(
      expect.objectContaining({ reason: "run-fulfilled", resource: "worker", queue: "alpha" }),
    );
    await backend.stop();
  });
  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid timeout %s before making a Queue", async (timeout) => {
    const { backend } = fixture();
    await expect(backend.ready(undefined, { timeout })).rejects.toThrow();
    expect(queues()).toHaveLength(0);
  });
});

describe("lifecycle races and fault isolation", () => {
  it.each(["command", "blocking"] as const)("waits for Worker %s readiness before running", async (connection) => {
    const { manager, backend, job } = fixture();
    backend.registerHandler(job, async () => {});
    const original = manager.createWorker.bind(manager);
    const gate = deferred<Client>();
    vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
      const result = await original(...args);
      const target = workers()[0];
      (connection === "command" ? target.connection : target.blockingConnection).gate = gate;
      return result;
    });
    let done = false;
    const start = backend.start().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    expect(workers()[0].runs).toHaveLength(0);
    gate.resolve(connection === "command" ? workers()[0].connection._client : workers()[0].blockingConnection._client);
    await start;
    await backend.stop();
  });
  it("latches a previously ready connection failure while another Queue is pending", async () => {
    const { manager, backend } = fixture();
    manager.getOrCreateQueue(queue);
    manager.getOrCreateQueue({ name: "pending" });
    const gate = deferred<Client>();
    queues()[1].connection.gate = gate;
    const start = backend.start().catch((error) => error);
    await tick();
    queues()[0].connection._client.disconnect();
    gate.resolve(queues()[1].connection._client);
    expect(await start).toBeInstanceOf(Error);
    expect(queues().every((item) => item.closed)).toBe(true);
  });
  it("rejects an already ended connection", async () => {
    const { manager, backend } = fixture();
    manager.getOrCreateQueue(queue);
    queues()[0].connection._client.status = "end";
    await expect(backend.start()).rejects.toThrow();
  });
  it.each([2, 3])("rolls back resources if Worker %s construction fails", async (position) => {
    const { manager, backend } = fixture();
    for (let i = 0; i < position; i++)
      backend.registerHandler(defineJob(`job${i}`, { queue: { name: `queue${i}` } }), async () => {});
    const original = manager.createWorker.bind(manager);
    let calls = 0;
    const failure = new Error("construction");
    vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
      if (++calls === position) throw failure;
      return original(...args);
    });
    await expect(backend.start()).rejects.toBe(failure);
    expect(workers().every((item) => item.closed)).toBe(true);
    expect(queues().every((item) => item.closed)).toBe(true);
  });
  it("shares concurrent startup completion", async () => {
    const { manager, backend } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred<Client>();
    queues()[0].connection.gate = gate;
    let secondDone = false;
    const first = backend.start();
    const second = backend.start().then(() => {
      secondDone = true;
    });
    await tick();
    expect(secondDone).toBe(false);
    gate.resolve(queues()[0].connection._client);
    await Promise.all([first, second]);
    await backend.stop();
  });
  it("stop cancels pending startup and a late ready never starts a Worker", async () => {
    const { manager, backend, job } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred<Client>();
    queues()[0].connection.gate = gate;
    backend.registerHandler(job, async () => {});
    const start = backend.start().catch((error) => error);
    await tick();
    await backend.stop();
    gate.resolve(queues()[0].connection._client);
    await tick();
    expect(await start).toBeInstanceOf(Error);
    expect(workers().every((worker) => worker.runs.length === 0)).toBe(true);
  });
  it("keeps the manager closing after a Queue cleanup deadline until settlement", async () => {
    const { manager } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred();
    queues()[0].closeGate = gate.promise;
    await expect(manager.closeAll({ timeout: 1 })).rejects.toThrow();
    expect(() => manager.getOrCreateQueue({ name: "new" })).toThrow(InvalidStateError);
    gate.resolve();
    await tick();
    expect(queues()[0].closed).toBe(true);
    expect(() => manager.getOrCreateQueue({ name: "new" })).not.toThrow();
    await manager.closeAll();
  });
  it("captures error events even if close resolves and isolates throwing observers", async () => {
    const errors: string[] = [];
    const manager = new BullMQQueueManager(
      {},
      {
        onError: () => {
          throw new Error("observer");
        },
        logger: {
          debug() {},
          info() {},
          warn() {},
          error(message) {
            errors.push(message);
          },
        },
      },
    );
    manager.getOrCreateQueue(queue);
    const failure = new Error("inside close");
    vi.spyOn(queues()[0], "close").mockImplementation(async () => {
      queues()[0].emit("error", failure);
    });
    await expect(manager.closeAll()).rejects.toMatchObject({ errors: [failure] });
    expect(errors.length).toBeGreaterThan(0);
  });
  it.each([
    [false, "resolve"],
    [false, "reject"],
    [true, "resolve"],
    [true, "reject"],
  ] as const)("monitors native resume (continuing=%s) %s and paused command loss", async (continuing, kind) => {
    boundary.keepRunOnPause = continuing;
    const { backend, job, events } = fixture();
    backend.registerHandler(job, async () => {});
    await backend.start();
    const worker = workers()[0];
    const originalRun = worker.runs[0];
    await backend.pauseAll();
    await tick();
    expect(events).toEqual([]);
    worker.connection._client.disconnect();
    await tick();
    expect(events).toContainEqual(expect.objectContaining({ reason: "connection-ended", connection: "command" }));
    worker.connection._client.status = "ready";
    await backend.resumeAll();
    expect(worker.runs).toHaveLength(continuing ? 1 : 2);
    const activeRun = worker.runs.at(-1);
    if (!activeRun) throw new Error("Missing resumed loop");
    expect(activeRun === originalRun).toBe(continuing);
    const failure = new Error("resumed-loop");
    if (kind === "resolve") activeRun.resolve();
    else activeRun.reject(failure);
    await tick();
    expect(events).toContainEqual(
      expect.objectContaining({
        reason: kind === "resolve" ? "run-fulfilled" : "run-rejected",
        ...(kind === "reject" ? { error: failure } : {}),
      }),
    );
    await backend.stop();
  });
  it("rejects registration while started and after stop allows a clean restart", async () => {
    const { backend, job } = fixture();
    backend.registerHandler(job, async () => {});
    await backend.start();
    expect(() => backend.registerHandler(job, async () => {})).toThrow(InvalidStateError);
    await backend.stop();
    backend.registerHandler(job, async () => {});
    await backend.start();
    await backend.stop();
    expect(workers()).toHaveLength(2);
  });
  it("removes manager listeners after successful shutdown", async () => {
    const { backend, manager } = fixture();
    manager.getOrCreateQueue(queue);
    const client = queues()[0].connection._client;
    await backend.ready([]);
    await backend.stop();
    expect(client.listenerCount("end")).toBe(0);
    expect(client.listenerCount("close")).toBe(0);
  });
});

describe("deadline and pause regressions", () => {
  it("never suppresses unrelated blocking loss while a pause is still draining", async () => {
    const { backend, job, events } = fixture();
    backend.registerHandler(job, async () => {});
    await backend.start();
    const draining = deferred();
    vi.spyOn(WorkerDouble.prototype, "pause").mockImplementation(async () => {
      await draining.promise;
    });
    const pause = backend.pauseAll();
    await tick();
    workers()[0].blockingConnection._client.disconnect();
    draining.resolve();
    await pause;
    expect(events).toContainEqual(expect.objectContaining({ reason: "connection-ended", connection: "blocking" }));
    await backend.stop();
  });
  it("does not clamp large finite deadlines to one millisecond", async () => {
    const { manager } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred();
    queues()[0].closeGate = gate.promise;
    let settled = false;
    const close = manager
      .closeAll({ timeout: 2 ** 32 })
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    await tick();
    await tick();
    const prematurelySettled = settled;
    gate.resolve();
    await close;
    expect(prematurelySettled).toBe(false);
  });
  it("returns an immediate deadline for zero and still continues cleanup", async () => {
    const { manager } = fixture();
    manager.getOrCreateQueue(queue);
    const gate = deferred();
    queues()[0].closeGate = gate.promise;
    await expect(manager.closeAll({ timeout: 0 })).rejects.toThrow();
    expect(queues()[0].closed).toBe(false);
    gate.resolve();
    await tick();
    expect(queues()[0].closed).toBe(true);
  });
  it("latched immediate run fulfillment rejects startup and recovers resources", async () => {
    const { backend, job } = fixture();
    backend.registerHandler(job, async () => {});
    vi.spyOn(WorkerDouble.prototype, "run").mockResolvedValue(undefined);
    await expect(backend.start()).rejects.toThrow();
    expect(queues().every((q) => q.closed)).toBe(true);
  });
  it("retains the original startup cause when cleanup also fails", async () => {
    const { backend, manager, job } = fixture();
    backend.registerHandler(job, async () => {});
    const original = manager.createWorker.bind(manager),
      startup = new Error("startup"),
      cleanup = new Error("cleanup");
    vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
      await original(...args);
      vi.spyOn(workers()[0], "close").mockRejectedValue(cleanup);
      throw startup;
    });
    await expect(backend.start()).rejects.toMatchObject({ cause: startup, errors: [cleanup] });
  });
  it("startup deadline prevents late Worker runs and permits restart after cleanup", async () => {
    const { backend, manager, job } = fixture();
    manager.getOrCreateQueue(queue);
    backend.registerHandler(job, async () => {});
    const gate = deferred<Client>();
    queues()[0].connection.gate = gate;
    await expect(backend.start({ timeout: 1 })).rejects.toThrow();
    await tick();
    gate.resolve(queues()[0].connection._client);
    await tick();
    expect(workers()[0].runs).toHaveLength(0);
    await backend.start();
    expect(workers()[1].runs).toHaveLength(1);
    await backend.stop();
  });
  it("checks command readiness before resuming", async () => {
    const { backend, job } = fixture();
    backend.registerHandler(job, async () => {});
    await backend.start();
    await backend.pauseAll();
    const client = workers()[0].connection._client;
    client.status = "connecting";
    let resumed = false;
    const resume = backend.resumeAll().then(() => {
      resumed = true;
    });
    await tick();
    expect(resumed).toBe(false);
    client.status = "ready";
    client.emit("ready");
    await resume;
    await backend.stop();
  });
});

it("collects a Queue error emitted while Workers are still draining", async () => {
  const { backend, job } = fixture();
  backend.registerHandler(job, async () => {});
  await backend.start();
  const gate = deferred();
  workers()[0].closeGate = gate.promise;
  const failure = new Error("producer failed during drain");
  const result = backend.stop().catch((error) => error);
  await tick();
  queues()[0].emit("error", failure);
  gate.resolve();
  expect(await result).toMatchObject({ errors: [failure] });
});

it("uses actual terminal markers for retry classification including null markers after manual retry", async () => {
  const { backend } = fixture(),
    retry: number[] = [],
    failed: number[] = [],
    success: number[] = [];
  const job = defineJob("job");
  backend.registerHandler(job, async () => {}, {
    hooks: {
      onRetry: (ctx: { attempt: number }) => retry.push(ctx.attempt),
      onFailure: (ctx: { attempt: number }) => failed.push(ctx.attempt),
      onSuccess: (ctx: { attempt: number }) => success.push(ctx.attempt),
    },
  });
  await backend.start();
  const raw = {
    name: "job",
    id: "1",
    timestamp: 0,
    attemptsMade: 0,
    opts: { attempts: 5 },
    finishedOn: null as number | null,
  };
  workers()[0].emit("active", raw);
  raw.attemptsMade = 1;
  workers()[0].emit("failed", raw, new Error("retry"));
  workers()[0].emit("active", raw);
  raw.attemptsMade = 2;
  raw.finishedOn = 100;
  workers()[0].emit("failed", raw, new Error("terminal"));
  raw.attemptsMade = 0;
  workers()[0].emit("active", raw);
  raw.attemptsMade = 1;
  workers()[0].emit("completed", raw);
  expect(retry).toEqual([1]);
  expect(failed).toEqual([2]);
  expect(success).toEqual([1]);
  await backend.stop();
});

it("selects named/default hooks together and removes hooks on re-registration", async () => {
  const { backend } = fixture(),
    calls: string[] = [];
  const job = defineJob<unknown, string>("named"),
    fallback = defineJob<unknown, string>("fallback");
  backend.registerHandler(job, async () => "old", { hooks: { onStart: () => calls.push("old") } });
  backend.registerHandler(job, async () => "named-result");
  backend.registerHandler(fallback, async () => "default-result", {
    defaultForQueue: true,
    hooks: { onStart: () => calls.push("fallback") },
  });
  await backend.start();
  try {
    const base = { data: {}, id: "1", timestamp: 0, attemptsMade: 0, opts: {} };
    workers()[0].emit("active", { ...base, name: "named" });
    expect(await workers()[0].processor({ ...base, name: "named" })).toBe("named-result");
    workers()[0].emit("active", { ...base, name: "arbitrary" });
    expect(await workers()[0].processor({ ...base, name: "arbitrary" })).toBe("default-result");
    expect(calls).toEqual(["fallback"]);
  } finally {
    await backend.stop();
  }
});
it("does not fallback on a named handler exception and isolates same names by queue", async () => {
  const { backend } = fixture();
  const error = new Error("original");
  let fallbackCalls = 0;
  backend.registerHandler(defineJob("same", { queue: { name: "alpha" } }), async () => {
    throw error;
  });
  backend.registerHandler(defineJob<unknown, string>("same", { queue: { name: "beta" } }), async () => "beta");
  backend.registerHandler(
    defineJob("default"),
    async () => {
      fallbackCalls++;
    },
    { defaultForQueue: true },
  );
  await backend.start();
  try {
    const job = { name: "same", data: {}, id: "1", timestamp: 0, attemptsMade: 0 };
    await expect(workers()[0].processor(job)).rejects.toBe(error);
    await expect(workers()[1].processor(job)).resolves.toBe("beta");
    expect(fallbackCalls).toBe(0);
  } finally {
    await backend.stop();
  }
});

it("shares startup failure and cleanup settlement with another start during rollback", async () => {
  const { backend, manager, job } = fixture();
  backend.registerHandler(job, async () => {});
  const create = manager.createWorker.bind(manager),
    gate = deferred(),
    failure = new Error("startup-failure");
  vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
    await create(...args);
    workers()[0].closeGate = gate.promise;
    throw failure;
  });
  const first = backend.start().catch((error) => error);
  await tick();
  let secondSettled = false;
  const second = backend
    .start()
    .catch((error) => error)
    .then((error) => {
      secondSettled = true;
      return error;
    });
  await tick();
  const settledBeforeCleanup = secondSettled;
  gate.resolve();
  expect(await first).toBe(failure);
  expect(await second).toBe(failure);
  expect(settledBeforeCleanup).toBe(false);
});
it("stop during startup preserves actual cleanup failures", async () => {
  const { backend, manager, job } = fixture();
  backend.registerHandler(job, async () => {});
  const original = manager.createWorker.bind(manager),
    cleanup = new Error("startup-stop-cleanup"),
    gate = deferred<Client>();
  vi.spyOn(manager, "createWorker").mockImplementation(async (...args) => {
    const result = await original(...args);
    workers()[0].connection.gate = gate;
    vi.spyOn(workers()[0], "close").mockRejectedValue(cleanup);
    return result;
  });
  const start = backend.start().catch((error) => error);
  await tick();
  const stop = backend.stop().catch((error) => error);
  expect(await stop).toMatchObject({ errors: [cleanup] });
  expect(await start).toMatchObject({ errors: [cleanup] });
});

it("shares concurrent stop completion and uses the first call's deadline", async () => {
  const { backend, job, events } = fixture();
  backend.registerHandler(job, async () => {});
  await backend.start();
  const gate = deferred();
  queues()[0].closeGate = gate.promise;
  let secondDone = false;
  const first = backend.stop(),
    second = backend.stop({ timeout: 0 }).then(() => {
      secondDone = true;
    });
  await tick();
  const finishedEarly = secondDone;
  gate.resolve();
  await Promise.all([first, second]);
  expect(finishedEarly).toBe(false);
  expect(events).toEqual([]);
});

it("does not classify initialization rejection on a live connection as connection-ended", async () => {
  const { backend, manager, events } = fixture();
  const gate = deferred<Client>();
  vi.spyOn(Connection.prototype, "client", "get").mockReturnValue(gate.promise);
  manager.getOrCreateQueue(queue);
  const failure = new Error("initialization-command-failed"),
    ready = backend.ready([]).catch((error) => error);
  gate.reject(failure);
  expect(await ready).toBe(failure);
  expect(events.filter((event) => (event as { reason: string }).reason === "connection-ended")).toEqual([]);
  await backend.stop();
});

it("stop cancels ready([]) and removes temporary listeners before a late borrowed ready", async () => {
  const { manager, backend } = fixture();
  manager.getOrCreateQueue(queue);
  const client = queues()[0].connection._client;
  client.status = "reconnecting";
  const ready = backend.ready([]).catch((error) => error);
  await tick();
  expect(client.listenerCount("ready")).toBe(2);
  expect(client.listenerCount("end")).toBe(2);
  await backend.stop();
  expect(await ready).toBeInstanceOf(InvalidStateError);
  expect(client.listenerCount("ready")).toBe(0);
  expect(client.listenerCount("end")).toBe(0);
  expect(client.status).toBe("reconnecting");
  client.status = "ready";
  client.emit("ready");
  expect(client.listenerCount("ready")).toBe(0);
});

it("a failed readiness operation cancels the other temporary waits without closing their clients", async () => {
  const { manager } = fixture();
  manager.getOrCreateQueue(queue);
  manager.getOrCreateQueue({ name: "pending-ready" });
  const pending = queues()[1].connection._client;
  pending.status = "reconnecting";
  const ready = manager.ready().catch((error) => error);
  await tick();
  queues()[0].connection._client.disconnect();
  expect(await ready).toBeInstanceOf(Error);
  expect(pending.listenerCount("ready")).toBe(1);
  expect(pending.listenerCount("end")).toBe(1);
  expect(pending.status).toBe("reconnecting");
  await manager.closeAll();
});

it.each([
  { concurrency: 0 },
  { concurrency: 0.5 },
  { concurrency: Number.NaN },
  { concurrency: Number.POSITIVE_INFINITY },
  { concurrency: undefined },
  { stalledInterval: 0 },
  { stalledInterval: undefined },
  { drainDelay: 0 },
  { drainDelay: undefined },
  { maxStalledCount: -1 },
  { maxStalledCount: undefined },
  { maxStartedAttempts: -1 },
])("prevalidates Worker settings %j before allocating resources", async (workerOptions) => {
  const { manager } = fixture();
  await expect(
    manager.createWorker({ name: "invalid", config: { bullmq: { workerOptions } } }, async () => {}),
  ).rejects.toThrow();
  expect(workers()).toHaveLength(0);
  expect(queues()).toHaveLength(0);
  await manager.closeAll();
});

it("monitor disposal cancels all readiness waits even before initialization settles", async () => {
  const { ConnectionMonitor } = await import("../src/connection-monitor.js");
  const connection = new Connection();
  connection.gate = deferred<Client>();
  const monitor = new ConnectionMonitor(
    connection as unknown as import("../src/connection-monitor.js").ConnectionHandle,
    () => {},
    () => false,
  );
  const first = monitor.ready().catch((error) => error);
  const second = monitor.ready().catch((error) => error);
  monitor.dispose();
  // A broken disposer must fail this assertion, not hang the test waiting for readiness.
  const pending = Symbol("pending");
  expect(await Promise.race([first, tick().then(() => pending)])).toBeInstanceOf(InvalidStateError);
  expect(await second).toBeInstanceOf(InvalidStateError);
  connection.gate.resolve(connection._client);
  await tick();
  expect(connection._client.eventNames()).toEqual([]);
  await expect(monitor.ready()).rejects.toBeInstanceOf(InvalidStateError);
});
