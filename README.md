# mokurokujs

[日本語](README.ja.md)

`mokurokujs` is a TypeScript library that aims to provide a message-queue-agnostic API for defining, enqueueing, and handling background jobs, plus optional scheduling. It separates **core abstractions** from **MQ-specific adapters** so you can keep application code stable while swapping queue implementations.

This repository is a pnpm/turbo monorepo.

## Packages

- `@mokurokujs/core`: MQ-agnostic abstractions and runtime facade
- `@mokurokujs/bullmq`: BullMQ adapter (backend + scheduler + helpers)

## Core concepts (MQ-agnostic)

- **`JobDefinition<TPayload>`**: typed job definition created by `defineJob()`
- **`QueueDefinition`**: queue definition created by `defineQueue()` (can carry MQ-specific config)
- **`JobRuntime`**: the app-facing facade (`enqueue`, `enqueueBulk`, `handle`, `start`, `stop`, pause/resume)
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
npm install @mokurokujs/core @mokurokujs/bullmq
```

## Quick start (BullMQ)

```ts
import { defineJob, JobRuntime } from "@mokurokujs/core";
import {
  BullMQQueueManager,
  createBullmqBackend,
  defineQueueForBullMQ,
} from "@mokurokujs/bullmq";

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
import { BullMQQueueManager, createBullmqScheduler } from "@mokurokujs/bullmq";

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
