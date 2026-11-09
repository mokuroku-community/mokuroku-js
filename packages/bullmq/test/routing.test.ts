import { defineJob, HandlerNotRegisteredError, InvalidStateError } from "@mokurokujs/core";
import { Queue } from "bullmq";
import { expect, it } from "vitest";

import { connection, fixture, redisSuite, until } from "./support.js";

redisSuite("persisted routing and results", () => {
  it("consumes arbitrary saved names after the producer closes, with named precedence and selected hooks", async () => {
    const f = fixture();
    const producer = new Queue(f.queue.name, { connection: connection() });
    const seen: string[] = [],
      hooks: string[] = [];
    const a = await producer.add("arbitrary", { text: "raw" }, { jobId: "raw-id", removeOnComplete: false });
    const b = await producer.add("named", { text: "named" });
    await producer.close();
    f.backend.registerHandler(
      defineJob<unknown, string>("fallback"),
      async (_, ctx) => {
        seen.push(ctx.jobName);
        return "fallback-result";
      },
      { defaultForQueue: true, hooks: { onSuccess: () => hooks.push("fallback") } },
    );
    f.backend.registerHandler(
      defineJob<unknown, { ok: boolean }>("named"),
      async (_, ctx) => {
        seen.push(ctx.jobName);
        return { ok: true };
      },
      { hooks: { onSuccess: () => hooks.push("named") } },
    );
    try {
      await f.backend.start();
      await until(async () => (await f.raw.getCompletedCount()) === 2);
      if (!a.id || !b.id) throw new Error("Missing persisted job IDs");
      const storedA = await f.raw.getJob(a.id),
        storedB = await f.raw.getJob(b.id);
      expect(storedA).toMatchObject({
        name: "arbitrary",
        id: "raw-id",
        data: { text: "raw" },
        returnvalue: "fallback-result",
        opts: { removeOnComplete: false },
      });
      expect(storedB?.returnvalue).toEqual({ ok: true });
      expect(seen).toEqual(["arbitrary", "named"]);
      expect(hooks).toEqual(["fallback", "named"]);
    } finally {
      await f.close();
    }
  });
  it("keeps same-name registrations in separate queues", async () => {
    const f = fixture(),
      other = fixture();
    const a = defineJob<unknown, string>("same", { queue: f.queue });
    const b = defineJob<unknown, string>("same", { queue: other.queue });
    f.backend.registerHandler(a, async () => "alpha");
    f.backend.registerHandler(b, async () => "beta");
    try {
      const x = await f.backend.enqueue(a, {}),
        y = await f.backend.enqueue(b, {});
      await f.backend.start();
      await until(async () => (await f.raw.getCompletedCount()) === 1 && (await other.raw.getCompletedCount()) === 1);
      expect((await f.raw.getJob(x.jobId))?.returnvalue).toBe("alpha");
      expect((await other.raw.getJob(y.jobId))?.returnvalue).toBe("beta");
    } finally {
      await f.close();
      await other.close();
    }
  });
  it("clears replaced hooks and never falls back after a named handler throws", async () => {
    const f = fixture();
    const old: string[] = [],
      fallback: string[] = [];
    const failure = new Error("original-handler-error");
    const named = defineJob("named");
    f.backend.registerHandler(named, async () => {}, { hooks: { onStart: () => old.push("old") } });
    f.backend.registerHandler(named, async () => {
      throw failure;
    });
    f.backend.registerHandler(
      defineJob("default"),
      async () => {
        fallback.push("fallback");
      },
      { defaultForQueue: true },
    );
    try {
      const item = await f.backend.enqueue(named, {});
      await f.backend.start();
      await until(async () => (await f.raw.getFailedCount()) === 1);
      expect((await f.raw.getJob(item.jobId))?.failedReason).toBe("original-handler-error");
      expect(old).toEqual([]);
      expect(fallback).toEqual([]);
    } finally {
      await f.close();
    }
  });
  it("fails an unknown name without a default", async () => {
    const f = fixture();
    f.backend.registerHandler(defineJob("known"), async () => {});
    try {
      const item = await f.raw.add("unknown", {});
      await f.backend.start();
      await until(async () => (await f.raw.getFailedCount()) === 1);
      if (!item.id) throw new Error("Missing persisted job ID");
      const stored = await f.raw.getJob(item.id);
      if (!stored) throw new Error("Missing failed job");
      expect(stored.failedReason).toBe(new HandlerNotRegisteredError("unknown").message);
    } finally {
      await f.close();
    }
  });
  it.each(["single", "bulk"])("preserves %s name/id/data/options and string/object/void results", async (mode) => {
    const f = fixture();
    const job = defineJob<{ result: string }, unknown>("fallback", { attempts: 3, removeOnComplete: false });
    f.backend.registerHandler(
      job,
      async (data) => (data.result === "string" ? "value" : data.result === "object" ? { value: 42 } : undefined),
      { defaultForQueue: true },
    );
    try {
      const items = ["string", "object", "void"].map((result) => ({
        payload: { result },
        options: { jobName: result, jobId: `${mode}-${result}`, delay: 0 },
      }));
      const enqueued =
        mode === "bulk"
          ? await f.backend.enqueueBulk(job, items)
          : await Promise.all(items.map((item) => f.backend.enqueue(job, item.payload, item.options)));
      expect(enqueued).toEqual(items.map((item) => ({ jobId: item.options.jobId, name: item.options.jobName })));
      await f.backend.start();
      await until(async () => (await f.raw.getCompletedCount()) === 3);
      for (const [index, expected] of ["value", { value: 42 }, null].entries()) {
        const stored = await f.raw.getJob(items[index].options.jobId);
        expect(stored).toMatchObject({
          name: items[index].options.jobName,
          data: items[index].payload,
          opts: { attempts: 3, delay: 0, removeOnComplete: false },
          returnvalue: expected,
        });
      }
    } finally {
      await f.close();
    }
  });
  it("rejects default collisions without destroying the first registration", async () => {
    const f = fixture();
    f.backend.registerHandler(defineJob("first"), async () => {}, { defaultForQueue: true });
    expect(() => f.backend.registerHandler(defineJob("second"), async () => {}, { defaultForQueue: true })).toThrow(
      InvalidStateError,
    );
    await f.close();
  });
});
