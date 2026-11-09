import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";

import type { GlobalSetupContext } from "vitest/node";

let container: StartedRedisContainer | undefined;

export default async function setup(_: GlobalSetupContext) {
  const required = process.env.REQUIRE_REDIS_TESTS === "1";
  if (required && (process.env.SKIP_REDIS_TESTS === "1" || process.env.TEST_REDIS_DISABLED === "1")) {
    throw new Error("REQUIRE_REDIS_TESTS=1 forbids disabling Redis tests");
  }
  const image = process.env.VITEST_REDIS_IMAGE ?? "redis:7.2";

  if (process.env.SKIP_REDIS_TESTS === "1") {
    process.env.TEST_REDIS_DISABLED = "1";
    return async () => {};
  }

  try {
    container = await new RedisContainer(image).start();
  } catch (error) {
    if (required) throw new Error("Required Redis tests could not start Redis", { cause: error });
    if (error instanceof Error && error.message.includes("container runtime")) {
      process.env.TEST_REDIS_DISABLED = "1";
      console.warn("[vitest] Redis container could not be started:", error.message);
      return async () => {};
    }
    throw error;
  }

  process.env.TEST_REDIS_HOST = container.getHost();
  process.env.TEST_REDIS_PORT = String(container.getPort());
  process.env.TEST_REDIS_URL = container.getConnectionUrl();
  process.env.TEST_REDIS_PASSWORD = container.getPassword();

  return async () => {
    if (container) {
      await container.stop();
      container = undefined;
    }
  };
}
