import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { installFakeEngines } from "./fake-engine-fixture.mjs";
import { initGitRepo, makeTempDir, run, waitFor } from "./helpers.mjs";
import { resolveStateDir, setConfig } from "../plugins/cli-cc/scripts/lib/state.mjs";
import { SESSION_ID_ENV } from "../plugins/cli-cc/scripts/lib/tracked-jobs.mjs";

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

function writePlanFile(plan) {
  const filePath = path.join(makeTempDir(), "workflow-plan.json");
  fs.writeFileSync(filePath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return filePath;
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
  assert.match(result.stdout, /codex: model=none, effort=none, permission=legacy/);
});

test("setup persists codex defaults and later tasks inherit them", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "codex", "--model", "gpt-5.5", "--effort", "medium", "--permission", "dev"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /codex: model=gpt-5\.5, effort=medium, permission=dev/);

  const task = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(task.status, 0, task.stderr);
  assert.match(task.stdout, /Permission: dev \(effective: sandbox=workspace-write\)/);

  const state = readJson(fixtures.codexStatePath);
  const turnStart = lastValue(findEvents(state, "turn/start"));
  const threadStart = lastValue(findEvents(state, "thread/start"));
  assert.equal(turnStart?.payload?.model, "gpt-5.5");
  assert.equal(turnStart?.payload?.effort, "medium");
  assert.equal(threadStart?.payload?.sandbox, "workspace-write");
});

test("all engines pass model ids through exactly as written", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const codexTask = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "--model", "spark", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(codexTask.status, 0, codexTask.stderr);

  const codexState = readJson(fixtures.codexStatePath);
  const codexTurn = lastValue(findEvents(codexState, "turn/start"));
  assert.equal(codexTurn?.payload?.model, "spark");

  const droidTask = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--model", "spark", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidTask.status, 0, droidTask.stderr);

  const droidLog = readJsonLines(fixtures.droidLogPath);
  assert.match(droidLog.at(-1).args.join(" "), /--model spark/);
});

test("setup persists gemini and droid defaults for later runs", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const geminiSetup = run(process.execPath, [SCRIPT, "setup", "--engine", "gemini", "--model", "gemini-2.5-pro", "--permission", "full"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(geminiSetup.status, 0, geminiSetup.stderr);
  assert.match(geminiSetup.stdout, /gemini: model=gemini-2\.5-pro, effort=none, permission=full/);

  const geminiTask = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(geminiTask.status, 0, geminiTask.stderr);
  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.match(geminiLog[0].args.join(" "), /--model gemini-2\.5-pro/);
  assert.match(geminiLog[0].args.join(" "), /--approval-mode yolo/);

  const droidSetup = run(process.execPath, [SCRIPT, "setup", "--engine", "droid", "--model", "gpt-5.4", "--effort", "medium", "--permission", "dev"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidSetup.status, 0, droidSetup.stderr);
  assert.match(droidSetup.stdout, /droid: model=gpt-5\.4, effort=medium, permission=dev/);

  const droidReview = run(process.execPath, [SCRIPT, "review", "--engine", "droid"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidReview.status, 0, droidReview.stderr);
  const droidTask = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidTask.status, 0, droidTask.stderr);
  assert.match(droidTask.stdout, /Permission: dev \(effective: auto=medium\)/);

  const droidLog = readJsonLines(fixtures.droidLogPath);
  assert.match(droidLog[0].args.join(" "), /--model gpt-5\.4/);
  assert.match(droidLog[0].args.join(" "), /--reasoning-effort medium/);
  assert.doesNotMatch(droidLog[0].args.join(" "), /--auto|--skip-permissions-unsafe/);
  assert.match(droidLog[1].args.join(" "), /--auto medium/);
  assert.match(droidLog[1].args.join(" "), /--model gpt-5\.4/);
  assert.match(droidLog[1].args.join(" "), /--reasoning-effort medium/);
});

test("gemini warns and ignores explicit effort values because its CLI exposes no reasoning-effort flag", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "gemini", "--effort", "high"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stderr, /Gemini does not support `--effort`/);
  assert.match(setup.stderr, /Ignoring it\./);
  assert.match(setup.stdout, /gemini: model=none, effort=none, permission=legacy/);

  const task = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "--model", "gemini-2.5-pro", "--effort", "high", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(task.status, 0, task.stderr);
  assert.match(task.stderr, /Gemini does not support `--effort`/);
  assert.match(task.stderr, /Ignoring it\./);

  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.equal(geminiLog.length, 1);
  assert.match(geminiLog[0].args.join(" "), /--model gemini-2\.5-pro/);
  assert.doesNotMatch(geminiLog[0].args.join(" "), /effort|reasoning/);
});

