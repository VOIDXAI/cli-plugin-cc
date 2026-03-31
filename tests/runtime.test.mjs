import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeEngines } from "./fake-engine-fixture.mjs";
import { initGitRepo, makeTempDir, run, waitFor } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "cli-cc", "scripts", "cli-companion.mjs");

function envFor(binDir, dataDir) {
  return {
    PATH: `${binDir}:${process.env.PATH}`,
    OPENAI_API_KEY: "openai-test-key",
    GEMINI_API_KEY: "gm-test",
    FACTORY_API_KEY: "fc-test",
    CLI_PLUGIN_CC_DATA_DIR: dataDir
  };
}

function makeRepo() {
  const repoDir = makeTempDir();
  initGitRepo(repoDir);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export function app(items) {\n  return items[0];\n}\n");
  run("git", ["add", "."], { cwd: repoDir });
  run("git", ["commit", "-m", "init"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "src", "app.js"), "export function app(items) {\n  return items?.[0] ?? null;\n}\n");
  return repoDir;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function findEvents(state, type) {
  return (state.events ?? []).filter((entry) => entry.type === type);
}

function lastValue(values) {
  return values.length > 0 ? values[values.length - 1] : null;
}

test("setup reports all three engines and default config", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);

  const result = run(process.execPath, [SCRIPT, "setup", "--all"], {
    cwd: ROOT,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex: available, auth=authenticated/);
  assert.match(result.stdout, /gemini: available, auth=authenticated/);
  assert.match(result.stdout, /droid: available, auth=authenticated/);
  assert.match(result.stdout, /Default engine: codex/);
  assert.match(result.stdout, /Configured defaults:/);
  assert.match(result.stdout, /codex: model=none, effort=none/);
});

test("setup persists codex defaults and later tasks inherit them", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "codex", "--model", "gpt-5.5", "--effort", "medium"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /codex: model=gpt-5\.5, effort=medium/);

  const task = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const state = readJson(fixtures.codexStatePath);
  const turnStart = lastValue(findEvents(state, "turn/start"));
  assert.equal(turnStart?.payload?.model, "gpt-5.5");
  assert.equal(turnStart?.payload?.effort, "medium");
});

test("setup persists gemini and droid defaults for later runs", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const geminiSetup = run(process.execPath, [SCRIPT, "setup", "--engine", "gemini", "--model", "gemini-2.5-pro"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(geminiSetup.status, 0, geminiSetup.stderr);

  const geminiTask = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(geminiTask.status, 0, geminiTask.stderr);
  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.match(geminiLog[0].args.join(" "), /--model gemini-2\.5-pro/);

  const droidSetup = run(process.execPath, [SCRIPT, "setup", "--engine", "droid", "--model", "gpt-5.4", "--effort", "medium"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidSetup.status, 0, droidSetup.stderr);
  assert.match(droidSetup.stdout, /droid: model=gpt-5\.4, effort=medium/);

  const droidReview = run(process.execPath, [SCRIPT, "review", "--engine", "droid"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidReview.status, 0, droidReview.stderr);
  const droidLog = readJsonLines(fixtures.droidLogPath);
  assert.match(droidLog[0].args.join(" "), /--model gpt-5\.4/);
  assert.match(droidLog[0].args.join(" "), /--reasoning-effort medium/);
});

test("setup rejects engine defaults when used with --all", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);

  const result = run(process.execPath, [SCRIPT, "setup", "--all", "--model", "gpt-5.4"], {
    cwd: ROOT,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use --engine when setting default --model or --effort/);
});

test("review uses native codex review and forwards explicit models", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "codex", "--model", "gpt-5.4", "--effort", "high"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Review \(codex\)/);
  assert.match(result.stdout, /Reviewed current changes/);
  assert.match(result.stdout, /Session: thr_/);

  const state = readJson(fixtures.codexStatePath);
  const threadStart = lastValue(findEvents(state, "thread/start"));
  assert.equal(threadStart?.payload?.model, "gpt-5.4");
  assert.equal(findEvents(state, "review/start").length, 1);
  assert.equal(findEvents(state, "turn/start").length, 0);
});

test("adversarial review uses structured codex app-server output and forwards model and effort", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--engine", "codex", "--model", "gpt-5.4", "--effort", "high"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Adversarial Review \(codex\)/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Missing empty-state guard/);
  assert.match(result.stdout, /Reasoning:/);

  const state = readJson(fixtures.codexStatePath);
  const turnStart = lastValue(findEvents(state, "turn/start"));
  assert.equal(turnStart?.payload?.model, "gpt-5.4");
  assert.equal(turnStart?.payload?.effort, "high");
  assert.equal(turnStart?.payload?.hasOutputSchema, true);
});

test("gemini rescue forwards model selection and native resume", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const first = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "--model", "gemini-2.5-pro", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Session: gemini-session-123/);

  const firstLog = readJsonLines(fixtures.geminiLogPath);
  assert.equal(firstLog.length, 1);
  assert.match(firstLog[0].args.join(" "), /--model gemini-2\.5-pro/);

  const resumed = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "--resume", "--model", "gemini-2.5-pro"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Gemini resumed the prior session/);

  const secondLog = readJsonLines(fixtures.geminiLogPath);
  assert.equal(secondLog.length, 2);
  assert.match(secondLog[1].args.join(" "), /--resume gemini-session-123/);
  assert.match(secondLog[1].args.join(" "), /--model gemini-2\.5-pro/);
});

