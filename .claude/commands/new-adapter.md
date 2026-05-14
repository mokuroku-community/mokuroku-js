新しいメッセージキュー（MQ）アダプターパッケージを作成します。

## 手順

1. **パッケージディレクトリを作成する**

   `packages/<adapter-name>/` ディレクトリを作成し、`packages/bullmq/` の構成を参考にしてください。

2. **package.json を作成する**

   - `name`: `@mokurokujs/<adapter-name>` 形式
   - `@mokurokujs/core` をピア依存または直接依存として追加
   - `pnpm-workspace.yaml` の `catalog:` に共通バージョンを定義している場合は参照する

3. **`JobBackend` インターフェースを実装する**

   `packages/core/src/backend.ts` で定義されている `JobBackend` インターフェースを実装してください。
   実装が必要なメソッドは以下のとおりです。

   - `enqueue()` / `enqueueBulk()`
   - `registerHandler()`
   - `start()` / `stop()`
   - `pauseAll()` / `resumeAll()` / `pauseQueue()` / `resumeQueue()`

4. **（任意）`JobScheduler` インターフェースを実装する**

   繰り返しジョブをサポートする場合は、`packages/core/src/scheduler.ts` の `JobScheduler` インターフェースも実装してください。

5. **ビルド設定を追加する**

   `packages/bullmq/tsup.config.ts` と `packages/bullmq/vitest.config.ts` を参考に、新しいパッケージ用の設定ファイルを作成してください。

6. **tsconfig.json にパッケージを追加する**

   ルートの `tsconfig.json` の `references` に新しいパッケージを追加してください。

7. **テストを追加する**

   統合テストを `packages/<adapter-name>/src/` 以下に追加してください。外部リソースが必要な場合は TestContainers の使用を検討してください。

詳細なアーキテクチャ情報は `.claude/docs/architecture.md`、開発規約は `.claude/docs/development.md` を参照してください。
