import type { JobRuntime } from "./runtime.js";

/**
 * Stable error codes exposed by `@mokurokujs/core`.
 * `code` is intended for log/metrics grouping (avoid message string matching).
 *
 * `@mokurokujs/core` が公開する安定したエラーコード。
 * `code` はログ/メトリクスの集約キー用途（メッセージ文字列に依存しない）。
 *
 * @see MokurokuError
 * @see InvalidStateError
 */
export const ErrorCodes = {
  HANDLER_NOT_REGISTERED: "HANDLER_NOT_REGISTERED",
  INVALID_STATE: "INVALID_STATE",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Formats a standard message for {@link InvalidStateError}.
 * This keeps wording consistent so logs/alerts can be parsed reliably.
 *
 * {@link InvalidStateError} 用の標準メッセージを生成する。
 * 文言の揺れを抑えて、ログ/アラートを安定して扱えるようにする。
 */
export function formatInvalidStateMessage(params: { action: string; subject: string; state?: string }): string {
  return params.state != null
    ? `[INVALID_STATE] action=${params.action} subject=${params.subject} state=${params.state}`
    : `[INVALID_STATE] action=${params.action} subject=${params.subject}`;
}

/**
 * Base error class for mokuroku.
 *
 * mokuroku のエラー基底クラス。
 *
 * @see ErrorCodes
 */
export class MokurokuError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: unknown;

  constructor(params: {
    message: string;
    code: ErrorCode;
    details?: unknown;
  }) {
    super(params.message);
    this.name = "MokurokuError";
    this.code = params.code;
    this.details = params.details;
  }
}

/**
 * Thrown when a worker receives a job name with no registered handler.
 * Fix by registering handlers before starting workers.
 *
 * @see JobRuntime
 *
 * ハンドラー未登録のジョブを受け取った場合に投げられる。
 * worker 起動前に handler を登録する。
 *
 * @see JobRuntime
 */
export class HandlerNotRegisteredError extends MokurokuError {
  constructor(jobName: string) {
    super({
      message:
        `No handler registered for job "${jobName}". ` +
        `Please call jobRuntime.handle(${jobName}, handler) before starting workers.`,
      code: ErrorCodes.HANDLER_NOT_REGISTERED,
      details: { jobName },
    });
    this.name = "HandlerNotRegisteredError";
  }
}

/**
 * Thrown when an API is used in an invalid lifecycle/state.
 *
 * ライフサイクル/状態遷移が不正な場合に投げられる。
 *
 * @see formatInvalidStateMessage
 */
export class InvalidStateError extends MokurokuError {
  constructor(params: {
    message: string;
    details?: unknown;
  }) {
    super({
      message: params.message,
      code: ErrorCodes.INVALID_STATE,
      details: params.details,
    });
    this.name = "InvalidStateError";
  }
}
