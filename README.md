# mokurokujs

[日本語](README.ja.md)

`mokurokujs` is a TypeScript library that aims to provide a message-queue-agnostic API for defining, enqueueing, and handling background jobs, plus optional scheduling. It separates **core abstractions** from **MQ-specific adapters** so you can keep application code stable while swapping queue implementations.

This repository is a pnpm/turbo monorepo.

## Packages

- `@mokurokujs/core`: MQ-agnostic abstractions and runtime facade
- `@mokurokujs/bullmq-adapter`: BullMQ adapter (backend + scheduler + helpers)

## Core concepts (MQ-agnostic)

- **`JobDefinition<TPayload, TResult = void>`**: typed job definition created by `defineJob()`
- **`QueueDefinition`**: queue definition created by `defineQueue()` (can carry MQ-specific config)
- **`JobRuntime`**: the app-facing facade (`enqueue`, `enqueueBulk`, `handle`, `ready`, `start`, `stop`, pause/resume)
- **`JobBackend`**: interface implemented by MQ adapters (e.g. BullMQ)
- **`JobScheduler` / `SchedulerRuntime`**: optional cron/repeat scheduling facade
- **Hooks**:
  - `BackendHooks` (backend-level events, incl. `onEnqueue`)
  - `WorkerHooks` (start/success/retry/failure/workerError), supported by adapters

## Installation

```bash
npm install @mokurokujs/core
```

For BullMQ (requires Redis):

```bash
npm install @mokurokujs/core @mokurokujs/bullmq-adapter bullmq ioredis@^5.0.0
```

The connection-options path (`new BullMQQueueManager({ host, port })`) requires
`ioredis` 5.x. BullMQ 6 declares it as an optional peer and does not install it
automatically. The adapter also declares `ioredis: ^5.0.0` as an optional peer:
applications that pass an already constructed, compatible borrowed client own
that client's driver and lifetime. The isolated consumers verify ioredis 5.11.1.

## Quick start (BullMQ)

```ts
import { defineJob, JobRuntime } from "@mokurokujs/core";
import {
  BullMQQueueManager,
  createBullmqBackend,
  defineQueueForBullMQ,
} from "@mokurokujs/bullmq-adapter";

// BullMQ connection (Redis)
const queueManager = new BullMQQueueManager({
  host: "127.0.0.1",
  port: 6379,
});

// Queue definition (optional; default queue is "default")
const emailQueue = defineQueueForBullMQ("email", {
  workerOptions: { concurrency: 5 },
}).build();

// Typed job definition
const SendEmail = defineJob<{ to: string; subject: string }>("send-email", {
  queue: emailQueue,
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: true,
});

const backend = createBullmqBackend({
  queueManager,
  hooks: {
    onEnqueue: ({ jobName, queue }) => {
      console.log("enqueued", { jobName, queue });
    },
  },
});

const runtime = new JobRuntime(backend);

// Register handlers before start() so workers are created for those queues/jobs.
runtime.handle(SendEmail, async (payload, ctx) => {
  ctx.logger?.info("send-email", payload);
  // ... your business logic ...
});

await runtime.start();

await runtime.enqueue(SendEmail, { to: "a@example.com", subject: "Hello" });

// Graceful shutdown
await runtime.stop({ timeout: 10_000 });
```

### Enqueue options

`enqueue(job, payload, options)` can override parts of the `JobDefinition` defaults:

- `attempts`, `backoff`, `removeOnComplete`, `removeOnFail`
- `jobName` (defaults to `job.name`)
- `delay` (milliseconds)

## Scheduling (BullMQ)

BullMQ adapter implements `JobScheduler` using BullMQ repeatable jobs.

```ts
import { defineJob, SchedulerRuntime } from "@mokurokujs/core";
import { BullMQQueueManager, createBullmqScheduler } from "@mokurokujs/bullmq-adapter";

const queueManager = new BullMQQueueManager({ host: "127.0.0.1", port: 6379 });
const scheduler = createBullmqScheduler({ queueManager });
const schedulerRuntime = new SchedulerRuntime(scheduler);

const Cleanup = defineJob("cleanup", {});

await schedulerRuntime.upsert(Cleanup, {
  pattern: "0 * * * *", // every hour
  immediately: false,
  payload: undefined,
});
```

## Hooks (BullMQ)

BullMQ adapter supports three levels of `WorkerHooks`:

- **Backend-level**: `createBullmqBackend({ hooks })`
- **Queue-level**: set `hooks` in `defineQueueForBullMQ(name, { hooks: ... })`
- **Job-level**: `runtime.handle(job, handler, { hooks: ... })`

They are invoked in this order: **backend → queue → job**.

## Development

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
```

## Contributing

Contribution guidelines are intentionally lightweight for now. If you have an idea, bug report, or proposal, please open an issue first so we can align on direction before you start working on a PR.

## License

Apache-2.0 (see `LICENSE`).

## Queue lifecycle and compatibility

Use TypeScript **5.4+** (public declarations use `NoInfer`) and BullMQ
**`^5.16.0 || ^6.3.11`**. Imports flow from adapter to core/BullMQ; core has no
adapter dependency. The package versions in this checkout remain `0.1.0`;
these changes are preparation for a major release of both packages.

```ts
const Deliver = defineJob<{ id: string }, string>("deliver", { queue: emailQueue });
runtime.handle(Deliver, async (payload, ctx) => {
  console.log(ctx.jobName); // original saved name, including dynamic names
  return `delivered:${payload.id}`;
}, { defaultForQueue: true });
await runtime.ready([emailQueue], { timeout: 10_000 }); // connections only, no Worker
await runtime.start({ timeout: 10_000 });
await runtime.enqueue(Deliver, { id: "42" }, { jobName: "saved-dynamic-name" });
await runtime.stop({ timeout: 10_000 });
```

Within a queue, an exact name handler takes priority over its single default.
A handler failure follows retry policy; it does not invoke the default handler.
Saved name/data/options are preserved. Results are stored in BullMQ's
`returnvalue`; `enqueue` still returns `{ jobId, name }`, not the handler result.
Types do not validate data already saved in Redis.

Register handlers while idle. Conflicting defaults, registration after start and
new operations during stop reject. `ready()` prepares the default queue;
`ready([])` waits only for existing resources. Unsupported backends reject readiness
with `InvalidStateError` and `details.capability: "ready"`.

Producer-only runtimes use `ready`/enqueue/`stop` without `start`. Stop releases
managed queues even if no Worker was started, and drains Workers before closing
queues. Timeouts reject while cleanup continues; cleanup failures reject and
require a new manager. Borrowed Redis clients remain the caller's responsibility.
A shared backend/scheduler manager shares a lifetime; use separate managers for
producer and worker lifetimes.

Pass `{ onError(event) { /* application policy */ } }` as the manager's second
constructor argument to observe queue/worker `error`, `cleanup`,
`connection-ended` and worker `run-fulfilled`/`run-rejected` events. Ordinary errors
are diagnostics; unexpected connection/run termination informs the application's
failure policy. The library does not decide process exit or reconnection policy.
Existing worker hooks remain available.

See [design](docs/superpowers/specs/2026-11-09-mokuroku-queue-lifecycle-254-design.md)
and [preparation artifacts / #255 handoff](docs/handoffs/254.md) for validation status
and tarball consumption without publishing.
