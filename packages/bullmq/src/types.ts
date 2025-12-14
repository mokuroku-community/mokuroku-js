import type { QueueDefinition, WorkerHooks } from "@mokurokujs/core";
import type { ConnectionOptions, QueueOptions, WorkerOptions } from "bullmq";
import type { BullMQQueueManager } from "./queue-manager.js";

/**
 * BullMQ-specific config stored under {@link QueueDefinition} `config.bullmq`.
 *
 * - `queueOptions` is passed to `new Queue(...)` (affects enqueue behavior).
 * - `workerOptions` is merged into `new Worker(...)` (affects processing behavior).
 * - `hooks` configures worker/job lifecycle callbacks at the queue level.
 *
 * {@link QueueDefinition} の `config.bullmq` に格納する BullMQ 固有設定。
 * - `queueOptions`: `new Queue(...)` に渡され、enqueue 側の挙動に影響する
 * - `workerOptions`: `new Worker(...)` にマージされ、処理側の挙動に影響する
 * - `hooks`: キュー単位のライフサイクルフック
 *
 * @see QueueDefinition
 * @see BullMQQueueDefinition
 */
export interface BullmqQueueConfig {
  queueOptions?: QueueOptions;
  workerOptions?: Partial<WorkerOptions>;
  hooks?: WorkerHooks;
}

/**
 * {@link QueueDefinition} that includes BullMQ config.
 *
 * BullMQ 設定を含む {@link QueueDefinition}。
 */
export type BullMQQueueDefinition = QueueDefinition<{
  bullmq: BullmqQueueConfig;
}>;

/**
 * {@link QueueDefinition} that carries BullMQ connection options.
 *
 * This is primarily used by {@link BullMQQueueManager} so a single connection can be
 * provided in the same "definition" shape used elsewhere.
 *
 * BullMQ の接続情報を持つ {@link QueueDefinition}。
 * 主に {@link BullMQQueueManager} が「定義と同じ形」で接続設定を受け取るために使う。
 *
 * @see BullMQQueueManager
 */
export type BullMQConnectionDefinition = QueueDefinition<{
  bullmq: { connection: ConnectionOptions };
}>;
