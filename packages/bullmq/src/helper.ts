import { defineQueue, type QueueBuilder, type QueueDefinition } from "@mokurokujs/core";

import type { BullmqQueueConfig } from "./types.js";

/**
 * Define a queue with BullMQ config (type-safe).
 *
 * This is equivalent to `defineQueue(name).withConfig("bullmq", config)`,
 * but provides better type hints for BullMQ options.
 *
 * BullMQ 用のキューを型安全に定義する。
 * `defineQueue(name).withConfig("bullmq", config)` と同等だが、BullMQ 設定の型補完が効く。
 *
 * @see defineQueue
 * @see QueueBuilder#withConfig
 *
 * @example
 * ```typescript
 * const myQueue = defineQueueForBullMQ('my-queue', {
 *   queueOptions: { defaultJobOptions: { removeOnComplete: true } },
 *   workerOptions: { concurrency: 5 }
 * });
 * ```
 */
export function defineQueueForBullMQ(
  name: string,
  config: BullmqQueueConfig,
): QueueBuilder<{ bullmq: BullmqQueueConfig }> {
  return defineQueue(name).withConfig("bullmq", config);
}

/**
 * Extend an existing {@link QueueDefinition} with BullMQ config.
 *
 * 既存の {@link QueueDefinition} を拡張して BullMQ 設定を追加する。
 *
 * @see QueueDefinition
 * @see QueueBuilder
 *
 * @example
 * ```typescript
 * const baseQueue = defineQueue('my-queue').build();
 * const bullmqQueue = extendQueueForBullMQ(baseQueue, {
 *   workerOptions: { concurrency: 10 }
 * });
 * ```
 */
export function extendQueueForBullMQ<TConfig>(
  base: QueueDefinition<TConfig>,
  config: BullmqQueueConfig,
): QueueBuilder<TConfig & { bullmq: BullmqQueueConfig }> {
  return defineQueue(base).withConfig("bullmq", config);
}
