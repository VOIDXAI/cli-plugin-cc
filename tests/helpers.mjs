import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cli-plugin-cc-test-"));
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input
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