test("review can route to droid using stream-json and review effort", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "droid", "--model", "gpt-5.4", "--effort", "xhigh"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Review \(droid\)/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Missing guard/);

  const log = readJsonLines(fixtures.droidLogPath);
  assert.equal(log.length, 1);
  assert.match(log[0].args.join(" "), /--output-format stream-json/);
  assert.match(log[0].args.join(" "), /--model gpt-5\.4/);
  assert.match(log[0].args.join(" "), /--reasoning-effort high/);
});

test("droid rescue forwards model, mapped effort, and native session resume", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const first = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--model", "gpt-5.4", "--effort", "minimal", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Session: droid-session-123/);

  const firstLog = readJsonLines(fixtures.droidLogPath);
  assert.equal(firstLog.length, 1);
  assert.match(firstLog[0].args.join(" "), /--model gpt-5\.4/);
  assert.match(firstLog[0].args.join(" "), /--reasoning-effort none/);

  const resumed = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--resume", "--model", "gpt-5.4", "--effort", "xhigh"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Droid resumed the prior session/);

  const secondLog = readJsonLines(fixtures.droidLogPath);
  assert.equal(secondLog.length, 2);
  assert.match(secondLog[1].args.join(" "), /--session-id droid-session-123/);
  assert.match(secondLog[1].args.join(" "), /--reasoning-effort high/);
});

test("invalid effort values are rejected before the engine starts", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "--effort", "ultra", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported reasoning effort "ultra"/);
});

test("codex native review no longer falls back to a prompt review", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "codex"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_NATIVE_REVIEW_TEXT: "I could not inspect the repo cleanly."
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /I could not inspect the repo cleanly\./);
  assert.doesNotMatch(result.stdout, /Verdict:/);

  const state = readJson(fixtures.codexStatePath);
  assert.equal(findEvents(state, "review/start").length, 1);
  assert.equal(findEvents(state, "turn/start").length, 0);
});

test("stop gate can run on gemini", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "gemini", "--enable-review-gate"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const hook = run(process.execPath, [path.join(ROOT, "plugins", "cli-cc", "scripts", "stop-review-gate-hook.mjs")], {
    cwd: repoDir,
    env: envFor(binDir, dataDir),
    input: JSON.stringify({
      cwd: repoDir,
      last_assistant_message: "Claude just changed src/app.js"
    })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.equal(hook.stdout.trim(), "");
});

test("stop gate emits a block decision payload when review fails", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "codex", "--enable-review-gate"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const hook = run(process.execPath, [path.join(ROOT, "plugins", "cli-cc", "scripts", "stop-review-gate-hook.mjs")], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_STOP_GATE_DECISION: "BLOCK"
    },
    input: JSON.stringify({
      cwd: repoDir,
      last_assistant_message: "Claude changed src/app.js"
    })
  });
  assert.equal(hook.status, 0, hook.stderr);
  assert.match(hook.stdout, /"decision":"block"/);
  assert.match(hook.stdout, /blocking issue/);
});

test("background rescue job supports status and result", async () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const start = run(
    process.execPath,
    [SCRIPT, "task", "--engine", "codex", "--model", "gpt-5.4", "--effort", "high", "--background", "fix", "the", "bug"],
    {
      cwd: repoDir,
      env: envFor(binDir, dataDir)
    }
  );

  assert.equal(start.status, 0, start.stderr);
  const match = start.stdout.match(/Started (task-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status"], {
      cwd: repoDir,
      env: envFor(binDir, dataDir)
    });
    return /completed/.test(status.stdout);
  });

  const statusJson = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(statusJson.status, 0, statusJson.stderr);
  const parsedStatus = JSON.parse(statusJson.stdout);
  assert.equal(parsedStatus.job.model, "gpt-5.4");
  assert.equal(parsedStatus.job.effort, "high");
  assert.match(parsedStatus.job.threadId, /^thr_/);

  const statusText = run(process.execPath, [SCRIPT, "status", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(statusText.status, 0, statusText.stderr);
  assert.match(statusText.stdout, /Session ID: thr_/);
  assert.match(statusText.stdout, /Resume: codex resume thr_/);
  assert.match(statusText.stdout, /Result: \/cc:result/);

  const result = run(process.execPath, [SCRIPT, "result", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Rescue Result \(codex\)/);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /Session ID: thr_/);
  assert.match(result.stdout, /Resume: codex resume thr_/);
});

test("cancel marks a running job as cancelled", async () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const start = run(
    process.execPath,
    [SCRIPT, "task", "--engine", "codex", "--background", "long", "task"],
    {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "1500"
      }
    }
  );

  const match = start.stdout.match(/Started (task-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled/);

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status"], {
      cwd: repoDir,
      env: envFor(binDir, dataDir)
    });
    return /cancelled/.test(status.stdout);
  });
});
