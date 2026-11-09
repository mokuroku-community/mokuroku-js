import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, open, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

async function hasLiveMembers(group) {
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    let stat;
    try {
      stat = await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") continue;
      throw error;
    }
    const [state, , pgid] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    // Non-child zombies cannot execute or use files; their parent/init owns reaping.
    if (Number(pgid) === group && state !== "Z" && state !== "X") return true;
  }
  return false;
}

async function stopGroup(group) {
  const signal = (name) => {
    try {
      process.kill(-group, name);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  signal("SIGTERM");
  const grace = Date.now() + 300;
  while (await hasLiveMembers(group)) {
    if (Date.now() >= grace) {
      signal("SIGKILL");
      break;
    }
    await delay(20);
  }
  // Do not remove logs or allow caller cleanup while any group member can run.
  while (await hasLiveMembers(group)) await delay(20);
}

/**
 * Run an internal Linux dev-tool command in its own process group, then drain it.
 * Linux 開発ツール専用。子孫の終了と直接子の回収を待ってから呼出側へ戻す。
 * Descendants must retain the inherited group (no daemonization/setsid).
 */
export async function runCommand(
  command,
  args,
  { cwd, env = process.env, commands = [], timeoutMs = 180_000, trimOutput = true } = {},
) {
  assert.equal(process.platform, "linux", "Process-group supervision requires Linux /proc");
  const logs = await mkdtemp(join(tmpdir(), "mokuroku-command-"));
  const stdout = await open(join(logs, "stdout"), "w");
  const stderr = await open(join(logs, "stderr"), "w");
  let drained = false;
  try {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", stdout.fd, stderr.fd] });
    const closed = new Promise((yes) => {
      child.once("error", (error) => yes({ status: "spawn-error", error }));
      child.once("close", (code, signal) => yes({ status: code ?? signal }));
    });
    let termination;
    let interrupted;
    const terminate = (reason) => {
      interrupted ??= reason;
      termination ??= child.pid ? stopGroup(child.pid) : Promise.resolve();
      // Observe immediately; await below before cleanup or returning to the caller.
      termination.catch(() => {});
    };
    const onInterrupt = () => terminate("SIGINT");
    const onTerminate = () => terminate("SIGTERM");
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onTerminate);
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);
    let outcome;
    try {
      outcome = await closed;
      if (child.pid) termination ??= stopGroup(child.pid);
      await termination;
      drained = true;
    } finally {
      clearTimeout(timer);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
    }
    const result = {
      command: [command, ...args],
      status: outcome.status,
      interrupted: interrupted ?? null,
      stdout: await readFile(join(logs, "stdout"), "utf8"),
      stderr: await readFile(join(logs, "stderr"), "utf8"),
    };
    commands.push(result);
    if (outcome.error) throw outcome.error;
    if (interrupted || result.status !== 0)
      throw new Error(
        `${command} ${args.join(" ")} failed (${interrupted ?? result.status}): ${result.stderr}\n${result.stdout}`,
      );
    return trimOutput ? result.stdout.trim() : result.stdout;
  } finally {
    await stdout.close();
    await stderr.close();
    // A supervision failure is fatal: preserve evidence instead of deleting live files.
    if (!drained) {
      console.error(`Process supervision failed; command logs retained at ${logs}`);
      process.exit(1);
    }
    await rm(logs, { recursive: true, force: true });
  }
}
