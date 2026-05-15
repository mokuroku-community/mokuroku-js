import { describe, expect, it } from "vitest";

import { defineJob } from "../src/job.js";
import { defineQueue } from "../src/queue.js";

describe("defineJob", () => {
  it("creates a job definition with empty default options", () => {
    const job = defineJob<{ email: string }>("send-email");

    expect(job).toEqual({
      name: "send-email",
      options: {},
    });
  });

  it("preserves default options and queue association", () => {
    const queue = defineQueue("emails")
      .withConfig("bullmq", {
        workerOptions: { concurrency: 4 },
      })
      .build();

    const job = defineJob<{ email: string }>("send-email", {
      queue,
      attempts: 3,
      backoff: { type: "fixed", delay: 1_000 },
      priority: 10,
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: false,
    });

    expect(job.name).toBe("send-email");
    expect(job.options).toEqual({
      queue,
      attempts: 3,
      backoff: { type: "fixed", delay: 1_000 },
      priority: 10,
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: false,
    });
    expect(job.options.queue).toBe(queue);
  });
});
