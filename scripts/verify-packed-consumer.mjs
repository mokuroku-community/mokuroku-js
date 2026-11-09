import { runCommand } from "./internal/run-command.mjs";
import { runRedisConsumer } from "./internal/run-redis-consumer.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = resolve(process.argv[2] ?? "");
assert(process.argv[2], "Usage: node scripts/verify-packed-consumer.mjs ARTIFACT_DIRECTORY");
const manifest = JSON.parse(await readFile(join(artifactDir, "manifest.json"), "utf8"));
const receipt = {
  node: process.version,
  source: manifest.source,
  startedAt: new Date().toISOString(),
  commands: [],
  consumers: [],
};
const run = (command, args, cwd = root, env = { ...process.env, NODE_PATH: "" }) =>
  runCommand(command, args, { cwd, env, commands: receipt.commands });
const fixture = `import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { defineJob, JobRuntime, type JobDefinition } from "@mokurokujs/core";
import { BullMQQueueManager, BullmqBackend, defineQueueForBullMQ } from "@mokurokujs/bullmq-adapter";
import { Queue } from "bullmq";
const expected = process.env.PREP_VERSION!;
const coreURL = import.meta.resolve("@mokurokujs/core");
const adapterURL = import.meta.resolve("@mokurokujs/bullmq-adapter");
const fromAdapter = (await promisify(execFile)(process.execPath, ["--input-type=module", "-e", 'import { writeSync } from "node:fs"; writeSync(1, import.meta.resolve("@mokurokujs/core"))'], { cwd: dirname(fileURLToPath(adapterURL)), encoding: "utf8" })).stdout.trim();
assert.equal(realpathSync(fileURLToPath(coreURL)), realpathSync(fileURLToPath(fromAdapter)));
for (const url of [coreURL, fromAdapter, adapterURL]) {
  const entry = realpathSync(fileURLToPath(url));
  assert(entry.includes("node_modules"));
  assert(entry.startsWith(process.cwd() + "/"), "Package escaped isolated consumer");
  assert(!entry.startsWith(process.env.SOURCE_ROOT! + "/"), "workspace/source resolution");
  const pkg = JSON.parse(readFileSync(join(dirname(entry), "..", "package.json"), "utf8"));
  assert.equal(pkg.version, expected);
  assert.equal(pkg.types, "./dist/index.d.ts");
  if (pkg.name === "@mokurokujs/bullmq-adapter") assert.equal(pkg.dependencies["@mokurokujs/core"], expected);
}
const queue = defineQueueForBullMQ("packed-" + randomUUID(), {}).build();
const job = defineJob<{ value: number }, string>("typed", { queue });
const typed: JobDefinition<{ value: number }, string> = job;
const conn = JSON.parse(process.env.PREP_REDIS_CONNECTION!);
const events: unknown[] = [];
const manager = new BullMQQueueManager(conn, { onError: event => events.push(event) });
const producerManager = new BullMQQueueManager(conn);
const worker = new JobRuntime(new BullmqBackend({ queueManager: manager, defaultQueue: queue }));
const producer = new JobRuntime(new BullmqBackend({ queueManager: producerManager, defaultQueue: queue }));
if (false) {
  // @ts-expect-error payload must follow the definition
  await producer.enqueue(typed, { value: "bad" });
  // @ts-expect-error result must follow the definition
  worker.handle(typed, async () => 1);
  // @ts-expect-error handler payload cannot widen inference
  worker.handle(typed, async (payload: { value: string }) => payload.value);
}
worker.handle(job, async (payload, ctx) => { assert.equal(ctx.jobName, "saved-dynamic-name"); return "result:" + payload.value; }, { defaultForQueue: true });
const raw = new Queue(queue.name, { connection: conn });
try {
  await producer.ready([queue], { timeout: 10000 });
  assert.equal((await raw.getWorkers()).length, 0, "producer readiness created workers");
  const saved = await raw.add("saved-dynamic-name", { value: 42 }, { removeOnComplete: false });
  const enqueued = await producer.enqueue(job, { value: 43 }, { jobName: "saved-dynamic-name", removeOnComplete: false });
  assert(enqueued.jobId);
  await producer.stop({ timeout: 10000 });
  assert.equal((await raw.getWorkers()).length, 0, "producer stop created workers");
  await worker.start({ timeout: 10000 });
  await worker.ready([queue], { timeout: 10000 });
  const deadline = Date.now() + 15000;
  let completed;
  let enqueuedCompleted;
  while (Date.now() < deadline) {
    completed = await raw.getJob(saved.id!);
    enqueuedCompleted = await raw.getJob(enqueued.jobId);
    if (completed && await completed.getState() === "completed" &&
        enqueuedCompleted && await enqueuedCompleted.getState() === "completed") break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  completed = await raw.getJob(saved.id!);
  assert(completed);
  assert.equal(await completed.getState(), "completed");
  assert.equal(completed.name, "saved-dynamic-name");
  assert.deepEqual(completed.data, { value: 42 });
  assert.equal(completed.returnvalue, "result:42");
  enqueuedCompleted = await raw.getJob(enqueued.jobId);
  assert(enqueuedCompleted);
  assert.equal(await enqueuedCompleted.getState(), "completed");
  assert.equal(enqueuedCompleted.name, "saved-dynamic-name");
  assert.deepEqual(enqueuedCompleted.data, { value: 43 });
  assert.equal(enqueuedCompleted.returnvalue, "result:43");
  await worker.stop({ timeout: 10000 });
  assert.equal((await raw.getWorkers()).length, 0, "stop left a worker registered");
  assert.equal(events.length, 0);
  const shape = raw as unknown as { getBackend?: () => { client: Promise<{ info: () => Promise<string> }> }; client: Promise<{ info: () => Promise<string> }> };
  const client = await (shape.getBackend ? shape.getBackend().client : shape.client);
  const redis = (await client.info()).match(/redis_version:([^\\r\\n]+)/)?.[1];
  assert(redis);
  console.log(JSON.stringify({ core: realpathSync(fileURLToPath(coreURL)), version: expected, redis, checks: ["esm", "shared-core", "declarations", "dynamic-name", "returnvalue", "enqueue", "ready", "producer-worker-zero", "stop"] }));
} finally {
  try { await worker.stop({ timeout: 10000 }); } finally {
    try { await producer.stop({ timeout: 10000 }); } finally {
      try { await raw.obliterate({ force: true }); } finally { await raw.close(); }
    }
  }
}
`;
let temp;
try {
  assert.equal(manifest.status, "packed");
  assert.deepEqual(manifest.packages.map((pkg) => pkg.name).sort(), ["@mokurokujs/bullmq-adapter", "@mokurokujs/core"]);
  receipt.pnpm = await run("pnpm", ["--version"], root);
  for (const pkg of manifest.packages) {
    assert.equal(pkg.version, manifest.version);
    assert.equal(
      pkg.integrity,
      "sha512-" +
        createHash("sha512")
          .update(await readFile(join(artifactDir, pkg.file)))
          .digest("base64"),
      "tarball integrity mismatch",
    );
  }
  temp = await mkdtemp(join(tmpdir(), "mokuroku-consumer-"));
  assert(!temp.startsWith(`${root}/`), "Consumer must be outside workspace");
  let connection;
  for (const bullmq of ["5.16.0", "6.3.11"]) {
    const cwd = join(temp, bullmq);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(cwd, "vendor"), { recursive: true });
    for (const pkg of manifest.packages)
      await copyFile(
        join(artifactDir, pkg.file),
        join(cwd, "vendor", pkg.name === "@mokurokujs/core" ? "core.tgz" : "adapter.tgz"),
      );
    await writeFile(
      join(cwd, "package.json"),
      JSON.stringify(
        {
          packageManager: "pnpm@10.34.5",
          private: true,
          type: "module",
          dependencies: {
            "@mokurokujs/core": "file:./vendor/core.tgz",
            "@mokurokujs/bullmq-adapter": "file:./vendor/adapter.tgz",
            bullmq,
            ioredis: "5.11.1",
            typescript: "5.4.5",
            "@types/node": "22.10.2",
          },
          pnpm: {
            onlyBuiltDependencies: ["msgpackr-extract"],
            overrides: { "@mokurokujs/core": "file:./vendor/core.tgz", ioredis: "5.11.1" },
          },
        },
        null,
        2,
      ),
    );
    await writeFile(join(cwd, "fixture.ts"), fixture);
    await writeFile(
      join(cwd, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          skipLibCheck: false,
          outDir: "out",
        },
        include: ["fixture.ts"],
      }),
    );
    assert.equal(await run("pnpm", ["--version"], cwd), "10.34.5", "Consumer pnpm must match CI");
    await run(
      "pnpm",
      [
        "install",
        "--store-dir",
        join(temp, "store"),
        "--strict-peer-dependencies",
        "--no-ignore-scripts",
        "--config.strict-dep-builds=true",
        "--config.fetch-retries=0",
        "--fetch-timeout=30000",
      ],
      cwd,
    );
    assert.equal(await run("pnpm", ["exec", "node", "-p", "require('bullmq/package.json').version"], cwd), bullmq);
    const ioredis = await run("pnpm", ["exec", "node", "-p", "require('ioredis/package.json').version"], cwd);
    assert.equal(ioredis, "5.11.1", "Explicit consumer driver must match the verified version");
    const bullmqIoredis = await run(
      "pnpm",
      [
        "exec",
        "node",
        "-p",
        "require('node:module').createRequire(require.resolve('bullmq/package.json'))('ioredis/package.json').version",
      ],
      cwd,
    );
    assert.equal(bullmqIoredis, ioredis, "BullMQ must resolve the explicitly verified driver");
    const consumer = { bullmq, ioredis, bullmqIoredis, typescript: "5.4.5", status: "installed" };
    receipt.consumers.push(consumer);
    assert.equal(await run("pnpm", ["exec", "tsc", "--version"], cwd), "Version 5.4.5");
    await run("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], cwd);
    consumer.declarations = "passed";
    let redisModuleURL;
    if (!connection) {
      if (process.env.PACK_TEST_REDIS_URL) {
        const url = new URL(process.env.PACK_TEST_REDIS_URL);
        assert.equal(url.protocol, "redis:", "Explicit test Redis must use redis://");
        connection = {
          host: url.hostname,
          port: Number(url.port || 6379),
          username: decodeURIComponent(url.username) || undefined,
          password: decodeURIComponent(url.password) || undefined,
          db: Number(url.pathname.slice(1) || 0),
          maxRetriesPerRequest: null,
        };
      } else {
        // Resolve the adapter's dev dependency, never a consumer/workspace package import.
        redisModuleURL = await run(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            'import { writeSync } from "node:fs"; writeSync(1, import.meta.resolve("@testcontainers/redis"))',
          ],
          join(root, "packages/bullmq"),
        );
      }
    }
    const env = {
      ...process.env,
      NODE_PATH: "",
      PREP_VERSION: manifest.version,
      SOURCE_ROOT: root,
      PREP_REDIS_CONNECTION: JSON.stringify(connection),
    };
    const stdout = redisModuleURL
      ? await runRedisConsumer(redisModuleURL, cwd, { env, commands: receipt.commands })
      : await run(process.execPath, ["out/fixture.js"], cwd, env);
    consumer.result = JSON.parse(stdout.trim().split("\n").at(-1));
    consumer.status = "passed";
  }
  receipt.status = "passed";
} catch (error) {
  receipt.status = "failed";
  receipt.error = error.stack;
  throw error;
} finally {
  try {
    if (temp) await rm(temp, { recursive: true, force: true });
  } catch (error) {
    receipt.status = "failed";
    receipt.cleanupError = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    receipt.finishedAt = new Date().toISOString();
    await writeFile(join(artifactDir, "consumer-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  }
}
