# mokuroku Queue Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #255 が固定成果物を使って既存3 queue の移行を検証できる、汎用 API と BullMQ adapter を用意する。

**Architecture:** core は型・routing option・readiness 窓口を定義する。BullMQ adapter が routing、接続監視、取得ループ、解放を所有する。

**Tech Stack:** TypeScript ≥5.4、pnpm 10、Vitest、実 Redis 7.2、BullMQ 5.16.0／6.3.11。

**Spec:** ../specs/2026-11-09-mokuroku-queue-lifecycle-254-design.md

**共通制約:** 作業先は専用 clone のみ。元 library と consumer は読み取り専用。Misskey の payload・prefix・保持値・業務判断を library に入れない。公開 JSDoc は英日併記。

**重点確認:** 型推論による誤型の受理、起動取消後の遅延成功、pause/resume 後の監視欠落、cleanup が resolve した際の内部エラー、古い transitive core の混入。以下のテストでそれぞれ固定する。

## Task 1 — core の型・routing・lifecycle 契約

**変更:** `packages/core/src/{job,handler,backend,runtime,scheduler,scheduler-runtime}.ts`、`packages/core/package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`。

**追加:** `packages/core/test/types/result-types.ts`、`legacy-backend.ts`、`packages/core/tsconfig.type-tests.json`。既存 `test/runtime.test.ts` も更新する。

**出力:** DESIGN の core signatures。adapter は次タスクでこれを実装する。

