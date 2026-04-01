import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { initGitRepo, makeTempDir, run, runWithHardTimeout } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "cli-cc", "scripts", "cli-companion.mjs");
const LIVE_TIMEOUT_MS = Number(process.env.CLI_PLUGIN_CC_LIVE_TIMEOUT_MS || "600000");
const LIVE_STATUS_WAIT_TIMEOUT_MS = Number(process.env.CLI_PLUGIN_CC_LIVE_STATUS_WAIT_TIMEOUT_MS || "420000");
const ENABLE_CANCEL_SMOKE = process.env.CLI_PLUGIN_CC_LIVE_CANCEL === "1";
const ENABLE_FULL_SMOKE = process.env.CLI_PLUGIN_CC_LIVE_FULL === "1";
const GEMINI_HARD_TIMEOUT_SECONDS = 600;
const GEMINI_HARD_TIMEOUT_GRACE_SECONDS = 15;
const DEFAULT_LIVE_MODELS = {
  gemini: "gemini-2.5-flash-lite"
};

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

function requestedEngines() {
  const raw = process.env.CLI_PLUGIN_CC_LIVE_ENGINES;
  if (!raw?.trim()) {
    return null;
  }
  return new Set(
    raw
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  );
}

function liveEnv(dataDir) {
  return {
    ...process.env,
    CLI_PLUGIN_CC_DATA_DIR: dataDir
  };
}

function runCompanion(args, { cwd, dataDir, timeout = LIVE_TIMEOUT_MS, engineId = null } = {}) {
  const runArgs = [SCRIPT, ...args];
  const options = {
    cwd,
    env: liveEnv(dataDir),
    timeout
  };
  if (engineId === "gemini") {
    return runWithHardTimeout(process.execPath, runArgs, {
      ...options,
      hardTimeoutSeconds: GEMINI_HARD_TIMEOUT_SECONDS,
      killAfterSeconds: GEMINI_HARD_TIMEOUT_GRACE_SECONDS
    });
  }
  return run(process.execPath, runArgs, options);
}

function liveModelFor(engineId) {
  if (engineId === "gemini") {
    return DEFAULT_LIVE_MODELS.gemini;
  }
  const key = `CLI_PLUGIN_CC_LIVE_${engineId.toUpperCase()}_MODEL`;
  const value = process.env[key];
  if (value?.trim()) {
    return value.trim();
  }
  return DEFAULT_LIVE_MODELS[engineId] ?? null;
}

function appendModel(args, engineId) {
  const model = liveModelFor(engineId);
  return model ? [...args, "--model", model] : args;
}

function parseStartedJobId(stdout) {
  return stdout.match(/Started ([^\s]+) in background/)?.[1] ?? null;
}

function skipReason(engineReport) {
  if (!engineReport) {
    return "engine was not reported by /cc:setup --all";
  }
  if (!engineReport.available) {
    return `${engineReport.id} is not installed or not on PATH`;
  }
  if (!engineReport.auth?.loggedIn) {
    return `${engineReport.id} is available but not authenticated`;
  }
  return null;
}

function isTransientProviderFailure(result) {
  const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
  return (
    /rateLimitExceeded/i.test(combined) ||
    /RESOURCE_EXHAUSTED/i.test(combined) ||
    /MODEL_CAPACITY_EXHAUSTED/i.test(combined) ||
    /No capacity available for model/i.test(combined)
  );
}

function formatResult(result) {
  return `exit:\nstatus=${result.status ?? "(null)"} signal=${result.signal ?? "(null)"}\nstdout:\n${result.stdout || "(empty)"}\nstderr:\n${result.stderr || "(empty)"}`;
}

function maybeTransientFailure(engineId, stage, result) {
  if (!isTransientProviderFailure(result)) {
    return null;
  }
  const model = liveModelFor(engineId);
  const modelHint = model
    ? `The live smoke used model ${model}.`
    : `Set CLI_PLUGIN_CC_LIVE_${engineId.toUpperCase()}_MODEL to a stable model if you want this engine included in smoke tests.`;
  return `${engineId} ${stage} hit a transient provider/model-capacity failure. ${modelHint}\n${formatResult(result)}`;
}

