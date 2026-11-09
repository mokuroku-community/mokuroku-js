import { defineJob, type JobBackend } from "@mokurokujs/core";

import { BullmqBackend } from "../../src/backend.js";
import { BullMQQueueManager } from "../../src/queue-manager.js";
import { BullmqJobScheduler } from "../../src/scheduler.js";

import type { BullmqManagerError } from "../../src/types.js";

const backend = new BullmqBackend({ queueManager: new BullMQQueueManager({}) });
const result = defineJob<{ id: number }, { ok: boolean }>("result");
backend.registerHandler(result, async (payload) => ({ ok: payload.id > 0 }), { defaultForQueue: true });
// @ts-expect-error result comes from the definition
backend.registerHandler(result, async () => "wrong");
// @ts-expect-error payload comes from the definition
backend.registerHandler(result, async (payload: string) => ({ ok: payload.length > 0 }));
const erased: JobBackend = backend;
void erased;
const scheduler = new BullmqJobScheduler({ queueManager: new BullMQQueueManager({}) });
void scheduler.upsert(result, { pattern: "* * * * *", payload: { id: 1 } });
// @ts-expect-error scheduler payload must match the job
void scheduler.upsert(result, { pattern: "* * * * *", payload: { id: "bad" } });
function notification(event: BullmqManagerError) {
  if (event.reason === "connection-ended") {
    const connection: "command" | "blocking" = event.connection;
    void connection;
  }
}
void notification;
void backend.enqueue(result, { id: 1 });
void backend.enqueueBulk(result, [{ payload: { id: 2 } }]);
void scheduler.remove(result);
const legacy = defineJob<{ value: string }>("legacy-void");
backend.registerHandler(legacy, async (payload) => {
  const value: string = payload.value;
  void value;
});
