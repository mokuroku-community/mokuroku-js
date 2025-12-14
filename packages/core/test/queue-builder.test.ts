import { describe, expect, it } from "vitest";

import { defineQueue, QueueBuilder } from "../src/queue.js";

describe(QueueBuilder.name, () => {
  describe("#withConfig", () => {
    it("adds backend specific config without mutating previous segments", () => {
      const builder = defineQueue("emails");

      const queueDefinition = builder
        .withConfig("bullmq", {
          workerOptions: { concurrency: 4 },
        })
        .withConfig("custom", {
          region: "asia-northeast1",
        })
        .build();

      expect(queueDefinition.name).toBe("emails");
      expect(queueDefinition.config).toEqual({
        bullmq: {
          workerOptions: { concurrency: 4 },
        },
        custom: {
          region: "asia-northeast1",
        },
      });
    });
  });

  describe("#merge", () => {
    it("merges arbitrary fields into the underlying config", () => {
      const merged = defineQueue("notifications")
        .merge({ retention: { removeOnCompleteAfterSec: 60 } })
        .merge({ retry: { attempts: 5 } })
        .build();

      expect(merged.config).toEqual({
        retention: { removeOnCompleteAfterSec: 60 },
        retry: { attempts: 5 },
      });
    });
  });

  describe("#build", () => {
    it("omits the config field when nothing was added", () => {
      const definition = defineQueue("ephemeral").build();

      expect(definition).toEqual({
        name: "ephemeral",
        config: undefined,
      });
    });
  });
});

describe("defineQueue", () => {
  describe("when extending an existing definition", () => {
    it("preserves existing config and appends new namespaces", () => {
      const base = defineQueue("reports")
        .withConfig("bullmq", {
          queueOptions: { defaultJobOptions: { removeOnComplete: true } },
        })
        .build();

      const extended = defineQueue(base)
        .withConfig("custom", {
          shardKey: "tenant_id",
        })
        .build();

      expect(extended.config).toEqual({
        bullmq: {
          queueOptions: { defaultJobOptions: { removeOnComplete: true } },
        },
        custom: {
          shardKey: "tenant_id",
        },
      });
    });
  });
});