test("gemini ignores stale stored effort defaults from older plugin state", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();
  const previousDataDir = process.env.CLI_PLUGIN_CC_DATA_DIR;
  process.env.CLI_PLUGIN_CC_DATA_DIR = dataDir;
  try {
    setConfig(repoDir, {
      engineDefaults: {
        gemini: {
          model: "gemini-2.5-pro",
          effort: "high"
        }
      }
    });
  } finally {
    if (previousDataDir == null) {
      delete process.env.CLI_PLUGIN_CC_DATA_DIR;
    } else {
      process.env.CLI_PLUGIN_CC_DATA_DIR = previousDataDir;
    }
  }

  const setup = run(process.execPath, [SCRIPT, "setup", "--engine", "gemini"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /gemini: model=gemini-2\.5-pro, effort=ignored \(high\), permission=legacy/);

  const task = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.match(geminiLog[0].args.join(" "), /--model gemini-2\.5-pro/);
  assert.doesNotMatch(geminiLog[0].args.join(" "), /effort|reasoning/);
});

test("gemini does not inject a plugin-level default model when none is configured", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.doesNotMatch(geminiLog[0].args.join(" "), /--model /);
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
  assert.match(result.stderr, /Use --engine when setting default --model, --effort, or --permission/);
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

test("review rejects custom focus text and points users at adversarial review", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "codex", "focus", "on", "auth"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/cc:adversarial-review --engine codex focus on auth/i);
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
  assert.match(firstLog[0].args.join(" "), /--approval-mode auto_edit/);

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
  assert.match(secondLog[1].args.join(" "), /--approval-mode auto_edit/);
});

test("gemini surfaces model failures with the model id and reason", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "gemini"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_ERROR_MODEL: "gemini-3.1-pro-preview",
      FAKE_GEMINI_ERROR_CODE: "429",
      FAKE_GEMINI_ERROR_REASON: "MODEL_CAPACITY_EXHAUSTED",
      FAKE_GEMINI_ERROR_MESSAGE: "No capacity available for model gemini-3.1-pro-preview on the server"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /model=gemini-3\.1-pro-preview/);
  assert.match(result.stdout, /code=429/);
  assert.match(result.stdout, /reason=MODEL_CAPACITY_EXHAUSTED/);
  assert.match(result.stdout, /No capacity available for model gemini-3\.1-pro-preview on the server/);
});

test("gemini review accepts fenced json payloads and normalizes range-based findings", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "review", "--engine", "gemini"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_FENCED_REVIEW: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verdict: approved/);
  assert.match(result.stdout, /\[info\] Finding 1 \(src\/app\.js:2-4\)/);
  assert.match(result.stdout, /Guarding empty arrays avoids an undefined access\./);
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
  assert.match(firstLog[0].args.join(" "), /--auto low/);

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
  assert.match(secondLog[1].args.join(" "), /--auto low/);
});

test("explicit task permissions map to engine-native modes", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();

  const codexTask = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "--permission", "full", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(codexTask.status, 0, codexTask.stderr);
  assert.match(codexTask.stdout, /Permission: full \(effective: sandbox=danger-full-access\)/);

  const codexState = readJson(fixtures.codexStatePath);
  const codexThread = lastValue(findEvents(codexState, "thread/start"));
  assert.equal(codexThread?.payload?.sandbox, "danger-full-access");

  const geminiTask = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "--permission", "read-only", "inspect", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(geminiTask.status, 0, geminiTask.stderr);
  assert.match(geminiTask.stdout, /Permission: read-only \(effective: approval-mode=plan\)/);

  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.match(geminiLog.at(-1).args.join(" "), /--approval-mode plan/);

  const droidTask = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--permission", "unsafe", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(droidTask.status, 0, droidTask.stderr);
  assert.match(droidTask.stdout, /Permission: unsafe \(effective: skip-permissions-unsafe\)/);

  const droidLog = readJsonLines(fixtures.droidLogPath);
  assert.match(droidLog.at(-1).args.join(" "), /--skip-permissions-unsafe/);
  assert.doesNotMatch(droidLog.at(-1).args.join(" "), /--auto/);
});

