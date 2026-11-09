import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Hash tracked/nonignored files and all package src inputs, including ignored files.
 * 追跡済み・未追跡ファイルと src 内の ignore 対象入力も記録。symlink は許可しない。
 * Dependencies/generated ignored outputs are not a source snapshot.
 */
export async function fingerprintSource(root, run) {
  const tracked = new Set((await run("git", ["ls-files", "--cached", "-z"], root, undefined, false)).split("\0"));
  const untrackedSourceInputs = [];
  const names = (
    await run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], root, undefined, false)
  )
    .split("\0")
    .filter(Boolean);
  // tsup entrypoints can import ignored, untracked files under either src tree.
  // Include those bytes too; never traverse node_modules or generated dist.
  async function sourceNames(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      assert(!stat.isSymbolicLink(), `Source symlinks are unsupported: ${path}`);
      if (stat.isDirectory()) await sourceNames(path);
      else {
        const name = relative(root, path);
        names.push(name);
        if (!tracked.has(name)) untrackedSourceInputs.push(name);
      }
    }
  }
  for (const pkg of ["core", "bullmq"]) await sourceNames(join(root, "packages", pkg, "src"));
  const entries = [];
  for (const name of [...new Set(names)].sort()) {
    const path = join(root, name);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      entries.push({ name, missing: true });
      continue;
    }
    assert(stat.isFile(), `Source input must be a regular file: ${name}`);
    assert.equal(await realpath(path), path, `Source symlinks are unsupported: ${name}`);
    const bytes = await readFile(path);
    entries.push({
      name,
      mode: stat.mode & 0o7777,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return {
    algorithm: "sha256",
    scope:
      "git tracked/nonignored untracked files plus packages/{core,bullmq}/src (including ignored inputs); regular files; names/modes/bytes",
    sha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"),
    untrackedSourceInputs: untrackedSourceInputs.sort(),
    entries,
  };
}

/** Compare source inputs after building/packing. ビルド・pack 後に入力の一致を検査する。 */
export function assertSameSource(before, after) {
  assert.deepEqual(after, before, "Source inputs changed during build/pack");
}
