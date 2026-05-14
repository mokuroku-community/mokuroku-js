# アーキテクチャ詳細

## 設計方針

mokuroku-js はストラテジーパターンを採用し、ジョブキューの抽象定義とメッセージキュー固有の実装を完全に分離します。アプリケーションコードはコア抽象のみに依存し、特定の MQ ライブラリに依存しません。これにより、MQ の乗り換えや複数 MQ の併用が容易になります。

## コアパッケージ（@mokurokujs/core）

### 主要な型・インターフェース

#### `JobDefinition<TPayload>`

ジョブの名前とデフォルトオプションを保持する型です。`defineJob()` ファクトリ関数で生成します。`TPayload` はジョブのペイロード型で、ランタイムでは使用されず型情報の保持のみに利用します。

```typescript
const emailJob = defineJob<{ to: string; subject: string }>("email", {
  attempts: 3,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: true,
});
```

#### `JobOptions`

`JobDefinition` に付与できる MQ 非依存のオプションです。バックエンドが未対応の項目は無視されます。

| フィールド | 型 | 説明 |
|-----------|------|------|
| `attempts` | `number` | 最大試行回数（初回を含む） |
| `backoff` | `JobBackoff` | リトライ間隔のバックオフ戦略 |
| `priority` | `number` | 優先度（バックエンドが対応している場合のみ有効） |
| `removeOnComplete` | `JobRemovePolicy` | 成功時の保持・削除ポリシー |
| `removeOnFail` | `JobRemovePolicy` | 失敗時の保持・削除ポリシー |

#### `JobBackoff`

リトライのバックオフ戦略を表すユニオン型です。

```typescript
type JobBackoff =
  | { type: "fixed"; delay: number }
  | { type: "exponential"; delay: number }
  | { type: "custom" };
```

`custom` はアダプター側で独自に解釈・実装します。

#### `JobRemovePolicy`

```typescript
type JobRemovePolicy = boolean | number | { age?: number; count?: number };
```

- `true`: 即時削除
- `false`: 保持（バックエンドのデフォルト動作）
- `number`: 件数上限を超えたら古いものから削除
- `{ age, count }`: `age` 秒経過、または `count` 件超で削除

#### `QueueDefinition`

1 つ以上の `JobDefinition` を持つキューを定義します。`defineQueue()` または `QueueBuilder` で生成します。

```typescript
const notificationQueue = defineQueue("notification")
  .addJob(emailJob)
  .addJob(smsJob)
  .build();
```

#### `JobRuntime`

アプリケーションのエントリーポイントとなるファサードクラスです。`JobBackend` を注入して生成します。

```typescript
const runtime = new JobRuntime(new BullmqBackend({ connection: redisConnection }));

// ハンドラー登録（start() の前に行うこと）
runtime.handle(emailJob, async (ctx) => {
  await sendEmail(ctx.payload);
});

await runtime.start();

// エンキュー
await runtime.enqueue(emailJob, { to: "user@example.com", subject: "Hello" });

// バルクエンキュー
await runtime.enqueueBulk(emailJob, [
  { payload: { to: "a@example.com", subject: "A" } },
  { payload: { to: "b@example.com", subject: "B" }, options: { delay: 5000 } },
]);

// ライフサイクル制御
await runtime.pauseAll();
await runtime.resumeAll();
await runtime.stop({ timeout: 5000 });
```

#### `EnqueueOptions`

`enqueue()` 時に `JobDefinition` のデフォルト値を上書きするオプションです。

| フィールド | 説明 |
|-----------|------|
| `attempts` | 試行回数の上書き |
| `backoff` | バックオフ戦略の上書き |
| `removeOnComplete` | 成功時ポリシーの上書き |
| `removeOnFail` | 失敗時ポリシーの上書き |
| `jobName` | エンキュー時のジョブ名上書き（同じハンドラーで別名ジョブを作る場合） |
| `delay` | 遅延実行（ミリ秒） |

#### `JobBackend`

