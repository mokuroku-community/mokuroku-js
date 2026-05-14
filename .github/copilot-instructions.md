# GitHub Copilot 向けガイド

> **詳細な情報は [AGENTS.md](../AGENTS.md) を参照してください。** 本ファイルは GitHub Copilot 向けの簡易ガイドです。

## プロジェクト概要

mokuroku-js は TypeScript 製の MQ 非依存バックグラウンドジョブ処理ライブラリです。コア抽象インターフェースとメッセージキュー固有のアダプターを分離するストラテジーパターンを採用しています。pnpm ワークスペース + Turbo を使用したモノリポ構成で、現在 BullMQ アダプターを提供しています。

## パッケージ構成

| パッケージ | ディレクトリ | 説明 |
|-----------|-------------|------|
| `@mokurokujs/core` | `packages/core/` | コア抽象インターフェース・型定義 |
| `@mokurokujs/bullmq-adapter` | `packages/bullmq/` | BullMQ アダプター実装 |

## 重要なルール

- TypeScript strict モードおよび ESModule を使用すること。
- Biome でフォーマット・Lint を行うこと（インデント 2 スペース、行幅 120、ダブルクォート、末尾セミコロンあり）。
- コード変更を含む PR には必ず `pnpm changeset` でチェンジセットファイルを追加すること。
- BullMQ テストは Docker（Redis TestContainers）が必要なため、テスト実行前に Docker の起動を確認すること。
- コア抽象（`@mokurokujs/core`）と MQ 実装（アダプター）を混在させないこと。依存方向は `core → bullmq` の一方向のみ。
- コメントは英語・日本語バイリンガル JSDoc で記述すること。

## 主要コマンド

| コマンド | 説明 |
|---------|------|
| `pnpm build` | 全パッケージのビルド |
| `pnpm test` | 全パッケージのテスト実行 |
| `pnpm typecheck` | 型チェック |
| `pnpm lint` | Lint チェック |
| `pnpm format:fix` | コードフォーマット修正 |
| `pnpm changeset` | チェンジセット追加 |