test("permission failures include actionable retry guidance", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const codexFailure = run(process.execPath, [SCRIPT, "task", "--engine", "codex", "--permission", "dev", "delete", "the", "header"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_CODEX_PERMISSION_ERROR: "1"
    }
  });
  assert.equal(codexFailure.status, 1);
  assert.match(codexFailure.stdout, /Sandbox blocked write access/i);
  assert.match(codexFailure.stdout, /Permission issue detected\./);
  assert.match(codexFailure.stdout, /Retry with `--permission full` to use `sandbox=danger-full-access`\./);

  const geminiFailure = run(process.execPath, [SCRIPT, "task", "--engine", "gemini", "--permission", "edit", "delete", "the", "header"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_ERROR_MESSAGE: "Approval required to write files in this directory.",
      FAKE_GEMINI_ERROR_CODE: "1",
      FAKE_GEMINI_ERROR_REASON: "APPROVAL_REQUIRED"
    }
  });
  assert.equal(geminiFailure.status, 1);
  assert.match(geminiFailure.stdout, /Approval required to write files in this directory\./);
  assert.match(geminiFailure.stdout, /Permission issue detected\./);
  assert.match(geminiFailure.stdout, /Retry with `--permission full` to use `--approval-mode yolo`\./);

  const droidFailure = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--permission", "dev", "delete", "the", "header"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_DROID_PERMISSION_ERROR: "1"
    }
  });
  assert.equal(droidFailure.status, 1);
  assert.match(droidFailure.stdout, /insufficient permission to proceed/i);
  assert.match(droidFailure.stdout, /Permission issue detected\./);
  assert.match(droidFailure.stdout, /Retry with `--permission full` to use `--auto high`\./);
  assert.match(droidFailure.stdout, /retry with `--permission unsafe`/i);
});

test("job records persist normalized engine capabilities and owner state", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "fix", "it"], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(result.status, 0, result.stderr);

  const previousDataDir = process.env.CLI_PLUGIN_CC_DATA_DIR;
  process.env.CLI_PLUGIN_CC_DATA_DIR = dataDir;
  const stateDir = resolveStateDir(repoDir);
  if (previousDataDir == null) {
    delete process.env.CLI_PLUGIN_CC_DATA_DIR;
  } else {
    process.env.CLI_PLUGIN_CC_DATA_DIR = previousDataDir;
  }
  const state = readJson(path.join(stateDir, "state.json"));
  const latestJob = state.jobs[0];
  assert.equal(latestJob.capabilities.resumeKind, "session");
  assert.equal(latestJob.capabilities.streamingLevel, "basic");
  assert.equal(latestJob.ownerState.state, "completed");
  assert.equal(latestJob.ownerState.cancelStrategy, "process");
  assert.equal(latestJob.ownerState.sessionRef, "droid-session-123");

  const storedJob = readJson(path.join(stateDir, "jobs", `${latestJob.id}.json`));
  assert.equal(storedJob.ownerState.sessionRef, "droid-session-123");
  assert.equal(storedJob.result.capabilities.resumeKind, "session");
});

