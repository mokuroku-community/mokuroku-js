import { fingerprintSource } from "../internal/source-fingerprint.mjs";

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test("ignored src inputs cannot be mistaken for a clean commit", async () => {
  const root = await mkdtemp(join(tmpdir(), "mokuroku-fingerprint-test-"));
  const run = async (command, args) => (await promisify(execFile)(command, args, { cwd: root })).stdout;
  try {
    await mkdir(join(root, "packages/core/src"), { recursive: true });
    await mkdir(join(root, "packages/bullmq/src"), { recursive: true });
    await writeFile(join(root, ".gitignore"), "*.js\n");
    await writeFile(join(root, "packages/core/src/index.ts"), "export {};\n");
    await run("git", ["init", "--quiet"]);
    await run("git", ["add", "."]);
    assert.deepEqual((await fingerprintSource(root, run)).untrackedSourceInputs, []);
    await writeFile(join(root, "packages/core/src/index.js"), "export const unexpected = true;\n");
    const fingerprint = await fingerprintSource(root, run);
    assert.deepEqual(fingerprint.untrackedSourceInputs, ["packages/core/src/index.js"]);
    assert(fingerprint.entries.some((entry) => entry.name === "packages/core/src/index.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
