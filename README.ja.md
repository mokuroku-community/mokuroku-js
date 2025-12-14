# mokurokujs

[English](README.md)

`mokurokujs` は、バックグラウンドジョブの **定義 / enqueue / 実行** を MQ 実装に依存せず扱えることを目指している TypeScript ライブラリです。**抽象 (core)** と **具象アダプタ (例: BullMQ)** を分離することで、アプリケーション側のコードを安定させたまま MQ 実装を差し替えられるようにします。

このリポジトリは pnpm/turbo の monorepo です。

## パッケージ構成

- `@mokurokujs/core`: MQ 実装に依存しない抽象型群 + ランタイムファサード
- `@mokurokujs/bullmq`: BullMQ アダプタ（backend + scheduler + helper）

## 主要コンセプト（MQ 非依存）

- **`JobDefinition<TPayload>`**: `defineJob()` で作る型付きジョブ定義
- **`QueueDefinition`**: `defineQueue()` で作るキュー定義（MQ 固有設定を保持可能）
- **`JobRuntime`**: アプリ側が使う入口（`enqueue`, `enqueueBulk`, `handle`, `start`, `stop`, pause/resume）
- **`JobBackend`**: MQ アダプタが実装するインターフェース（例: BullMQ）
- **`JobScheduler` / `SchedulerRuntime`**: cron / repeatable job を扱うためのファサード
- **Hook**:
  - `BackendHooks`（`onEnqueue` を含む backend レベルのイベント）
  - `WorkerHooks`（start/success/retry/failure/workerError）、アダプタが対応

## インストール

```bash
npm install @mokurokujs/core
```

BullMQ を使う場合（Redis が必要）:

```bash
npm install @mokurokujs/core @mokurokujs/bullmq
```

## クイックスタート（BullMQ）

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

// Queue 定義（省略可。未指定の場合は "default"）
const emailQueue = defineQueueForBullMQ("email", {
  workerOptions: { concurrency: 5 },
}).build();

// 型付きジョブ定義
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

// start() 前に handle() しておくと、そのジョブ/キューに対する Worker が作られます。
runtime.handle(SendEmail, async (payload, ctx) => {
  ctx.logger?.info("send-email", payload);
  // ... your business logic ...
});

await runtime.start();

await runtime.enqueue(SendEmail, { to: "a@example.com", subject: "Hello" });

// Graceful shutdown
await runtime.stop({ timeout: 10_000 });
```

### enqueue オプション

`enqueue(job, payload, options)` で `JobDefinition` のデフォルト値を上書きできます:

- `attempts`, `backoff`, `removeOnComplete`, `removeOnFail`
- `jobName`（デフォルトは `job.name`）
- `delay`（ミリ秒）

## スケジューリング（BullMQ）

BullMQ アダプタは BullMQ の repeatable job を使って `JobScheduler` を実装しています。

```ts
import { defineJob, SchedulerRuntime } from "@mokurokujs/core";
import { BullMQQueueManager, createBullmqScheduler } from "@mokurokujs/bullmq";

const queueManager = new BullMQQueueManager({ host: "127.0.0.1", port: 6379 });
const scheduler = createBullmqScheduler({ queueManager });
const schedulerRuntime = new SchedulerRuntime(scheduler);

const Cleanup = defineJob("cleanup", {});

await schedulerRuntime.upsert(Cleanup, {
  pattern: "0 * * * *", // 毎時
  immediately: false,
  payload: undefined,
});
```

## Hook（BullMQ）

BullMQ アダプタでは `WorkerHooks` を 3 段階で設定できます:

- **Backend レベル**: `createBullmqBackend({ hooks })`
- **Queue レベル**: `defineQueueForBullMQ(name, { hooks: ... })`
- **Job レベル**: `runtime.handle(job, handler, { hooks: ... })`

呼び出し順は **backend → queue → job** です。

## 開発

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm lint
```

## コントリビューション

現時点ではコントリビューションに関する細かい規定は決めていません。アイデア提案やバグ報告、改善の相談などがあれば、まず最初に Issue を起票してもらえると助かります（PR の作業に入る前に方向性を揃えるため）。

## ライセンス

Apache-2.0（`LICENSE` を参照）。
