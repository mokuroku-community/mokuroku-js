# 開発ガイド

## 前提条件

- **Node.js**: 推奨バージョンは `package.json` の `engines` フィールドを参照してください。
- **pnpm**: 10.x（`package.json` の `packageManager` フィールドで指定）
- **Docker**: BullMQ アダプターのテストに Redis TestContainers を使用するため必要

## 環境セットアップ

```bash
# リポジトリのクローン
git clone https://github.com/mokuroku-community/mokuroku-js.git
cd mokuroku-js

# 依存関係のインストール
pnpm install

# ビルド（全パッケージ）
pnpm build
```

## 開発ワークフロー

### 日常的な作業フロー

```bash
# 型チェック
pnpm typecheck

# Lint チェック
pnpm lint

# フォーマット修正
pnpm format:fix

# テスト実行
pnpm test
```

### 変更後のチェックリスト

1. `pnpm typecheck` — 型エラーがないことを確認
2. `pnpm lint` — Lint エラーがないことを確認
3. `pnpm test` — テストがすべて通ることを確認（Docker 起動が必要）
4. `pnpm changeset` — チェンジセットファイルを追加（コード変更を含む場合は必須）

## モノリポ構成

Turbo を使用してパッケージ間の依存関係を管理しています。ルートから実行するコマンドはすべてのパッケージに対して順序どおりに実行されます。

```
mokuroku-js（ルート）
├── packages/core         @mokurokujs/core
└── packages/bullmq       @mokurokujs/bullmq-adapter（core に依存）
```

**依存の方向は `core → bullmq` の一方向のみです。** `packages/core` が `packages/bullmq` に依存することは禁止です。

### Turbo タスク定義（turbo.json）

| タスク | 依存 | キャッシュ |
|--------|------|-----------|
| `build` | `^build`（依存パッケージを先にビルド） | `dist/**` |
| `typecheck` | `^typecheck` | あり |
| `test` | `^test` | なし |
| `lint` | `^lint` | あり |
| `clean` | なし | なし |

## コーディング規約

### TypeScript

- `strict: true`（すべての strict オプションが有効）
- `moduleResolution: "bundler"`（tsup でのバンドル向け設定）
- `composite: true`（プロジェクトリファレンスによる増分ビルド）
- 型アサション（`as`）は必要最小限にとどめること

### Biome 設定

設定ファイル: `biome.jsonc`（ルート）

| 設定項目 | 値 |
|---------|-----|
| インデント | スペース 2 つ |
| 行幅 | 120 文字 |
| クォート | ダブルクォート |
| セミコロン | 常にあり |
| 末尾カンマ | あり |
| インポート整理 | 自動（packages → paths → その他 → 型定義） |

VS Code では保存時に自動フォーマットが実行されます（`.vscode/settings.json` で設定済み）。

### コメント規約

すべての公開 API には英語・日本語バイリンガルの JSDoc コメントを記述してください。

```typescript
/**
 * English description here.
 *
 * 日本語の説明をここに記述します。
 */
export function example(): void {
  // ...
}
```

### インポート規約

- 同一パッケージ内のファイルは `.js` 拡張子付きで相対インポートする（ESM 互換）。
- 型専用のインポートは `import type` を使用する。

```typescript
import type { JobDefinition } from "./job.js";
import { defineJob } from "./job.js";
```

## ビルド設定

各パッケージは `tsup` を使用して ESM 形式でビルドします。

```typescript
// tsup.config.ts（各パッケージ共通の設定例）
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  treeshake: true,
});
```

ビルド成果物は各パッケージの `dist/` ディレクトリに出力されます。

## ブランチ戦略

| ブランチ | 用途 |
|---------|------|
| `main` | 安定リリース済みのコード |
| `develop` | 開発ベースブランチ（PR のマージ先） |
| `feature/*` など | 機能追加・バグ修正のトピックブランチ |

リリースは `develop` ブランチへのマージをトリガーに CI が自動的に行います。詳細は [.claude/docs/release.md](.claude/docs/release.md) を参照してください。
