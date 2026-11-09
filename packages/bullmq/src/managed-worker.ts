import { Worker } from "bullmq";

import { asError } from "./connection-monitor.js";

/** Every run, including BullMQ resume's run, is observed. / 再開時の run も監視する。 */
export class ManagedWorker extends Worker<unknown, unknown, string> {
  onRunEnded?: (reason: "run-fulfilled" | "run-rejected", error: Error) => void;
  private shuttingDown = false;
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

  override async pause(doNotWaitActive?: boolean): Promise<void> {
    for (const run of this.runTokens) this.expectedRuns.add(run);
    await super.pause(doNotWaitActive);
  }

  override async resume(): Promise<void> {
    // BullMQ 5 keeps its original run alive across pause; 6 starts a new one.
    this.expectedRuns.clear();
    await super.resume();
  }

  override close(force?: boolean): Promise<void> {
    this.shuttingDown = true;
    return super.close(force);
  }
}
