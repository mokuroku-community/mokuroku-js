# リリースガイド

## 概要

本プロジェクトは **Changesets** を使用したセマンティックバージョニングでリリースを管理しています。CI が `develop` ブランチへのマージをトリガーとして、バージョニングと npm 公開を自動的に行います。

## Changesets の仕組み

1. **開発者**がコード変更と一緒にチェンジセットファイル（`.changeset/` 以下）を追加する。
2. **CI**（`release.yml`）が `develop` ブランチへのマージを検知し、Changesets Action を実行する。
3. Changesets Action が「Version Packages」PR を作成または更新する。
4. **メンテナー**が「Version Packages」PR をレビューし、マージする。
5. マージをトリガーに CI が各パッケージをビルドし、npm に公開する。

## チェンジセットの追加（開発者の作業）

コードに変更を加えた場合、PR に**チェンジセットファイルを必ず追加**してください。

```bash
pnpm changeset
```

対話形式で以下を入力します。

1. **変更するパッケージの選択**: スペースキーで選択し、Enter で確定。
2. **バージョンアップの種類**:
   - `patch`: バグ修正・内部改善（`0.x.Y` の Y を上げる）
   - `minor`: 後方互換性のある新機能追加（`0.X.y` の X を上げる）
   - `major`: 破壊的変更（`X.y.z` の X を上げる）
3. **変更の説明**: 1行で変更内容を記述する（CHANGELOG に掲載される）。

### どのバージョンを選ぶか

| 変更の種類 | バージョン |
|-----------|-----------|
| バグ修正、ドキュメント更新、リファクタリング | `patch` |
| 新しい公開 API の追加（既存 API に影響なし） | `minor` |
| 既存の公開 API の変更・削除 | `major` |

### 内部パッケージの扱い

`packages/bullmq` は `packages/core` に依存しています。`core` のバージョンが上がると、`bullmq` の依存バージョンも自動的に更新されます（`.changeset/config.json` の `updateInternalDependencies: "patch"` による）。

## チェンジセットが不要な変更

以下の変更にはチェンジセットは不要です。

- CI 設定の変更
- 開発用ドキュメントの更新（`AGENTS.md`、`CLAUDE.md` など）
- テストコードのみの変更（公開 API に影響しない場合）
- 依存関係の更新（Renovate が自動で管理）

## バージョニングと npm 公開（CI の自動処理）

リリースの CI ワークフロー（`.github/workflows/release.yml`）は以下を実行します。

1. ビルド・型チェック・テストを実行する。
2. Changesets Action を起動する。
   - チェンジセットファイルが存在する場合: 「Version Packages」PR を作成・更新する。
   - 「Version Packages」PR がマージされた場合: `package.json` のバージョンを更新し、npm に公開する。

npm の認証は npm OIDC（OpenID Connect）で行います。`NPM_TOKEN` などのシークレットは不要です。

## CHANGELOG の管理

各パッケージの `CHANGELOG.md` は Changesets が自動生成します。手動で編集しないでください。

## ローカルでのバージョン確認（参考）

```bash
# 現在のチェンジセットを確認
pnpm changeset status

# バージョンを手動で更新（CI が行うため通常は不要）
pnpm version-packages
```
