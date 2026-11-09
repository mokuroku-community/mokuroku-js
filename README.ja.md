# mokurokujs

[English](README.md)

`mokurokujs` は、バックグラウンドジョブの **定義 / enqueue / 実行** を MQ 実装に依存せず扱えることを目指している TypeScript ライブラリです。**抽象 (core)** と **具象アダプタ (例: BullMQ)** を分離することで、アプリケーション側のコードを安定させたまま MQ 実装を差し替えられるようにします。

このリポジトリは pnpm/turbo の monorepo です。

## パッケージ構成

- `@mokurokujs/core`: MQ 実装に依存しない抽象型群 + ランタイムファサード
- `@mokurokujs/bullmq-adapter`: BullMQ アダプタ（backend + scheduler + helper）

## 主要コンセプト（MQ 非依存）

- **`JobDefinition<TPayload, TResult = void>`**: `defineJob()` で作る型付きジョブ定義
- **`QueueDefinition`**: `defineQueue()` で作るキュー定義（MQ 固有設定を保持可能）
- **`JobRuntime`**: アプリ側が使う入口（`enqueue`, `enqueueBulk`, `handle`, `ready`, `start`, `stop`, pause/resume）
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
npm install @mokurokujs/core @mokurokujs/bullmq-adapter bullmq ioredis@^5.0.0
```

接続 options を渡す経路（`new BullMQQueueManager({ host, port })`）には
`ioredis` 5.x が必要です。BullMQ 6 では optional peer のため自動導入されません。
adapter も `ioredis: ^5.0.0` を optional peer とします。互換性のある構築済み client を
借用で渡す場合は、利用側がその driver の導入と client の寿命を管理します。
隔離 consumer では ioredis 5.11.1 を検証します。

## クイックスタート（BullMQ）

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
import { BullMQQueueManager, createBullmqScheduler } from "@mokurokujs/bullmq-adapter";

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

## キューのライフサイクルと互換性

TypeScript **5.4 以上**（公開宣言に `NoInfer` を使用）、BullMQ
**`^5.16.0 || ^6.3.11`** に対応します。import の依存方向は adapter → core / BullMQ
であり、core は adapter に依存しません。追跡中の版は両方 `0.1.0` のままで、
今回の変更は両 package の major release に向けた準備です。

```ts
const Deliver = defineJob<{ id: string }, string>("deliver", { queue: emailQueue });
runtime.handle(Deliver, async (payload, ctx) => {
  console.log(ctx.jobName); // 動的な名前も含め、保存済みの名前を維持
  return `delivered:${payload.id}`;
}, { defaultForQueue: true });
await runtime.ready([emailQueue], { timeout: 10_000 }); // 接続だけを準備、Worker は作らない
await runtime.start({ timeout: 10_000 });
await runtime.enqueue(Deliver, { id: "42" }, { jobName: "saved-dynamic-name" });
await runtime.stop({ timeout: 10_000 });
```

同一キューでは名前一致 → そのキューの default の順に選択します。default は1件だけです。
handler の失敗は retry 方針に従い、default への切替は行いません。保存済み name/data/options
は維持します。結果は BullMQ の `returnvalue` に保存されます。enqueue の戻り値は引き続き
`{ jobId, name }` です。型定義は Redis に保存済みのデータを検証しません。

**manager を直接使う場合の移行:** `BullMQQueueManager.createWorker()` は停止状態の
Worker を作り、`workerOptions.autorun` を上書きします。全 Worker の作成後に
`await manager.startWorkers()` を呼び、全接続の準備完了を待って取得を開始してください。
`createWorker()` だけでは処理しません。`JobRuntime.start()` はこの手順を実行するため、
runtime 利用側から `startWorkers()` を呼ぶ必要はありません。

登録は idle 中に行います。重複 default、起動後の登録、停止中の新規操作は reject します。
`ready()` は default queue を準備し、`ready([])` は既存リソースだけを待ちます。
未対応 backend の readiness は `InvalidStateError` と `details.capability: "ready"` を返します。

producer-only は start せず ready / enqueue / stop を使います。stop は Worker がない場合も
管理 Queue を解放し、Worker がある場合は drain 後に Queue を閉じます。timeout は reject
後も cleanup を継続します。cleanup 失敗後は新 manager が必要です。借用 Redis client の
解放は呼出側の責任です。backend / scheduler が manager を共有すると寿命も共有するため、
producer と worker の寿命を分ける場合は manager も分けます。

manager の constructor 第2引数に `{ onError(event) { /* 利用側の方針 */ } }` を渡すと、
queue / worker の `error`、`cleanup`、`connection-ended` と worker の
`run-fulfilled` / `run-rejected` を監視できます。通常の error は診断であり、予期しない
接続・run 終了は利用側が異常停止を判断する材料です。process exit や再接続方針は利用側が
決めます。既存の worker hooks も維持しています。

[設計](docs/superpowers/specs/2026-11-09-mokuroku-queue-lifecycle-254-design.md)と
[成果物・#255 handoff](docs/handoffs/254.md)に検証状況と publish しない導入手順を記載しています。
