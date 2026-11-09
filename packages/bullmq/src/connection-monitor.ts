import { cancelled } from "./lifecycle-operation.js";

import type { RedisClient } from "bullmq";

/** BullMQ 5/6 private connection access is confined here. / 版差をこの境界へ閉じ込める。 */
export interface ConnectionHandle {
  readonly client: Promise<RedisClient>;
  readonly _client?: RedisClient;
  disconnect?: (wait?: boolean) => Promise<void>;
}
export function connectionHandles(resource: object, worker = false): ConnectionHandle[] {
  const owner = resource as { backend?: object };
  const shape = (owner.backend ?? resource) as { connection: ConnectionHandle; blockingConnection?: ConnectionHandle };
  if (!worker) return [shape.connection];
  if (!shape.blockingConnection) throw new Error("Unsupported BullMQ blocking connection");
  return [shape.connection, shape.blockingConnection];
}

/** Observe raw clients before their initialization promise resolves. / ready 前から監視する。 */
export class ConnectionMonitor {
  private readonly disposers: (() => void)[] = [];
  private readonly clients = new Set<RedisClient>();
  private readonly waits = new Set<() => void>();
  private disposed = false;
  private ended = false;
  private intentionalDisconnects = 0;

  constructor(
    readonly handle: ConnectionHandle,
    private readonly failed: (error: Error) => void,
    private readonly expected: () => boolean,
    trackDisconnect = false,
  ) {
    const original = handle.disconnect;
    if (trackDisconnect && original) {
      const wrapped = async (wait?: boolean) => {
        this.intentionalDisconnects++;
        try {
          await original.call(handle, wait);
        } finally {
          this.intentionalDisconnects--;
        }
      };
      handle.disconnect = wrapped;
      this.disposers.push(() => {
        if (handle.disconnect === wrapped) handle.disconnect = original;
      });
    }
    if (handle._client) this.attach(handle._client);
    void handle.client.then(
      (client) => {
        if (!this.disposed) this.attach(client);
      },
      () => {
        // Initialization failures propagate through ready(); BullMQ emits its diagnostic error.
        // A failed command is not evidence that the connection ended.
      },
    );
  }

  private attach(client: RedisClient): void {
    if (this.clients.has(client)) return;
    this.clients.add(client);
    const ended = () => {
      // A recoverable close leaves retry policy with ioredis. / 再接続可能な close は終端ではない。
      if (client.status !== "end") return;
      if (this.expected() || this.intentionalDisconnects > 0 || this.ended) return;
      this.ended = true;
      this.failed(new Error("Redis connection ended"));
    };
    const ready = () => {
      this.ended = false;
    };
    client.on("end", ended);
    client.on("close", ended);
    client.on("ready", ready);
    this.disposers.push(() => {
      client.off("end", ended);
      client.off("close", ended);
      client.off("ready", ready);
    });
    if (client.status === "end") ended();
  }

  ready(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let client: RedisClient | undefined;
      let settled = false;
      const cleanup = () => {
        client?.off("ready", ready);
        client?.off("end", ended);
        signal?.removeEventListener("abort", abort);
        this.waits.delete(abort);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const ready = () => finish();
      const ended = () => finish(new Error("Redis connection ended before ready"));
      const abort = () => finish(cancelled());
      this.waits.add(abort);
      signal?.addEventListener("abort", abort, { once: true });
      if (this.disposed || signal?.aborted) {
        abort();
        return;
      }
      void this.handle.client.then(
        (resolved) => {
          if (settled) return;
          client = resolved;
          this.attach(client);
          client.once("ready", ready);
          client.once("end", ended);
          if (client.status === "end") ended();
          else if (client.status === "ready") ready();
        },
        (error) => finish(asError(error)),
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const abort of this.waits) abort();
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    this.clients.clear();
  }
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
