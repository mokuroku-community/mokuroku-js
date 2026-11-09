import { runCommand } from "./run-command.mjs";

import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Bound Redis startup, the consumer and Redis shutdown as one owned process group.
 * Redis の起動・consumer・停止全体に期限を設ける。終了時は Ryuk が専用 container を回収する。
 */
export function runRedisConsumer(moduleURL, cwd, options = {}) {
  return runCommand(process.execPath, [fileURLToPath(import.meta.url), moduleURL], { ...options, cwd });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { RedisContainer } = await import(process.argv[2]);
  let container;
  let stdout;
  try {
    container = await new RedisContainer("redis:7.4.2-alpine").withStartupTimeout(120_000).start();
    const connection = { host: container.getHost(), port: container.getPort(), maxRetriesPerRequest: null };
    ({ stdout } = await promisify(execFile)(process.execPath, ["out/fixture.js"], {
      env: { ...process.env, PREP_REDIS_CONNECTION: JSON.stringify(connection) },
    }));
  } finally {
    if (container) await container.stop();
  }
  process.stdout.write(stdout);
}
