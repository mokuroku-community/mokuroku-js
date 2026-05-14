# mokuroku-js — LLMエージェント向けガイド

本ドキュメントはこのリポジトリで作業するLLMエージェントやコード生成ツール向けの基本ガイドです。詳細情報は末尾の「詳細ドキュメント」からオンデマンドで参照してください。

## プロジェクト概要

mokuroku-js は TypeScript 製の MQ 非依存バックグラウンドジョブ処理ライブラリです。コア抽象インターフェースとメッセージキュー固有のアダプターを分離するストラテジーパターンを採用しており、アプリケーションコードを特定の MQ ライブラリに依存させません。pnpm ワークスペース + Turbo を使用したモノリポ構成で、現在 BullMQ アダプターを提供しています。

- **リポジトリ**: https://github.com/mokuroku-community/mokuroku-js
- **ライセンス**: Apache-2.0
- **パッケージマネージャー**: pnpm 10.x

## パッケージ構成

| パッケージ | ディレクトリ | 説明 |
|-----------|-------------|------|
| `@mokurokujs/core` | `packages/core/` | コア抽象インターフェース・型定義 |
| `@mokurokujs/bullmq-adapter` | `packages/bullmq/` | BullMQ アダプター実装 |

## 主要コマンド

| コマンド | 説明 |
|---------|------|
| `pnpm build` | 全パッケージのビルド（Turbo） |
| `pnpm test` | 全パッケージのテスト実行 |
| `pnpm typecheck` | TypeScript 型チェック |
| `pnpm lint` | Biome による Lint チェック |
| `pnpm format:fix` | Biome によるコードフォーマット修正 |
| `pnpm changeset` | チェンジセット追加（コード変更を含む PR で必須） |

## アーキテクチャ概要

ストラテジーパターンにより、コア抽象とキュー実装を完全に分離します。

| コンセプト | 役割 |
|-----------|------|
| `JobDefinition<TPayload>` | ジョブの型・デフォルトオプションを定義する |
| `QueueDefinition` | ジョブとキュー名を紐付ける |
| `JobRuntime` | エンキュー・ハンドラー登録・ライフサイクル管理のファサード |
| `JobBackend` | MQ 実装を差し替えるコアインターフェース（ストラテジー） |
| `JobScheduler` | 繰り返しジョブのスケジューリングインターフェース |
| `BackendHooks` / `WorkerHooks` | バックエンド・ワーカーレベルのライフサイクルフック |

詳細は [.claude/docs/architecture.md](.claude/docs/architecture.md) を参照してください。

## コーディング規約

- **言語・モジュール形式**: TypeScript strict モード、ESModule（`"type": "module"`）
- **フォーマット**: Biome（インデント 2 スペース、行幅 120、ダブルクォート、末尾セミコロンあり）
- **コメント**: 英語・日本語バイリンガル JSDoc
- **ビルドツール**: tsup（ESM 出力、ソースマップ、ツリーシェイク有効）
- **依存方向**: `packages/core` → `packages/bullmq` の方向のみ許可（逆方向不可）

詳細は [.claude/docs/development.md](.claude/docs/development.md) を参照してください。

## テスト方針

- **フレームワーク**: Vitest
- **BullMQ アダプターのテスト**: Redis TestContainers を使用するため、Docker が起動していることが必須

詳細は [.claude/docs/testing.md](.claude/docs/testing.md) を参照してください。

## リリースフロー

Changesets を使用したセマンティックバージョニングです。**コード変更を含む PR には必ず `pnpm changeset` でチェンジセットファイルを追加してください。**

詳細は [.claude/docs/release.md](.claude/docs/release.md) を参照してください。

## 詳細ドキュメント（オンデマンド）

必要なときだけ参照することでコンテキスト消費を抑えます。

| ドキュメント | 内容 |
|------------|------|
| [.claude/docs/architecture.md](.claude/docs/architecture.md) | アーキテクチャ詳細・型定義・使用例・アダプター追加方法 |
| [.claude/docs/development.md](.claude/docs/development.md) | 開発環境構築・ワークフロー・コーディング規約詳細 |
| [.claude/docs/testing.md](.claude/docs/testing.md) | テスト設定・実行方法・テスト記述方針 |
| [.claude/docs/release.md](.claude/docs/release.md) | リリースプロセス・Changesets 運用・npm 公開フロー |
