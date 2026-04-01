import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-cc-test-"));
}

function buildSpawnOptions(options = {}, { includeTimeout = true } = {}) {
  return {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    timeout: includeTimeout ? options.timeout : undefined,
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024
  };
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, buildSpawnOptions(options));
}

export function runWithHardTimeout(command, args, options = {}) {
  const hardTimeoutSeconds = options.hardTimeoutSeconds ?? 600;
  const killAfterSeconds = options.killAfterSeconds ?? 15;
  const timeoutResult = spawnSync(
    "timeout",
    ["-k", `${killAfterSeconds}s`, `${hardTimeoutSeconds}s`, command, ...args],
    buildSpawnOptions(options, { includeTimeout: false })
  );

  if (timeoutResult.error?.code !== "ENOENT") {
    return timeoutResult;
  }

  return spawnSync(command, args, {
    ...buildSpawnOptions(options, { includeTimeout: false }),
    timeout: (hardTimeoutSeconds + killAfterSeconds) * 1000,
    killSignal: "SIGKILL"
  });
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "CLI Plugin CC Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for condition.");
}
