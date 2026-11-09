# テストガイド

## テストフレームワーク

- **Vitest** 4.x（全パッケージ共通）
- テストファイルは各パッケージの `test/` 以下に `*.test.ts` として配置する。

## テストの実行

```bash
# 全パッケージのテストを実行
pnpm test

# 特定パッケージのテストのみ実行
pnpm --filter @mokurokujs/core test
pnpm --filter @mokurokujs/bullmq-adapter test

# ウォッチモード（開発中に便利）
pnpm --filter @mokurokujs/core exec vitest --watch
```

## BullMQ アダプターのテスト

`@mokurokujs/bullmq-adapter` のテストは **Redis TestContainers** を使用します。実行前に **Docker が起動していること**を確認してください。

テスト実行時に Docker が自動的に Redis コンテナを起動・停止するため、ローカルに Redis をインストールする必要はありません。

```bash
# Docker が起動していることを確認
docker ps

# テスト実行（Docker 起動済みの状態で）
pnpm --filter @mokurokujs/bullmq-adapter test
```

### テストのセットアップ

BullMQ アダプターのテストセットアップは `packages/bullmq/test/global-setup.ts` に定義されています。`vitest.config.ts` の `globalSetup` で読み込まれます。

## テストの書き方

### 基本方針

- 各テストは独立して実行できるようにする（テスト間の依存を持たせない）。
- アサーションには Vitest の `expect` を使用する。
- 副作用を伴うリソース（DB、外部サービスなど）はテスト後に必ずクリーンアップする。

### @mokurokujs/core のテスト

コア抽象は外部依存が少ないため、ユニットテストが中心です。`QueueBuilder` のテストを参考にしてください。

```typescript
// 例: packages/core/test/queue-builder.test.ts
import { describe, expect, it } from "vitest";
import { defineJob } from "../src/job.js";
import { defineQueue } from "../src/queue.js";

describe("QueueBuilder", () => {
  it("ジョブをキューへ紐付けられる", () => {
    const queue = defineQueue("test-queue").build();

    const job = defineJob<{ message: string }>("test-job", { queue });
    expect(job.options.queue).toBe(queue);
  });
});
```

### @mokurokujs/bullmq-adapter のテスト

Redis TestContainers を使用した統合テストが中心です。実際の BullMQ / Redis に対してテストを行います。

```typescript
// 例: packages/bullmq/test/backend.test.ts（概略）
import { describe, expect, it } from "vitest";
import { defineJob } from "@mokurokujs/core";
import { BullMQQueueManager } from "../src/queue-manager.js";
import { BullmqBackend } from "../src/backend.js";

describe("BullmqBackend", () => {
  it("ジョブをエンキューできる", async () => {
    // TestContainers で起動した Redis に接続
    const queueManager = new BullMQQueueManager(redisConnection);
    const backend = new BullmqBackend({ queueManager });
    const job = defineJob<{ value: number }>("test");

    const result = await backend.enqueue(job, { value: 42 });

    expect(result.jobId).toBeDefined();
    expect(result.name).toBe("test");
    await backend.stop();
  });
});
```

## CI でのテスト

CI では以下のテストが実行されます（`.github/workflows/ci.yml` 参照）。

| ジョブ | 内容 |
|--------|------|
| `test` | ビルド・型チェック・全テスト |
| `bullmq-compat` | BullMQ `5.16.0` / `6.3.11` と各 major 最新版に対する互換性テスト（マトリックステスト） |
| `lint` | Biome による Lint チェック |

## Packed consumer

`pnpm pack:prep <workspace 外の空 directory>` は fresh build 後に両 package を staging
だけで版付けして pack します。`pnpm verify:packed <同 directory>` は workspace 外で
BullMQ 5.16.0 / 6.3.11、TypeScript 5.4.5、明示 ioredis 5.11.1、strict peers の consumer を作り、公開宣言と
Redis 保存ジョブを検証します。Docker 必須。明示した使い捨てテスト Redis に限り
`PACK_TEST_REDIS_URL=redis://...` を指定できます。通常の利用者 Redis は使いません。
CI は `REQUIRE_REDIS_TESTS=1` で skip を失敗扱いにし、pack consumer も別 job で実行します。
取得方法・未完了検証は [handoff](../../docs/handoffs/254.md) を参照。
