@AGENTS.md

## Claude Code 向け追加情報

### 作業時の確認事項

- コード変更後は必ず `pnpm typecheck` と `pnpm lint` を実行してください。
- BullMQ アダプターのテストは Docker（Redis TestContainers）が必要です。テスト実行前に Docker の起動を確認してください。
- コード変更を含む PR には必ず `pnpm changeset` でチェンジセットファイルを追加してください。詳細は `/add-changeset` スキルを参照してください。

### 詳細ドキュメントの参照方針

`.claude/docs/` 以下のドキュメントは常時読み込まれません。以下の状況で該当ドキュメントを参照してください。

| 状況 | 参照先 |
|------|--------|
| アーキテクチャや型定義を確認したいとき | `.claude/docs/architecture.md` |
| 開発環境のセットアップや規約を確認したいとき | `.claude/docs/development.md` |
| テストの書き方や実行方法を確認したいとき | `.claude/docs/testing.md` |
| リリース手順や Changesets の操作を確認したいとき | `.claude/docs/release.md` |