function assertSucceeded(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label}\n${formatResult(result)}`);
  }
}

async function runEngineSmoke(engineId) {
  const repoDir = makeRepo();
  const dataDir = makeTempDir();
  const runEngineCompanion = (args, options = {}) =>
    runCompanion(args, {
      cwd: repoDir,
      dataDir,
      engineId,
      ...options
    });

  const review = runEngineCompanion(appendModel(["review", "--engine", engineId], engineId));
  const reviewTransient = maybeTransientFailure(engineId, "review", review);
  if (reviewTransient) {
    return { status: "skipped", reason: reviewTransient };
  }
  assertSucceeded(review, `${engineId} review`);
  if (!new RegExp(`# Review \\(${engineId}\\)`).test(review.stdout)) {
    throw new Error(`${engineId} review did not render the expected header.\n${formatResult(review)}`);
  }

  if (ENABLE_FULL_SMOKE) {
    const adversarial = runEngineCompanion(
      appendModel(["adversarial-review", "--engine", engineId, "challenge", "the", "chosen", "approach"], engineId)
    );
    const adversarialTransient = maybeTransientFailure(engineId, "adversarial review", adversarial);
    if (adversarialTransient) {
      return { status: "skipped", reason: adversarialTransient };
    }
    assertSucceeded(adversarial, `${engineId} adversarial review`);
    if (!new RegExp(`# Adversarial Review \\(${engineId}\\)`).test(adversarial.stdout)) {
      throw new Error(`${engineId} adversarial review did not render the expected header.\n${formatResult(adversarial)}`);
    }
  }

  const task = runEngineCompanion(
    appendModel(["task", "--engine", engineId, "Inspect", "the", "repo", "briefly", "and", "summarize", "what", "changed."], engineId)
  );
  const taskTransient = maybeTransientFailure(engineId, "task", task);
  if (taskTransient) {
    return { status: "skipped", reason: taskTransient };
  }
  assertSucceeded(task, `${engineId} foreground task`);

  const resumed = runEngineCompanion(
    appendModel(
      ["task", "--engine", engineId, "--resume", "Continue", "from", "the", "current", "thread", "and", "summarize", "the", "state."],
      engineId
    )
  );
  const resumedTransient = maybeTransientFailure(engineId, "resumed task", resumed);
  if (resumedTransient) {
    return { status: "skipped", reason: resumedTransient };
  }
  assertSucceeded(resumed, `${engineId} resumed task`);

  const background = runEngineCompanion(
    appendModel(["task", "--engine", engineId, "--background", "Inspect", "the", "repo", "and", "reply", "with", "a", "short", "summary."], engineId)
  );
  const backgroundTransient = maybeTransientFailure(engineId, "background task start", background);
  if (backgroundTransient) {
    return { status: "skipped", reason: backgroundTransient };
  }
  assertSucceeded(background, `${engineId} background task start`);
  const backgroundJobId = parseStartedJobId(background.stdout);
  if (!backgroundJobId) {
    throw new Error(`${engineId} background task did not return a job id.\n${formatResult(background)}`);
  }

  const waited = runEngineCompanion(
    ["status", backgroundJobId, "--wait", "--timeout-ms", String(LIVE_STATUS_WAIT_TIMEOUT_MS), "--json"],
    {
      timeout: LIVE_STATUS_WAIT_TIMEOUT_MS + 60000
    }
  );
  assertSucceeded(waited, `${engineId} status --wait`);
  const waitedPayload = JSON.parse(waited.stdout);
  if (waitedPayload.job?.id !== backgroundJobId || waitedPayload.job?.status !== "completed") {
    throw new Error(`${engineId} background job did not complete cleanly.\n${waited.stdout}`);
  }

  const result = runEngineCompanion(["result", backgroundJobId]);
  assertSucceeded(result, `${engineId} result`);

  if (ENABLE_CANCEL_SMOKE) {
    const cancellable = runEngineCompanion(
      appendModel(
        [
          "task",
          "--engine",
          engineId,
          "--background",
          "Spend",
          "several",
          "minutes",
          "carefully",
          "inspecting",
          "the",
          "repo",
          "before",
          "replying."
        ],
        engineId
      )
    );
    const cancelTransient = maybeTransientFailure(engineId, "cancel smoke start", cancellable);
    if (cancelTransient) {
      return { status: "skipped", reason: cancelTransient };
    }
    assertSucceeded(cancellable, `${engineId} cancel smoke start`);
    const cancelJobId = parseStartedJobId(cancellable.stdout);
    if (!cancelJobId) {
      throw new Error(`${engineId} cancel smoke did not return a job id.\n${formatResult(cancellable)}`);
    }

    const cancel = runEngineCompanion(["cancel", cancelJobId]);
    assertSucceeded(cancel, `${engineId} cancel`);

    const cancelledStatus = runEngineCompanion(["status", cancelJobId, "--json"]);
    assertSucceeded(cancelledStatus, `${engineId} cancelled status`);
    const cancelledPayload = JSON.parse(cancelledStatus.stdout);
    if (cancelledPayload.job?.status !== "cancelled") {
      throw new Error(`${engineId} cancel smoke did not end in cancelled state.\n${cancelledStatus.stdout}`);
    }
  }

  return { status: "passed" };
}

async function main() {
  console.log("# cli-plugin-cc live smoke");
  console.log("");

  const filter = requestedEngines();
  const setupDataDir = makeTempDir();
  const setup = runCompanion(["setup", "--all", "--json"], {
    cwd: ROOT,
    dataDir: setupDataDir,
    timeout: 120000
  });
  assertSucceeded(setup, "live setup --all");

  const report = JSON.parse(setup.stdout);
  const engines = new Map((report.engines ?? []).map((engine) => [engine.id, engine]));
  const targetIds = filter ? [...filter] : [...engines.keys()];
  const summary = {
    passed: 0,
    skipped: 0,
    failed: 0
  };

  console.log(`Requested engines: ${targetIds.length ? targetIds.join(", ") : "(none)"}`);
  console.log(`Full smoke: ${ENABLE_FULL_SMOKE ? "yes" : "no"}`);
  console.log(`Cancel smoke: ${ENABLE_CANCEL_SMOKE ? "yes" : "no"}`);
  console.log("");

  if (targetIds.length === 0) {
    console.log("No live engines requested.");
    return;
  }

  for (const engineId of targetIds) {
    const engine = engines.get(engineId);
    const reason = skipReason(engine);
    if (reason) {
      summary.skipped += 1;
      console.log(`SKIP ${engineId}: ${reason}`);
      continue;
    }

    console.log(`RUN  ${engineId}`);
    try {
      const result = await runEngineSmoke(engineId);
      if (result.status === "skipped") {
        summary.skipped += 1;
        console.log(`SKIP ${engineId}: ${result.reason}`);
        continue;
      }
      summary.passed += 1;
      console.log(`PASS ${engineId}`);
    } catch (error) {
      summary.failed += 1;
      console.log(`FAIL ${engineId}: ${error.message || error}`);
    }
    console.log("");
  }

  console.log("Summary:");
  console.log(`- passed: ${summary.passed}`);
  console.log(`- skipped: ${summary.skipped}`);
  console.log(`- failed: ${summary.failed}`);

  if (summary.failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
