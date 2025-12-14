import { type ErrorCode, ErrorCodes, MokurokuError } from "@mokurokujs/core";

import type { QueueDefinition } from "@mokurokujs/core";
import type { BullMQQueueManager } from "./queue-manager.js";

/**
 * BullMQ adapter error codes (extends `@mokurokujs/core`).
 *
 * BullMQ アダプタ固有のエラーコード（`@mokurokujs/core` を拡張）。
 *
 * @see MokurokuBullMQError
 */
export const BullMQErrorCodes = {
  ...ErrorCodes,
  INVALID_CONFIG: "INVALID_CONFIG",
  MISSING_CONFIG: "MISSING_CONFIG",
  WORKER_ALREADY_EXISTS: "WORKER_ALREADY_EXISTS",
} as const;

export type BullMQErrorCode = (typeof BullMQErrorCodes)[keyof typeof BullMQErrorCodes];

/**
 * Base error class for the BullMQ adapter.
 *
 * mokuroku BullMQ アダプタのエラー基底クラス。
 */
export class MokurokuBullMQError extends MokurokuError {
  constructor(params: {
    message: string;
    code: BullMQErrorCode;
    details?: unknown;
  }) {
    super(params as { message: string; code: ErrorCode; details?: unknown });
    this.name = "MokurokuBullMQError";
  }
}

/**
 * Thrown when a required BullMQ config field is missing from a {@link QueueDefinition}.
 *
 * {@link QueueDefinition} に必要な BullMQ 設定が含まれていない場合に投げられる。
 *
 * @see QueueDefinition
 * @see BullMQQueueManager
 */
export class MissingConfigError extends MokurokuBullMQError {
  constructor(queueName: string, configPath: string) {
    super({
      message:
        `QueueDefinition "${queueName}" does not contain ${configPath}. ` +
        `Please use defineQueueForBullMQ('${queueName}', { ${configPath}: {...} }) ` +
        `or defineQueue('${queueName}').withConfig('bullmq', { ${configPath}: {...} }).build()`,
      code: BullMQErrorCodes.MISSING_CONFIG,
      details: { queueName, configPath },
    });
    this.name = "MissingConfigError";
  }
}

/**
 * Thrown when {@link QueueDefinition} `config` cannot be interpreted as BullMQ config.
 *
 * {@link QueueDefinition} の `config` 構造が BullMQ 設定として解釈できない場合に投げられる。
 *
 * @see QueueDefinition
 */
export class InvalidConfigError extends MokurokuBullMQError {
  constructor(queueName: string, details?: unknown) {
    super({
      message:
        `QueueDefinition "${queueName}" has an invalid config structure. ` +
        `Please ensure config is an object and, if present, config.bullmq is an object.`,
      code: BullMQErrorCodes.INVALID_CONFIG,
      details: { queueName, issues: details },
    });
    this.name = "InvalidConfigError";
  }
}

/**
 * Thrown when trying to create a second worker for the same queue name.
 *
 * 同一キュー名に対して Worker を二重作成しようとした場合に投げられる。
 *
 * @see BullMQQueueManager
 */
export class WorkerAlreadyExistsError extends MokurokuBullMQError {
  constructor(queueName: string) {
    super({
      message:
        `Worker for queue "${queueName}" already exists. ` +
        "Cannot create duplicate worker. Each queue can only have one worker instance.",
      code: BullMQErrorCodes.WORKER_ALREADY_EXISTS,
      details: { queueName },
    });
    this.name = "WorkerAlreadyExistsError";
  }
}