test("droid adversarial review accepts decision-shaped structured output", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const result = run(process.execPath, [SCRIPT, "adversarial-review", "--engine", "droid", "Find correctness regressions only"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_DROID_DECISION_ONLY: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Adversarial Review \(droid\)/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /Droid decision-mode review found one issue\./);
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

test("orchestrate validates workflow plans before any engine starts", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Bad review workflow",
    task: "Review the current changes",
    steps: [
      {
        id: "review-now",
        title: "Review now",
        engine: "codex",
        assignmentSource: "auto",
        kind: "review",
        input: "this should not be allowed",
        options: {}
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /input is not supported for review steps/i);
});

test("orchestrate rejects step references that point to future steps", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Bad reference workflow",
    task: "Fix the issue",
    steps: [
      {
        id: "implement",
        title: "Implement",
        engine: "codex",
        assignmentSource: "auto",
        kind: "task",
        input: "Use {{step_summary:final-review}} first.",
        options: {}
      },
      {
        id: "final-review",
        title: "Final review",
        engine: "droid",
        assignmentSource: "auto",
        kind: "review",
        input: null,
        options: {}
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /references "step_summary:final-review" before step "final-review" is available/i);
});

test("orchestrate executes a foreground multi-step workflow and preserves manual engine assignments", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  const fixtures = installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Implement, challenge, review",
    task: "Fix the regression safely",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "manual",
        kind: "task",
        input: "{{workflow_task}}",
        options: {
          model: "gpt-5.4",
          permission: "full"
        }
      },
      {
        id: "challenge",
        title: "Challenge the fix",
        engine: "gemini",
        assignmentSource: "manual",
        kind: "adversarial-review",
        input: "Question this result: {{step_summary:implement}}",
        options: {
          model: "gemini-2.5-pro"
        }
      },
      {
        id: "final-review",
        title: "Final review",
        engine: "droid",
        assignmentSource: "auto",
        kind: "review",
        input: null,
        options: {
          model: "gpt-5.4"
        }
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Orchestration Result/);
  assert.match(result.stdout, /\| 1\. Implement the fix \| task \| codex \| manual \| completed \|/);
  assert.match(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \|/);
  assert.match(result.stdout, /\| 3\. Final review \| review \| droid \| auto \| completed \|/);
  assert.match(result.stdout, /# Rescue Result \(codex\)/);
  assert.match(result.stdout, /# Adversarial Review \(gemini\)/);
  assert.match(result.stdout, /# Review \(droid\)/);

  const codexState = readJson(fixtures.codexStatePath);
  const codexTurn = lastValue(findEvents(codexState, "turn/start"));
  assert.match(codexTurn?.payload?.prompt ?? "", /Fix the regression safely/);

  const geminiLog = readJsonLines(fixtures.geminiLogPath);
  assert.equal(geminiLog.length, 1);
  assert.match(geminiLog[0].args.join(" "), /Question this result: Handled the requested task\./);

  const droidLog = readJsonLines(fixtures.droidLogPath);
  assert.equal(droidLog.length, 1);
  assert.match(droidLog[0].args.join(" "), /--output-format stream-json/);
});

test("orchestrate normalizes gemini outcome-style summaries for workflow steps", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Outcome-style gemini review",
    task: "Fix the regression safely",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "manual",
        kind: "task",
        input: "{{workflow_task}}",
        options: {}
      },
      {
        id: "challenge",
        title: "Challenge the fix",
        engine: "gemini",
        assignmentSource: "manual",
        kind: "adversarial-review",
        input: "Question this result: {{step_summary:implement}}",
        options: {
          model: "gemini-2.5-flash"
        }
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_OUTCOME_REVIEW: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| Prior review found the right regression, but it understates the silent corruption risk\./);
  assert.doesNotMatch(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| ```json/);
  assert.match(result.stdout, /# Adversarial Review \(gemini\)[\s\S]*Verdict: needs-attention/);
  assert.match(result.stdout, /Issue in src\/app\.js/);
});

test("orchestrate normalizes gemini finding-type summaries for workflow steps", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Finding-type gemini review",
    task: "Fix the regression safely",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "manual",
        kind: "task",
        input: "{{workflow_task}}",
        options: {}
      },
      {
        id: "challenge",
        title: "Challenge the fix",
        engine: "gemini",
        assignmentSource: "manual",
        kind: "adversarial-review",
        input: "Question this result: {{step_summary:implement}}",
        options: {
          model: "gemini-2.5-flash"
        }
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_FINDING_TYPE_REVIEW: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| This change introduces a critical, silent API contract violation that should not ship\./);
  assert.doesNotMatch(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| ```json/);
  assert.match(result.stdout, /# Adversarial Review \(gemini\)[\s\S]*Verdict: needs-attention/);
  assert.match(result.stdout, /Changing an exported sum helper from addition to subtraction silently breaks callers/);
});

test("orchestrate normalizes gemini overall-assessment summaries for workflow steps", () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Overall-assessment gemini review",
    task: "Fix the regression safely",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "manual",
        kind: "task",
        input: "{{workflow_task}}",
        options: {}
      },
      {
        id: "challenge",
        title: "Challenge the fix",
        engine: "gemini",
        assignmentSource: "manual",
        kind: "adversarial-review",
        input: "Question this result: {{step_summary:implement}}",
        options: {
          model: "gemini-2.5-flash"
        }
      }
    ]
  });

  const result = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_GEMINI_OVERALL_ASSESSMENT_REVIEW: "1"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| The prior review found the semantic inversion, but it understated the silent corruption risk to downstream callers\./);
  assert.doesNotMatch(result.stdout, /\| 2\. Challenge the fix \| adversarial-review \| gemini \| manual \| completed \| ```json/);
  assert.match(result.stdout, /# Adversarial Review \(gemini\)[\s\S]*Verdict: needs-attention/);
  assert.match(result.stdout, /Issue in src\/app\.js/);
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
    [SCRIPT, "task", "--engine", "codex", "--model", "gpt-5.4", "--effort", "high", "--permission", "full", "--background", "fix", "the", "bug"],
    {
      cwd: repoDir,
      env: envFor(binDir, dataDir)
    }
  );

  assert.equal(start.status, 0, start.stderr);
  const match = start.stdout.match(/Started (task-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  const earlyResult = run(process.execPath, [SCRIPT, "result", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(earlyResult.status, 1);
  assert.match(earlyResult.stderr, /is still (queued|running)/);

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
  assert.equal(parsedStatus.job.permission, "full");
  assert.equal(parsedStatus.job.permissionNative, "sandbox=danger-full-access");
  assert.match(parsedStatus.job.threadId, /^thr_/);

  const statusText = run(process.execPath, [SCRIPT, "status", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(statusText.status, 0, statusText.stderr);
  assert.match(statusText.stdout, /Session ID: thr_/);
  assert.match(statusText.stdout, /Permission: full \(effective: sandbox=danger-full-access\)/);
  assert.match(statusText.stdout, /Resume: codex resume thr_/);
  assert.match(statusText.stdout, /Result: \/cc:result/);

  const result = run(process.execPath, [SCRIPT, "result", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Rescue Result \(codex\)/);
  assert.match(result.stdout, /Handled the requested task/);
  assert.match(result.stdout, /Permission: full \(effective: sandbox=danger-full-access\)/);
  assert.match(result.stdout, /Session ID: thr_/);
  assert.match(result.stdout, /Resume: codex resume thr_/);
});

test("background orchestration workflow supports status and result", async () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Background workflow",
    task: "Fix the bug",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "auto",
        kind: "task",
        input: "{{workflow_task}}",
        options: {
          model: "gpt-5.4"
        }
      }
    ]
  });

  const start = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile, "--background"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "1200"
    }
  });

  assert.equal(start.status, 0, start.stderr);
  const match = start.stdout.match(/Started (orchestrate-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "1200"
      }
    });
    if (status.status !== 0) {
      return false;
    }
    const parsed = JSON.parse(status.stdout);
    return parsed.job.jobClass === "orchestrate" && parsed.job.steps?.[0]?.status === "running";
  }, 2500);

  const runningStatus = run(process.execPath, [SCRIPT, "status", jobId], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "1200"
    }
  });
  assert.equal(runningStatus.status, 0, runningStatus.stderr);
  assert.match(runningStatus.stdout, /Current step: 1\/1/);
  assert.match(runningStatus.stdout, /\| 1\. Implement the fix \| task \| codex \| auto \| running \|/);

  const earlyResult = run(process.execPath, [SCRIPT, "result", jobId], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "1200"
    }
  });
  assert.equal(earlyResult.status, 1);
  assert.match(earlyResult.stderr, /is still (queued|running)/);

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "1200"
      }
    });
    return status.status === 0 && /"completed"/.test(status.stdout);
  }, 4000);

  const result = run(process.execPath, [SCRIPT, "result", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Orchestration Result/);
  assert.match(result.stdout, /Workflow: Background workflow/);
  assert.match(result.stdout, /\| 1\. Implement the fix \| task \| codex \| auto \| completed \|/);
});

test("droid background status surfaces session id before completion when stream init arrives early", async () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();

  const start = run(process.execPath, [SCRIPT, "task", "--engine", "droid", "--background", "fix", "the", "bug"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "2500",
      FAKE_DROID_INIT_BEFORE_DELAY: "1"
    }
  });

  assert.equal(start.status, 0, start.stderr);
  const match = start.stdout.match(/Started (task-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "2500",
        FAKE_DROID_INIT_BEFORE_DELAY: "1"
      }
    });
    if (status.status !== 0) {
      return false;
    }
    const parsed = JSON.parse(status.stdout);
    return parsed.job.status === "running" && parsed.job.sessionRef === "droid-session-123";
  }, 3000);

  const runningStatus = run(process.execPath, [SCRIPT, "status", jobId], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "2500",
      FAKE_DROID_INIT_BEFORE_DELAY: "1"
    }
  });
  assert.equal(runningStatus.status, 0, runningStatus.stderr);
  assert.match(runningStatus.stdout, /Session ID: droid-session-123/);

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "2500",
        FAKE_DROID_INIT_BEFORE_DELAY: "1"
      }
    });
    return status.status === 0 && /"completed"/.test(status.stdout);
  }, 4000);
});

test("task-resume-candidate returns the latest rescue thread for the current session and engine", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          defaultEngine: "codex",
          stopReviewGate: false,
          stopReviewGateEngine: "codex",
          engineDefaults: {}
        },
        jobs: [
          {
            id: "task-current",
            engine: "codex",
            status: "completed",
            title: "rescue via codex",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-engine",
            engine: "gemini",
            status: "completed",
            title: "rescue via gemini",
            jobClass: "task",
            sessionId: "sess-current",
            sessionRef: "gemini-session-123",
            summary: "Other engine",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "task-other-session",
            engine: "codex",
            status: "completed",
            title: "rescue via codex",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "task-resume-candidate", "--engine", "codex", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      [SESSION_ID_ENV]: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.engine, "codex");
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("status without a job id renders a compact table", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          defaultEngine: "codex",
          stopReviewGate: false,
          stopReviewGateEngine: "codex",
          engineDefaults: {}
        },
        jobs: [
          {
            id: "task-live",
            engine: "codex",
            kindLabel: "rescue",
            status: "running",
            title: "rescue via codex",
            jobClass: "task",
            phase: "running",
            threadId: "thr_live",
            summary: "Investigate flaky test",
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            engine: "gemini",
            kindLabel: "review",
            status: "completed",
            title: "review via gemini",
            jobClass: "review",
            sessionRef: "gemini-session-1",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Job \| Kind \| Engine \| Status \| Phase \| Time \| Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| task-live \| rescue \| codex \| running \| running \| .* \| thr_live \| Investigate flaky test \|/);
  assert.match(result.stdout, /`\/cc:status task-live`<br>`\/cc:cancel task-live`/);
  assert.match(result.stdout, /\| review-done \| review \| gemini \| completed \| done \| .* \| gemini-session-1 \| Review main\.\.\.HEAD \|/);
  assert.doesNotMatch(result.stdout, /Live details:/);
  assert.doesNotMatch(result.stdout, /Latest finished:/);
});

test("status --wait requires a job id", () => {
  const workspace = makeTempDir();

  const result = run(process.execPath, [SCRIPT, "status", "--wait"], {
    cwd: workspace
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /status --wait.*requires a job id/i);
});

test("status --wait on a single job times out cleanly in json mode", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          defaultEngine: "codex",
          stopReviewGate: false,
          stopReviewGateEngine: "codex",
          engineDefaults: {}
        },
        jobs: [
          {
            id: "task-live",
            engine: "codex",
            kindLabel: "rescue",
            status: "running",
            title: "rescue via codex",
            jobClass: "task",
            summary: "Investigate flaky test",
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const result = run(process.execPath, [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "running");
  assert.equal(payload.waitTimedOut, true);
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

test("cancel marks a running orchestration workflow and its active step as cancelled", async () => {
  const binDir = makeTempDir();
  const dataDir = makeTempDir();
  installFakeEngines(binDir);
  const repoDir = makeRepo();
  const planFile = writePlanFile({
    version: 1,
    title: "Cancelable workflow",
    task: "Fix the bug",
    steps: [
      {
        id: "implement",
        title: "Implement the fix",
        engine: "codex",
        assignmentSource: "auto",
        kind: "task",
        input: "{{workflow_task}}",
        options: {}
      }
    ]
  });

  const start = run(process.execPath, [SCRIPT, "orchestrate", "--plan-file", planFile, "--background"], {
    cwd: repoDir,
    env: {
      ...envFor(binDir, dataDir),
      FAKE_ENGINE_DELAY_MS: "1500"
    }
  });

  const match = start.stdout.match(/Started (orchestrate-[^) ]+)/);
  assert.ok(match, start.stdout);
  const jobId = match[1];

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: {
        ...envFor(binDir, dataDir),
        FAKE_ENGINE_DELAY_MS: "1500"
      }
    });
    if (status.status !== 0) {
      return false;
    }
    const parsed = JSON.parse(status.stdout);
    return parsed.job.steps?.[0]?.status === "running";
  });

  const cancel = run(process.execPath, [SCRIPT, "cancel", jobId], {
    cwd: repoDir,
    env: envFor(binDir, dataDir)
  });
  assert.equal(cancel.status, 0, cancel.stderr);
  assert.match(cancel.stdout, /Cancelled/);

  await waitFor(() => {
    const status = run(process.execPath, [SCRIPT, "status", jobId, "--json"], {
      cwd: repoDir,
      env: envFor(binDir, dataDir)
    });
    if (status.status !== 0) {
      return false;
    }
    const parsed = JSON.parse(status.stdout);
    return parsed.job.status === "cancelled" && parsed.job.steps?.[0]?.status === "cancelled";
  });
});
