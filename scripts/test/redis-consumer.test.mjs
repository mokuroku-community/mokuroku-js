import { runRedisConsumer } from "../internal/run-redis-consumer.mjs";

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

for (const phase of ["start", "stop"]) {
  test(`bounds a stuck Redis ${phase} and settles command diagnostics`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "mokuroku-redis-timeout-test-"));
    const commands = [];
    try {
      await mkdir(join(cwd, "out"));
      await writeFile(join(cwd, "out/fixture.js"), 'console.log("fixture passed");\n');
      const module = join(cwd, "redis.mjs");
      await writeFile(
        module,
        `
        import { writeFileSync } from "node:fs";
        const hang = () => { writeFileSync("entered-phase", "${phase}"); return new Promise(() => setInterval(() => {}, 1000)); };
        export class RedisContainer {
          withStartupTimeout() { return this; }
          async start() { ${phase === "start" ? "return hang();" : "return this;"} }
          getHost() { return "127.0.0.1"; }
          getPort() { return 6379; }
          async stop() { ${phase === "stop" ? "return hang();" : ""} }
        }
      `,
      );
      await assert.rejects(runRedisConsumer(pathToFileURL(module).href, cwd, { commands, timeoutMs: 1000 }), /timeout/);
      assert.equal(await readFile(join(cwd, "entered-phase"), "utf8"), phase);
      assert.equal(commands.length, 1);
      assert.equal(commands[0].interrupted, "timeout");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
