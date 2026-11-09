import { defineJob, type JobRuntime, type JobScheduler, type SchedulerRuntime } from "../../src/index.js";

declare const runtime: JobRuntime;
declare const scheduler: SchedulerRuntime;
declare const rawScheduler: JobScheduler;
const job = defineJob<{ id: string }, string>("work");
runtime.handle(job, async (payload) => payload.id);
runtime.handle(job, async (payload) => payload.id, { defaultForQueue: true });
// @ts-expect-error wrong result
runtime.handle(job, async () => 1);
// @ts-expect-error missing result
runtime.handle(job, async () => {});
// @ts-expect-error wrong handler payload
runtime.handle(job, async (payload: { id: number }) => String(payload.id));
// @ts-expect-error wrong enqueue payload
runtime.enqueue(job, { id: 1 });
// @ts-expect-error wrong bulk payload
runtime.enqueueBulk(job, [{ payload: { id: 1 } }]);
// @ts-expect-error wrong schedule payload
scheduler.upsert(job, { pattern: "* * * * *", payload: { id: 1 } });
// @ts-expect-error scheduler interface must also reject wrong payload
rawScheduler.upsert(job, { pattern: "* * * * *", payload: { id: 1 } });
runtime.enqueue(job, { id: "a" });
runtime.enqueueBulk(job, [{ payload: { id: "a" } }]);
scheduler.upsert(job, { pattern: "* * * * *", payload: { id: "a" } });
scheduler.remove(job);
runtime.handle(defineJob<{ id: string }>("legacy"), async () => {});
runtime.handle<{ id: string }>(defineJob<{ id: string }>("explicit"), async () => {});
runtime.enqueue<{ id: string }>(job, { id: "a" });
// @ts-expect-error explicit generic payload still checked
runtime.enqueue<{ id: string }>(job, { id: 1 });
// @ts-expect-error explicit legacy handler payload still checked
runtime.handle<{ id: string }>(defineJob<{ id: string }>("explicit"), async (_p: { id: number }) => {});
const objectJob = defineJob<{ id: string }, { ok: boolean }>("object");
runtime.handle(objectJob, async () => ({ ok: true }));
// @ts-expect-error object result checked
runtime.handle(objectJob, async () => ({ ok: 1 }));
const unionJob = defineJob<{ id: string }, string | { ok: boolean }>("union");
runtime.handle(unionJob, async (p) => (p.id ? p.id : { ok: false }));
// @ts-expect-error union result checked
runtime.handle(unionJob, async () => false);
