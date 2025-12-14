/**
 * Queue definition used by mokuroku.
 *
 * - `name` is the queue identifier (typically the BullMQ queue name, etc.).
 * - `config` holds backend-specific options (e.g. `config.bullmq`).
 *
 * mokuroku のキュー定義。
 * - `name` はキュー識別子（例: BullMQ のキュー名）。
 * - `config` はバックエンド固有の設定（例: `config.bullmq`）。
 * @see defineQueue
 * @see QueueBuilder
 */
export interface QueueDefinition<TConfig = unknown> {
  name: string;
  config?: TConfig;
}

/**
 * Builder for {@link QueueDefinition}.
 *
 * Use this to attach adapter-specific config in a type-safe way.
 * Example: `defineQueue("my-queue").withConfig("bullmq", {...}).build()`
 *
 * {@link QueueDefinition} のビルダー。
 * アダプタ固有設定を型安全に追加するために使う。
 * @see QueueDefinition
 * @see defineQueue
 * @see QueueBuilder#withConfig
 */
export class QueueBuilder<TConfig = Record<string, never>> {
  constructor(
    private readonly name: string,
    private readonly config: TConfig = {} as TConfig,
  ) {}

  /**
   * Attach backend-specific config under an arbitrary key.
   * The key is chosen by the adapter (e.g. `"bullmq"`).
   *
   * 任意キーでバックエンド固有設定を追加する。
   * キーはアダプタ側が決める（例: `"bullmq"`）。
   * @example
   * ```typescript
   * defineQueue('my-queue').withConfig('bullmq', { queueOptions: {...} })
   * ```
   */
  withConfig<TKey extends string, TValue>(key: TKey, config: TValue): QueueBuilder<TConfig & Record<TKey, TValue>> {
    return new QueueBuilder(this.name, {
      ...this.config,
      [key]: config,
    } as TConfig & Record<TKey, TValue>);
  }

  /**
   * Merge additional config fields.
   *
   * 追加の設定フィールドをマージする。
   */
  merge<T>(config: T): QueueBuilder<TConfig & T> {
    return new QueueBuilder(this.name, {
      ...this.config,
      ...config,
    } as TConfig & T);
  }

  /**
   * Build the final {@link QueueDefinition}.
   * When config is empty, it is omitted (`config: undefined`) to keep output tidy.
   *
   * {@link QueueDefinition} を構築する。
   * 設定が空の場合は `config: undefined` にして出力を簡潔に保つ。
   */
  build(): QueueDefinition<TConfig> {
    return {
      name: this.name,
      config: Object.keys(this.config as Record<string, unknown>).length > 0 ? this.config : undefined,
    };
  }
}

/**
 * Create or extend a {@link QueueDefinition}.
 *
 * - If a string is given, creates a new definition.
 * - If an existing definition is given, returns a builder seeded with its config.
 *
 * {@link QueueDefinition} を作成/拡張する。
 * - 文字列なら新規作成
 * - 既存定義なら、その設定を引き継いで拡張する
 */
export function defineQueue(name: string): QueueBuilder;

export function defineQueue<TConfig>(base: QueueDefinition<TConfig>): QueueBuilder<TConfig>;

export function defineQueue<TConfig = Record<string, never>>(
  nameOrBase: string | QueueDefinition<TConfig>,
): QueueBuilder<TConfig> {
  if (typeof nameOrBase === "string") {
    return new QueueBuilder(nameOrBase);
  } else {
    return new QueueBuilder(nameOrBase.name, nameOrBase.config as TConfig);
  }
}
