import { runCommand } from "./internal/run-command.mjs";
import { assertSameSource, fingerprintSource } from "./internal/source-fingerprint.mjs";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
assert(process.argv[2], "Usage: node scripts/pack-preparation.mjs OUTPUT_DIRECTORY [--require-clean]");
const output = resolve(process.argv[2]);
function assertOutsideSource(path) {
  const rel = relative(root, path);
  assert(rel === ".." || rel.startsWith(`..${sep}`), "Artifacts must be outside the source workspace");
}
assertOutsideSource(output);
const commands = [];
const run = (command, args, cwd = root, env = process.env, trimOutput = true) =>
  runCommand(command, args, { cwd, env, commands, trimOutput });
const sha = await run("git", ["rev-parse", "HEAD"]);
assert.match(sha, /^[0-9a-f]{40}$/);
const status = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
const fingerprintBefore = await fingerprintSource(root, run);
const dirty = status !== "" || fingerprintBefore.untrackedSourceInputs.length > 0;
if (process.argv.includes("--require-clean")) assert.equal(dirty, false, "CI artifacts require a clean source commit");
const version = `0.0.0-prep.g${sha}${dirty ? `.dirty.${fingerprintBefore.sha256}` : ""}`;
await mkdir(output, { recursive: true });
assertOutsideSource(await realpath(output));
assert.deepEqual(await readdir(output), [], "Output directory must be empty to avoid mixing artifacts");
const manifest = {
  version,
  createdAt: new Date().toISOString(),
  source: {
    sha,
    dirty,
    status,
    fingerprintBefore,
  },
  ci: {
    repository: process.env.GITHUB_REPOSITORY ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    eventCommit: process.env.GITHUB_SHA ?? null,
    artifact: `mokuroku-prep-${sha}-${process.env.GITHUB_RUN_ID ?? "local"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`,
    retentionDays: 30,
  },
  tools: {
    node: process.version,
    pnpm: await run("pnpm", ["--version"]),
    typescript: await run("pnpm", ["exec", "tsc", "--version"]),
    bullmq: await run(
      "pnpm",
      ["exec", "node", "-p", "require('bullmq/package.json').version"],
      join(root, "packages/bullmq"),
    ),
  },
  packages: [],
  commands,
};
let staging;
try {
  staging = await mkdtemp(join(tmpdir(), "mokuroku-pack-"));
  // Fresh sequential tsup builds emit only outside the checkout. The adapter's
  // declarations resolve the freshly built core, never a stale workspace dist.
  const buildRoot = join(staging, "build");
  await mkdir(buildRoot);
  const adapterConfig = join(buildRoot, "adapter-tsconfig.json");
  await writeFile(
    adapterConfig,
    JSON.stringify({
      extends: join(root, "packages/bullmq/tsconfig.json"),
      compilerOptions: { paths: { "@mokurokujs/core": [join(buildRoot, "core/index.d.ts")] } },
    }),
  );
  await run("pnpm", ["exec", "tsup", "--out-dir", join(buildRoot, "core")], join(root, "packages/core"));
  await run(
    "pnpm",
    ["exec", "tsup", "--out-dir", join(buildRoot, "bullmq"), "--tsconfig", adapterConfig],
    join(root, "packages/bullmq"),
  );
  for (const dir of ["core", "bullmq"]) {
    const source = join(root, "packages", dir);
    const target = join(staging, dir);
    const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
    pkg.version = version;
    pkg.packageManager = "pnpm@10.34.5";
    delete pkg.devDependencies; // catalog: entries belong to the workspace, not the standalone staging package.
    if (dir === "bullmq") pkg.dependencies["@mokurokujs/core"] = version;
    await mkdir(target);
    await cp(join(buildRoot, dir), join(target, "dist"), { recursive: true });
    await copyFile(join(root, "LICENSE"), join(target, "LICENSE"));
    await copyFile(join(root, "README.md"), join(target, "README.md"));
    await writeFile(join(target, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    assert.equal(await run("pnpm", ["--version"], target), manifest.tools.pnpm);
    await run("pnpm", ["pack", "--pack-destination", target], target);
    const tarballs = (await readdir(target)).filter((file) => file.endsWith(".tgz"));
    assert.equal(tarballs.length, 1);
    const file = dir === "core" ? "core.tgz" : "adapter.tgz";
    await copyFile(join(target, tarballs[0]), join(output, file));
    const entries = (await run("tar", ["-tzf", join(output, file)])).split("\n");
    assert(entries.includes("package/dist/index.js"));
    assert(entries.includes("package/dist/index.d.ts"));
    assert(!entries.some((entry) => entry.startsWith("package/src/") || entry.startsWith("package/node_modules/")));
    const packed = JSON.parse(await run("tar", ["-xOzf", join(output, file), "package/package.json"]));
    assert.equal(packed.version, version);
    if (dir === "bullmq") assert.equal(packed.dependencies["@mokurokujs/core"], version);
    const bytes = await readFile(join(output, file));
    manifest.packages.push({
      name: pkg.name,
      version,
      file,
      bytes: bytes.length,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      entries,
    });
  }
  assert.equal(
    await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    status,
    "Packing changed source state",
  );
  assert.equal(await run("git", ["rev-parse", "HEAD"]), sha, "Source commit changed during packing");
  manifest.source.fingerprintAfter = await fingerprintSource(root, run);
  assertSameSource(fingerprintBefore, manifest.source.fingerprintAfter);
  manifest.status = "packed";
} catch (error) {
  manifest.status = "failed";
  manifest.error = error.stack;
  throw error;
} finally {
  try {
    if (staging) await rm(staging, { recursive: true, force: true });
  } catch (error) {
    manifest.status = "failed";
    manifest.cleanupError = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
console.log(join(output, "manifest.json"));
