# mokuroku queue lifecycle design

#254 は、既存 `handle()` の queue default、型付き結果、readiness、障害通知、解放契約を追加する。実移行は #255 に残す。

基準は library `51af573f5ffec3daf9723131ec3712e858508e19`。GitHub の develop も一致した。利用側は [マージ済み #256](https://github.com/tiramiss-community/tiramiss/pull/256) の head `d83306eccdb654d1524b272970200dd9787f69c0`。親 [#251](https://github.com/tiramiss-community/tiramiss/issues/251) の進捗表には古い記述が残るため、現在の PR 状態と実装を優先する。

## 実装根拠と採否

| 現在の実装 | 確定する変更 |
|---|---|
| [動的 name の保存](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L181)は実装済み。しかし[処理選択](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L278)も保存名に依存する | 保存名を維持し、queue default へ fallback できるようにする |
| [登録表](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L82)のキーは job name のみ | 登録と hooks を queue ごとに分離する |
| [handler 型](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/core/src/handler.ts#L48)は `Promise<void>`、[processor](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L297)は結果を捨てる | `TResult` を追加し、processor から返す |
| [Worker 起動](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/queue-manager.ts#L282)は readiness を待たず、run の reject だけ監視する | 接続完了を待ち、予期しない resolve/reject と接続終了を通知する |
| [idle 時の stop](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L315)は解放しない。[起動失敗](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L308)も rollback しない | producer-only と部分起動の両方を解放対象にする |
| [解放処理](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/queue-manager.ts#L327)は fail-fast | 全 Worker の終了を待ち、失敗しても全 Queue の解放を試す |
| [options 合成](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/src/backend.ts#L159)は `undefined` を渡す | 未指定項目を省略し、BullMQ の defaults を維持する |

提案の相違は次のように整理する。

- fallback は `handle(..., { defaultForQueue: true })`。`handleQueue()` と `routing` は追加しない。
- producer-only の解放には既存 `stop()` を使う。`close()` の別名は追加しない。
- 障害通知は接続を所有する manager に置く。core の `onFatal` は追加しない。
- backend 境界では結果型を `unknown` に消す。全 `JobBackend` 実装へ新しい結果型 generic を要求する案は採用しない。
- custom backoff、非再試行エラー、concurrency、limiter、metrics、prefix は既存の設定窓口を使う。新しい業務エラー体系を作らない。

## 公開 API

以下を確定案とする。既存フィールドは維持する。

```ts
interface JobDefinition<TPayload, TResult = void> {
  readonly name: string;
  readonly options: Readonly<JobOptions>;
  readonly __payloadType?: TPayload;
  readonly __resultType?: TResult;
}

function defineJob<TPayload, TResult = void>(
  name: string,
  options?: JobOptions,
): JobDefinition<TPayload, TResult>;

type JobHandler<TPayload, TResult = void> = (
  payload: TPayload,
  ctx: JobHandlerContext,
) => Promise<TResult>;

interface RegisterHandlerOptions {
  defaultForQueue?: boolean;
  hooks?: unknown;
  [key: string]: unknown;
}

interface JobLifecycleOptions {
  timeout?: number; // milliseconds
}
```

`JobRuntime` と具体クラス `BullmqBackend` の登録メソッドは、定義から payload/result 型を決める。

```ts
// JobRuntime.handle / BullmqBackend.registerHandler
handle<TPayload, TResult = void>(
  job: JobDefinition<TPayload, TResult>,
  handler: JobHandler<NoInfer<TPayload>, NoInfer<TResult>>,
  options?: RegisterHandlerOptions,
): void;

// JobRuntime
ready(
  queues?: readonly QueueDefinition[],
  options?: JobLifecycleOptions,
): Promise<void>;

start(options?: JobLifecycleOptions): Promise<void>;
stop(options?: JobLifecycleOptions): Promise<void>;
```

`JobBackend` は adapter 間の型消去境界とする。

```ts
interface JobBackend {
  enqueue<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    payload: TPayload,
    options?: EnqueueOptions,
  ): Promise<EnqueueResult>;

  enqueueBulk<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    items: BulkEnqueueItem<TPayload>[],
  ): Promise<EnqueueResult[]>;

  registerHandler<TPayload>(
    job: JobDefinition<TPayload, unknown>,
    handler: JobHandler<TPayload, unknown>,
    options?: RegisterHandlerOptions,
  ): void;

  ready?(
    queues?: readonly QueueDefinition[],
    options?: JobLifecycleOptions,
  ): Promise<void>;

  start(options?: JobLifecycleOptions): Promise<void>;
  stop(options?: JobLifecycleOptions): Promise<void>;

  // Existing pause/resume methods remain.
}
```

`JobRuntime.enqueue`／bulk は同じ結果非依存の定義を受け、payload 側を `NoInfer<TPayload>` にする。scheduler の正確な型は次とする。

```ts
// JobScheduler / SchedulerRuntime / BullmqJobScheduler
upsert<TPayload>(
  job: JobDefinition<TPayload, unknown>,
  options: JobScheduleOptions<NoInfer<TPayload>>,
): Promise<void>;

remove<TPayload>(
  job: JobDefinition<TPayload, unknown>,
): Promise<void>;
```

`EnqueueResult` は `{ jobId: string; name: string }` のまま。結果取得 API は増やさない。型は Redis 内の payload を検証しないため、保存済みデータの validation は利用側 adapter が所有する。

manager の追加 API は次とする。

```ts
type BullmqManagerError =
  | {
      queue: string;
      resource: "queue" | "worker";
      reason: "error" | "cleanup";
      error: Error;
    }
  | {
      queue: string;
      resource: "queue" | "worker";
      reason: "connection-ended";
      connection: "command" | "blocking";
      error: Error;
    }
  | {
      queue: string;
      resource: "worker";
      reason: "run-fulfilled" | "run-rejected";
      error: Error;
    };

interface BullmqQueueManagerOptions {
  logger?: JobLogger;
  onError?: (event: BullmqManagerError) => void;
}

// Existing first argument remains.
constructor(
  connection: ConnectionOptions | BullMQConnectionDefinition,
  options?: BullmqQueueManagerOptions,
);

ready(
  queues?: readonly QueueDefinition[],
  options?: JobLifecycleOptions,
): Promise<void>;
```

既存 `onWorkerError` は維持する。一般の `error` は診断、`connection-ended` と予期しない run 終了は利用側が異常停止を判断する材料である。通知 callback の例外は捕捉・記録し、接続監視や cleanup を中断させない。

## routing・結果・options

- named 登録は `(queue.name, job.name)` ごと。`defaultForQueue: true` は同じ登録をその queue の fallback にもする。
- 選択順は **同じ queue の名前一致 → 同じ queue の default → `HandlerNotRegisteredError`**。handler の失敗時には fallback へ切り替えない。
- default は queue ごとに1件。同じ job name の再登録は置換できる。別名を default にしようとした場合は `InvalidStateError`。
- 再登録は hooks も置換する。hooks を省略した再登録で古い hooks を残さない。登録変更は idle 時だけ受け付ける。
- handler と job hooks は同じ選択結果に従う。保存済み name/data/options と `ctx.jobName` は変更しない。
- processor は `return await handler(...)`。string/object を BullMQ の `returnvalue` に保存し、void の保存表現は BullMQ に従う。
- options の優先順位は enqueue override → job defaults → Queue defaults。`undefined` は省略し、`false`・`0` は維持する。既存 bulk／jobId の挙動も維持する。
- attempt は実行開始時の値を保持し、成功時の `+1` 誤差を防ぐ。
- retry hooks は attempts 残数だけで判断しない。両検証版で `moveToFailed()` が terminal 時に設定する `job.finishedOn` を使い、実際の遷移後に分類する。backoff 関数の再実行や、競合し得る非同期 `getState()` による判定はしない。

## readiness・障害・停止

`runtime.ready()` は default Queue を、`ready([queue])` は指定 Queue を作成し、既存管理リソースを含めて接続を待つ。Worker は作らない。`ready([])` は既存リソースだけを待つ。未対応 backend では `InvalidStateError` と `details.capability: "ready"` を返す。

`start()` は handler の queue と既存 Queue、および全 Worker の command/blocking 接続を準備する。全 Worker を `autorun: false` で作り、接続確認後に取得を開始する。設定による `autorun: true` の上書きは許さない。

監視は接続待ちの前から設置する。取得した client に listener を付けた後で `status === "end"` も検査し、起動世代ごとの失敗を latch する。先に ready になった接続の終了や即時 run 終了が、後続の成功によって消えないようにする。

BullMQ 5/6 の接続取得差は内部 helper に閉じ込める。run 監視は内部 `ManagedWorker` の override で各呼び出しを観測し、BullMQ 6 の `resume()` が開始する run も対象にする。

- close とローカル pause に伴う予定された run fulfillment は異常通知しない。
- pause に伴う blocking 接続の意図的な中断だけを区別する。paused 全体で接続監視を止めない。
- resume は必要接続を再確認する。queue 全体の `Queue.pause()` とローカル Worker pause は別操作として扱う。
- 再接続設定と process exit は利用側が決める。ライブラリは独自の再起動ループを追加しない。

停止と競合の契約は次とする。

| 条件 | 結果 |
|---|---|
| producer-only `stop()` | 管理 Queue を解放する |
| 同時 start／同時 stop | 進行中操作の完了結果を共有する |
| start 中の stop | 起動世代を取消扱いにし、遅延した接続成功で Worker を開始しない。start は reject、stop は回収を待つ |
| stop 中の start／enqueue／新規リソース作成 | `InvalidStateError` |
| 部分起動失敗 | 作成済みリソースを回収する。cleanup 失敗もあれば元エラーを `cause` に持つ `AggregateError` |
| 通常停止 | 全 Worker の完了を待ち、その後に全 Queue の close を試す |
| 複数解放失敗 | 全解放の settlement を待ち、集約して reject |
| timeout | 操作全体の期限として reject。cleanup は監視下で継続し、解放済みとは扱わない |

timeout は有限の非負数。`0` は即時期限、負数・NaN・Infinity は副作用前に reject する。同時操作では最初の呼び出しの期限を使う。

BullMQ は close 中の内部エラーを `error` イベントへ流して resolve することがあるため、cleanup 中の error も収集する。close の失敗が残った manager は再利用不可とし、新 manager を必要とする。成功した stop 後の再起動は維持する。

外部 Redis client は借用物であり、quit/disconnect しない。adapter が作った接続と Worker の複製接続を解放し、追加 listener を除去する。同一 manager を共有する backend／scheduler は同じ寿命を持つ。producer と worker の寿命を分ける場合は manager も分ける。

## 互換性・配布

従来の void 呼び出し、constructor 第1引数、enqueue options、pause/resume は維持する。旧 `JobBackend` は型消去境界により構造互換を維持できるが、新機能の実行保証は adapter の対応が必要である。

一方、次は変更として明記する。

- 公開宣言の `NoInfer` により **TypeScript 5.4 以上**を要求する。
- 起動後の登録変更、重複 default、停止中の新規操作を拒否する。
- producer-only stop が実際に接続を解放する。
- timeout／cleanup 失敗を正常終了として扱わない。

完全後方互換とは表現しない。[release 規約](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/.claude/docs/release.md)に従い、両 package を **major Changeset** に含める。今回は version 適用・merge・release・publish は行わない。

BullMQ peer は実検証後に `^5.16.0 || ^6.3.11`。adapter の core 依存は古い `workspace:>=0.1.0` から `workspace:^` に変え、将来の通常 pack で対応 core 世代へ追従させる。

PR 用成果物は別 staging directory で両 package を `0.0.0-prep.g<FULL_SHA>` とし、adapter の core 依存を同じ版へ固定する。利用側は両 tarball を取得し、pnpm override で transitive core も同じ tarball に固定する。peer 条件は強制無視しない。