MQ 実装を差し替えるためのコアインターフェースです。新しいアダプターはこのインターフェースを実装します。

```typescript
interface JobBackend {
  enqueue<TPayload>(job, payload, options?): Promise<EnqueueResult>;
  enqueueBulk<TPayload>(job, items): Promise<EnqueueResult[]>;
  registerHandler<TPayload>(job, handler, options?): void;
  start(): Promise<void>;
  stop(options?): Promise<void>;
  pauseAll(): Promise<void>;
  resumeAll(): Promise<void>;
  pauseQueue(queue): Promise<void>;
  resumeQueue(queue): Promise<void>;
}
```

#### `JobScheduler`

繰り返しジョブのスケジューリングインターフェースです。アダプターが実装します（必須ではありません）。

### フックシステム

3 階層のフックシステムにより、バックエンド・キュー・ジョブレベルでライフサイクルを制御できます。

```
BackendHooks（バックエンド全体）
  ├─ onEnqueue   — ジョブがエンキューされたとき
  ├─ onStart     — ジョブの処理を開始したとき
  ├─ onSuccess   — ジョブが成功したとき
  ├─ onRetry     — ジョブが失敗し、リトライが残っているとき
  ├─ onFailure   — ジョブがリトライを使い切って失敗したとき
  └─ onWorkerError — Worker 自体の例外（Redis 接続エラー等）
```

`WorkerHooks` は `onEnqueue` を除いた `BackendHooks` のサブセットです。アダプターによって、これらのフックをバックエンド・キュー・ジョブの各レベルで設定できます。

### ファイル構成

| ファイル | 説明 |
|---------|------|
| `job.ts` | `JobDefinition`, `JobBackoff`, `JobRemovePolicy`, `JobOptions`, `defineJob()` |
| `queue.ts` | `QueueDefinition`, `QueueBuilder`, `defineQueue()` |
| `backend.ts` | `JobBackend` インターフェース, `EnqueueResult`, `EnqueueOptions`, `BulkEnqueueItem` |
| `runtime.ts` | `JobRuntime` クラス（メインファサード） |
| `handler.ts` | `JobHandler`, `JobHandlerContext` 型 |
| `hooks.ts` | `WorkerHooks`, `BackendHooks` インターフェース |
| `errors.ts` | カスタムエラー型 |
| `scheduler.ts` | `JobScheduler` インターフェース |
| `scheduler-runtime.ts` | `SchedulerRuntime` クラス |

## BullMQ アダプター（@mokurokujs/bullmq-adapter）

BullMQ の `Queue` / `Worker` を `JobBackend` インターフェースにマッピングします。

### 依存関係

- **ピア依存**: `bullmq ^5.0.0`
- **直接依存**: `@mokurokujs/core`, `zod ^4.0.0`

### ファイル構成

| ファイル | 説明 |
|---------|------|
| `backend.ts` | `BullmqBackend`（`JobBackend` の BullMQ 実装） |
| `queue-manager.ts` | `BullMQQueueManager`（Queue / Worker ライフサイクル管理） |
| `scheduler.ts` | `BullmqScheduler`（cron パターンによる繰り返しジョブ） |
| `helper.ts` | ユーティリティヘルパー |
| `types.ts` | `BullmqQueueDefinition` および関連型 |
| `errors.ts` | BullMQ 固有エラー型 |

## 新しいアダプターの追加手順

1. `packages/` 以下に新しいパッケージディレクトリを作成する。
2. `package.json` を作成し、`@mokurokujs/core` をピア依存または直接依存として追加する。
3. `JobBackend` インターフェース（`packages/core/src/backend.ts`）を実装する。
4. 必要に応じて `JobScheduler` インターフェース（`packages/core/src/scheduler.ts`）を実装する。
5. `packages/bullmq/` を参考に `tsup.config.ts` と `vitest.config.ts` を作成する。
6. `tsconfig.json`（ルート）の `references` に新しいパッケージを追加する。
