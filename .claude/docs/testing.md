# テストガイド

## テストフレームワーク

- **Vitest** 4.x（全パッケージ共通）
- テストファイルは各パッケージの `src/` 以下に `*.test.ts` として配置する。

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

BullMQ アダプターのテストセットアップは `packages/bullmq/src/global-setup.ts` に定義されています。`vitest.config.ts` の `globalSetup` で読み込まれます。

## テストの書き方

### 基本方針

- 各テストは独立して実行できるようにする（テスト間の依存を持たせない）。
- アサーションには Vitest の `expect` を使用する。
- 副作用を伴うリソース（DB、外部サービスなど）はテスト後に必ずクリーンアップする。

### @mokurokujs/core のテスト

コア抽象は外部依存が少ないため、ユニットテストが中心です。`QueueBuilder` のテストを参考にしてください。

```typescript
// 例: packages/core/src/queue-builder.test.ts
import { describe, expect, it } from "vitest";
import { defineJob } from "./job.js";
import { defineQueue } from "./queue.js";

describe("QueueBuilder", () => {
  it("キューにジョブを追加できる", () => {
    const job = defineJob<{ message: string }>("test-job");
    const queue = defineQueue("test-queue").addJob(job).build();

    expect(queue.name).toBe("test-queue");
  });
});
```

### @mokurokujs/bullmq-adapter のテスト

Redis TestContainers を使用した統合テストが中心です。実際の BullMQ / Redis に対してテストを行います。

```typescript
// 例: packages/bullmq/src/backend.test.ts（概略）
import { describe, expect, it } from "vitest";
import { defineJob } from "@mokurokujs/core";
import { BullmqBackend } from "./backend.js";

describe("BullmqBackend", () => {
  it("ジョブをエンキューできる", async () => {
    // TestContainers で起動した Redis に接続
    const backend = new BullmqBackend({ connection: redisConnection });
    const job = defineJob<{ value: number }>("test");

    const result = await backend.enqueue(job, { value: 42 });

    expect(result.jobId).toBeDefined();
    expect(result.name).toBe("test");
  });
});
```

## CI でのテスト

CI では以下のテストが実行されます（`.github/workflows/ci.yml` 参照）。

| ジョブ | 内容 |
|--------|------|
| `test` | ビルド・型チェック・全テスト |
| `bullmq-compat` | BullMQ `^5.0.0` 系の各バージョンに対する互換性テスト（マトリックステスト） |
| `lint` | Biome による Lint チェック |
