import { Worker } from "bullmq";

import { asError } from "./connection-monitor.js";

/** Every run, including BullMQ resume's run, is observed. / 再開時の run も監視する。 */
export class ManagedWorker extends Worker<unknown, unknown, string> {
  onRunEnded?: (reason: "run-fulfilled" | "run-rejected", error: Error) => void;
  private shuttingDown = false;
  private pausing?: Promise<void>;
  private readonly expectedRuns = new Set<object>();
  private readonly runTokens = new Set<object>();

  override run(): Promise<void> {
    const token = {};
    this.runTokens.add(token);
    const run = super.run();
    void run
      .then(
        () => {
          if (!this.shuttingDown && !this.expectedRuns.has(token))
            this.onRunEnded?.("run-fulfilled", new Error("Worker run fulfilled unexpectedly"));
        },
        (error) => {
          if (!this.shuttingDown) this.onRunEnded?.("run-rejected", asError(error));
        },
      )
      .finally(() => {
        this.runTokens.delete(token);
        this.expectedRuns.delete(token);
      });
    return run;
  }

  /** Mark only the current runs as intentional pauses. / 現在の run に停止理由を束縛する。 */
  override pause(doNotWaitActive?: boolean): Promise<void> {
    if (this.pausing) return this.pausing;
    for (const run of this.runTokens) this.expectedRuns.add(run);
    const operation = super.pause(doNotWaitActive);
    this.pausing = operation;
    const clear = () => {
      if (this.pausing === operation) this.pausing = undefined;
    };
    void operation.then(clear, clear);
    return operation;
  }

  /** Resume after draining; keep markers for exited runs until settlement. / drain 後に再開し、終了 run の印を保持する。 */
  override async resume(): Promise<void> {
    await this.pausing;
    // BullMQ 5 keeps its original run alive across pause; 6 starts a new one.
    // Only a continuing run loses its pause marker; an exited run may still
    // have its promise observer queued. / 継続する run だけ停止の印を解除する。
    if (this.isRunning()) this.expectedRuns.clear();
    await super.resume();
  }

  override close(force?: boolean): Promise<void> {
    this.shuttingDown = true;
    return super.close(force);
  }
}