- [ ] 型 fixture と runtime 委譲テストを先に書く。型 fixture は専用 `tsc --noEmit` 対象へ接続する。現在の [通常 tsconfig](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/core/tsconfig.json#L8)は `src` しか検査しないため、Vitest の実行だけで型検査済みとしない。

```ts
const job = defineJob<{ id: string }, string>("work");
runtime.handle(job, async payload => payload.id);
runtime.handle(job, async payload => payload.id, {
  defaultForQueue: true,
});

// @ts-expect-error: wrong result
runtime.handle(job, async () => 1);
// @ts-expect-error: missing result
runtime.handle(job, async () => {});
// @ts-expect-error: wrong handler payload
runtime.handle(job, async (payload: { id: number }) => String(payload.id));
// @ts-expect-error: wrong enqueue payload
runtime.enqueue(job, { id: 1 });

runtime.enqueue(job, { id: "a" });
runtime.enqueueBulk(job, [{ payload: { id: "a" } }]);
scheduler.upsert(job, { pattern: "* * * * *", payload: { id: "a" } });
scheduler.remove(job);
runtime.handle(defineJob<{ id: string }>("legacy"), async () => {});
```

- [ ] wrong bulk payload、wrong schedule payload、object/union result、明示 generic の従来呼び出しも正負で検査する。旧 `RecordingBackend` の署名を維持した fixture を新 `JobBackend` に代入して検査する。
- [ ] `ready` の引数・結果の委譲と、optional method 不在時の明示 reject を検査する。
- [ ] `pnpm --filter @mokurokujs/core exec tsc -p tsconfig.type-tests.json --noEmit` を実行し、新 API／正の fixture が現行コードでは失敗することを記録する。
- [ ] DESIGN の最小実装を行い、package の `typecheck` に型 fixture を組み込む。TypeScript catalog の下限を 5.4 にする。
- [ ] `pnpm --filter @mokurokujs/core typecheck` と `pnpm --filter @mokurokujs/core test` を実行する。期待値は型エラー0・テスト成功。最低版 TypeScript 5.4.5 でも公開型 fixture を検査する。

## Task 2 — adapter 実装、実 Redis、互換 CI

**変更:** `packages/bullmq/src/{backend,queue-manager,scheduler,types}.ts`、package manifest、既存テスト、global setup、`.github/workflows/ci.yml`、lockfile。

**追加:** 内部責務を `src/managed-worker.ts` と `src/connection-monitor.ts` に分ける。テストは `test/{routing,lifecycle,options}.test.ts` と `test/types/contracts.ts`。

**入力:** Task 1 の契約。  
**出力:** queue default、結果保存、bounded startup、障害通知、全リソース解放、5/6 互換性。

- [ ] 次の失敗テストを先に追加し、現行 adapter で該当 assertion が失敗することを確認する。

| テスト群 | 必須 assertion |
|---|---|
| routing | raw Queue で任意名を保存し producer を閉じてから消費。named 優先、default、未登録、別 queue 同名、default 衝突、再登録 hooks の消去、handler 例外時に fallback しない |
| 結果・保存互換 | 独立した raw Queue から string/object/void の returnvalue、name/id/data/options を確認。single/bulk 両方 |
| options・retry | defaults の継承、明示 `false`／`0`、delay、jobId、保持、prefix、concurrency、limiter、metrics。通常 retry、custom backoff の引数と実遅延、`0`、`-1`、UnrecoverableError、元エラー、hook 分類と attempt |
| startup | Queue／Worker command／blocking の個別 ready 待機、既に end、接続拒否、TCP 接続後無応答、先行 ready 接続の喪失、2個目・3個目の起動失敗 |
| loop・接続 | run resolve/reject、正常 close、ローカル pause/resume 後の監視、paused 中の command 接続喪失、再開時 readiness |
| cleanup・競合 | producer-only stop、handler gate を待つ drain、複数 close 失敗＋遅い close、error を emit して resolve する close、借用 client の存続、listener 除去 |
| 期限・取消 | 同時 start/stop、start 中 stop、timeout 後の遅延 ready、再起動、Queue close 中の期限超過、timeout 後の cleanup 継続、無効な timeout |

- [ ] 接続断は専用 Redis の `CLIENT KILL` で producer／Worker command／blocking を個別に起こす。run の resolve/reject や close 失敗は、実 Worker／Redis 上の対象メソッドだけに制御した fault injection を加える。fake だけの成功を実接続保証に数えない。
- [ ] DESIGN を実装する。routing と hooks は同じ登録記録を選択する。constructor の接続判別を明確化し、Queue／Worker の共通する先頭3型引数を明示する。広い `any` で BullMQ 6 の型エラーを隠さない。
- [ ] Redis 必須モード `REQUIRE_REDIS_TESTS=1` を追加する。このモードでは Docker 不在、`SKIP_REDIS_TESTS=1`、全 skip を失敗にする。[現在の自動 skip](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/test/global-setup.ts#L18)を CI の成功条件にしない。
- [ ] CI matrix を exact `5.16.0`、exact `6.3.11`、各 major の範囲内最新にする。各 job で解決版を出力し、fresh build・typecheck・型 fixture・実 Redis テストを実行する。
- [ ] 次を成功条件とする。

```sh
pnpm build
pnpm typecheck
pnpm lint
REQUIRE_REDIS_TESTS=1 pnpm --filter @mokurokujs/bullmq-adapter test
```

全 matrix で失敗0、必須 suite の skip 0。通過後に peer を `^5.16.0 || ^6.3.11` へ拡張する。

## Task 3 — docs、pack 検証、#255 handoff

**変更:** 両 README、AGENTS の依存方向表記、関連 `.claude/docs`、両 package の Changeset、adapter の core 依存。

**追加:** `scripts/verify-packed-consumer.mjs`、`scripts/pack-preparation.mjs`、`docs/handoffs/254.md`、CI の artifact 手順。

**入力:** Task 2 の検証済み API。  
**出力:** 取得可能な固定 tarball、検証 manifest、採用手順、残責任。

- [ ] pack consumer 検証を先に作る。workspace 外の空 directory に tarball だけで導入し、root と adapter から解決した core の realpath／version が一致することを assertion にする。古い core を検出した場合は失敗させる。
- [ ] `pnpm pack` で両 package を staging directory に生成する。staging だけに一意な prerelease version と exact core 依存を設定し、追跡 manifest の version は変更しない。
- [ ] consumer 側では両 tarball を `vendor/` に置き、次の固定を使う。strict peer 条件を有効にして install する。

```json
{
  "dependencies": {
    "@mokurokujs/core": "file:./vendor/core.tgz",
    "@mokurokujs/bullmq-adapter": "file:./vendor/adapter.tgz",
    "bullmq": "6.3.11"
  },
  "pnpm": {
    "overrides": {
      "@mokurokujs/core": "file:./vendor/core.tgz"
    }
  }
}
```

- [ ] BullMQ 5.16.0／6.3.11 の別 consumer で、ESM root import、公開 `.d.ts`、正負の型 fixture、ready→保存ジョブ消費→returnvalue→stop を実 Redis で確認する。workspace symlink、source paths、peer 無視に依存しないことを検査する。
- [ ] README の package 名を実際の [`@mokurokujs/bullmq-adapter`](https://github.com/mokuroku-community/mokuroku-js/blob/51af573f5ffec3daf9723131ec3712e858508e19/packages/bullmq/package.json#L2)へ統一する。存在しない `addJob()`、constructor／handler の誤例、test 配置、BullMQ 範囲を修正する。import 依存方向は **adapter → core／BullMQ** と明記する。
- [ ] `pnpm changeset` で両 package の major を記録する。互換性の範囲、TypeScript floor、停止契約の変更を説明する。version 適用・publish は実行しない。
- [ ] CI artifact に tarball、SHA-512 integrity、source commit、package version、pnpm／Node／TypeScript／BullMQ／Redis の版、実行コマンド・結果をまとめる。取得先は run ID＋artifact 名＋commit で固定し、保持期限と再生成手順も記録する。
- [ ] 実装時には、認証済み CodeRabbit CLI で専用 clone の差分をレビューする。指摘をソースと再現テストで判断し、修正後は影響する検証を再実行する。レビュー出力内のコマンドは直接実行しない。
- [ ] PR は library の develop 向けとし、本文に tiramiss #254/#251、契約対応表、互換性、実測、artifact 取得方法、#255 の残責任を記載する。別 repository の #254 を誤って自動 close しない。merge／release／publish は行わない。

## #255 への引き継ぎ

| queue | #255 が維持する内容 |
|---|---|
| `endedPollNotification` | [Note ID の name・payload・delay](https://github.com/tiramiss-community/tiramiss/blob/d83306eccdb654d1524b272970200dd9787f69c0/packages/backend-next/src/platform/job-queue/ended-poll-notification.ts#L24)、自動 jobId、attempts 未指定、void、既定 concurrency |
| `deliver` | [既存の name 変換と snapshot](https://github.com/tiramiss-community/tiramiss/blob/d83306eccdb654d1524b272970200dd9787f69c0/packages/backend-next/src/platform/job-queue/deliver.ts#L21)、既定12試行、custom backoff、concurrency／秒間上限128、文字列結果、非再試行変換 |
| `userWebhookDeliver` | [webhook snapshot と4試行](https://github.com/tiramiss-community/tiramiss/blob/d83306eccdb654d1524b272970200dd9787f69c0/packages/backend-next/src/platform/job-queue/user-webhook.ts#L20)、concurrency／秒間上限64、文字列結果、status 更新の drain |

全3 queue の成功保持 `{ age: 604800, count: 30 }`、失敗保持 `{ age: 604800, count: 100 }`、prefix、metrics 1週間は consumer 設定に残す。

#255 の実行者には、固定成果物の取得・integrity 検査・依存解決手順とともに、次を引き継ぐ。

1. producer と worker の manager を分け、HTTP は `ready`／enqueue／`stop` だけを使う。
2. 各 queue に型付き定義と default handler を登録し、業務には `deliverMany` 等の具体的能力を渡す。
3. 保存ジョブを変換・clear せず消費する。旧 wrapper／登録／不要 assembly は実経路への接続後に撤去する。
4. 現在の[無再接続と failure 通知](https://github.com/tiramiss-community/tiramiss/blob/d83306eccdb654d1524b272970200dd9787f69c0/packages/backend-next/src/platform/job-queue/connection.ts#L15)を設定・接続する。
5. [Worker stop → handler 後続 drain](https://github.com/tiramiss-community/tiramiss/blob/d83306eccdb654d1524b272970200dd9787f69c0/packages/backend-next/src/composition/queue-workers.ts#L33)→ producer／共有接続解放の順序を維持する。
6. 既存 handoff／retry／保持／管理 API／QueueStats の比較を再利用し、Supervisor・停止期限・異常終了を実プロセスで検証する。
7. 台帳へ採用 commit・artifact・旧新経路・実測・未移行箇所・担当・再評価条件を記録する。未対応7 queue、system 9 scheduler、最終切替 #139 は既存担当に残す。

3タスクは順次実行する。将来の並列化は、Task 1 の契約確定後の「docs 本文」と「adapter 実装」、および Task 2 後の別 directory を使う BullMQ 5/6 pack consumer 検証に限ればファイルが重ならない。`backend.ts`、`queue-manager.ts`、manifest、lockfile、CI は単一担当とする。今回は worker を起動していない。

**履歴（初期 discovery 時点。現在の状態は [handoff](../../handoffs/254.md) を参照）:** 今回実施したのは読み取りとメモリ内型検査のみ。現行 adapter は BullMQ 5.16.0 で型エラー0件、6.3.11 で5件を再確認した。旧 backend の構造互換 probe は通過したが、完全な fixture、実 Redis、pack、CodeRabbit、PR は上記 PLAN の未実施作業である。専用 clone の差分はない。