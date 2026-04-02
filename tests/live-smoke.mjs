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
const ENGINE_BIN_ENV = {
  codex: "CLI_PLUGIN_CC_CODEX_BIN",
  gemini: "CLI_PLUGIN_CC_GEMINI_BIN",
  droid: "CLI_PLUGIN_CC_DROID_BIN"
};
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

function buildDisabledEngineEnv(allowedEngineIds = null) {
  if (!Array.isArray(allowedEngineIds) || allowedEngineIds.length === 0) {
    return {};
  }

  const allowed = new Set(allowedEngineIds);
  const overrides = {};
  for (const [engineId, envKey] of Object.entries(ENGINE_BIN_ENV)) {
    if (!allowed.has(engineId)) {
      overrides[envKey] = `__cli_plugin_cc_disabled_${engineId}__`;
    }
  }
  return overrides;
}

function liveEnv(dataDir, allowedEngineIds = null) {
  return {
    ...process.env,
    CLI_PLUGIN_CC_DATA_DIR: dataDir,
    ...buildDisabledEngineEnv(allowedEngineIds)
  };
}

function runCompanion(args, { cwd, dataDir, timeout = LIVE_TIMEOUT_MS, engineId = null, allowedEngineIds = null } = {}) {
  const runArgs = [SCRIPT, ...args];
  const options = {
    cwd,
    env: liveEnv(dataDir, allowedEngineIds),
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

function assertStdoutMatches(result, pattern, label) {
  if (!pattern.test(result.stdout || "")) {
    throw new Error(`${label}\n${formatResult(result)}`);
  }
}

function parseRenderedEngineId(stdout) {
  return stdout.match(/^# [^(]+\(([^)]+)\)/m)?.[1] ?? null;
}

function preferredAutoReviewEngine(engineIds) {
  for (const candidate of ["gemini", "droid", "codex"]) {
    if (engineIds.includes(candidate)) {
      return candidate;
    }
  }
  return engineIds[0] ?? null;
}

function preferredAutoTaskEngine(engineIds) {
  for (const candidate of ["droid", "codex", "gemini"]) {
    if (engineIds.includes(candidate)) {
      return candidate;
    }
  }
  return engineIds[0] ?? null;
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

function configureLiveDefaults(runRepoCompanion, engineIds) {
  for (const engineId of engineIds) {
    const model = liveModelFor(engineId);
    if (!model) {
      continue;
    }
    const setup = runRepoCompanion(["setup", "--engine", engineId, "--model", model], {
      engineId,
      timeout: 120000
    });
    assertSucceeded(setup, `${engineId} live default model setup`);
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
      allowedEngineIds: [engineId],
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
  const replay = runEngineCompanion(["replay", backgroundJobId]);
  assertSucceeded(replay, `${engineId} replay`);
  assertStdoutMatches(replay, /# cli-plugin-cc replay/, `${engineId} replay header`);
  assertStdoutMatches(replay, new RegExp(`Job: ${backgroundJobId}`), `${engineId} replay job id`);

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

async function runSharedFeatureSmoke(readyEngineIds) {
  const repoDir = makeRepo();
  const dataDir = makeTempDir();
  const runRepoCompanion = (args, options = {}) =>
    runCompanion(args, {
      cwd: repoDir,
      dataDir,
      allowedEngineIds: readyEngineIds,
      ...options
    });

  configureLiveDefaults(runRepoCompanion, readyEngineIds);

  const matrixEngineIds = readyEngineIds.slice(0, Math.min(readyEngineIds.length, 3));
  const policy = runRepoCompanion([
    "policy",
    "--set",
    "speed-first",
    "--prefer-auto",
    "--matrix-engines",
    matrixEngineIds.join(",")
  ]);
  assertSucceeded(policy, "shared feature smoke policy");
  assertStdoutMatches(policy, /# cli-plugin-cc policy/, "shared feature smoke policy header");
  assertStdoutMatches(policy, /Auto routing by default: enabled/, "shared feature smoke policy enablement");
  if (matrixEngineIds.length > 0) {
    assertStdoutMatches(
      policy,
      new RegExp(`Matrix review engines: ${matrixEngineIds.join(", ")}`),
      "shared feature smoke matrix engine config"
    );
  }

  const autoReviewEngine = preferredAutoReviewEngine(readyEngineIds);
  const autoReview = runRepoCompanion(["review", "--engine", "auto"], {
    engineId: autoReviewEngine
  });
  const autoReviewTransient = maybeTransientFailure(autoReviewEngine, "auto review", autoReview);
  if (autoReviewTransient) {
    return { status: "skipped", reason: autoReviewTransient };
  }
  assertSucceeded(autoReview, "shared feature smoke auto review");
  assertStdoutMatches(autoReview, /^# Review \([^)]+\)/m, "shared feature smoke auto review header");
  assertStdoutMatches(autoReview, /Requested engine: auto/, "shared feature smoke auto review routing");
  assertStdoutMatches(autoReview, /Policy: speed-first/, "shared feature smoke auto review policy");
  const renderedReviewEngine = parseRenderedEngineId(autoReview.stdout);
  if (!renderedReviewEngine || !readyEngineIds.includes(renderedReviewEngine)) {
    throw new Error(`shared feature smoke auto review selected unexpected engine.\n${formatResult(autoReview)}`);
  }

  const autoTaskEngine = preferredAutoTaskEngine(readyEngineIds);
  const autoTask = runRepoCompanion(["task", "Summarize", "the", "current", "repository", "state", "briefly."], {
    engineId: autoTaskEngine
  });
  const autoTaskTransient = maybeTransientFailure(autoTaskEngine, "auto task", autoTask);
  if (autoTaskTransient) {
    return { status: "skipped", reason: autoTaskTransient };
  }
  assertSucceeded(autoTask, "shared feature smoke auto task");
  assertStdoutMatches(autoTask, /^# Rescue Result \([^)]+\)/m, "shared feature smoke auto task header");
  assertStdoutMatches(autoTask, /Requested engine: auto/, "shared feature smoke auto task routing");
  assertStdoutMatches(autoTask, /Policy: speed-first/, "shared feature smoke auto task policy");
  const renderedTaskEngine = parseRenderedEngineId(autoTask.stdout);
  if (!renderedTaskEngine || !readyEngineIds.includes(renderedTaskEngine)) {
    throw new Error(`shared feature smoke auto task selected unexpected engine.\n${formatResult(autoTask)}`);
  }

  if (matrixEngineIds.length >= 2) {
    const matrixDriverEngine = matrixEngineIds.includes("gemini") ? "gemini" : matrixEngineIds[0];
    const matrix = runRepoCompanion(["matrix-review", "Challenge", "the", "current", "change", "and", "look", "for", "risks."], {
      engineId: matrixDriverEngine
    });
    const matrixTransient = maybeTransientFailure(matrixDriverEngine, "matrix review", matrix);
    if (matrixTransient) {
      return { status: "skipped", reason: matrixTransient };
    }
    assertSucceeded(matrix, "shared feature smoke matrix review");
    assertStdoutMatches(matrix, /^# Matrix Review/m, "shared feature smoke matrix review header");
    for (const engineId of matrixEngineIds) {
      assertStdoutMatches(
        matrix,
        new RegExp(`## Reviewer \\d+: ${engineId}`),
        `shared feature smoke matrix reviewer ${engineId}`
      );
    }

    const matrixResult = runRepoCompanion(["result"]);
    assertSucceeded(matrixResult, "shared feature smoke matrix result");
    assertStdoutMatches(matrixResult, /^# Matrix Review/m, "shared feature smoke matrix result header");

    const matrixReplay = runRepoCompanion(["replay"]);
    assertSucceeded(matrixReplay, "shared feature smoke matrix replay");
    assertStdoutMatches(matrixReplay, /# cli-plugin-cc replay/, "shared feature smoke matrix replay header");
    assertStdoutMatches(matrixReplay, /Kind: matrix-review/, "shared feature smoke matrix replay kind");
  }

  const memory = runRepoCompanion(["memory"]);
  assertSucceeded(memory, "shared feature smoke memory");
  assertStdoutMatches(memory, /# cli-plugin-cc memory/, "shared feature smoke memory header");
  assertStdoutMatches(memory, /Jobs tracked:/, "shared feature smoke memory jobs");
  assertStdoutMatches(memory, /Auto-routing history:/, "shared feature smoke memory auto routing");

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
    allowedEngineIds: filter ? [...filter] : null,
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

  const readyEngineIds = targetIds.filter((engineId) => !skipReason(engines.get(engineId)));
  if (readyEngineIds.length > 0) {
    console.log(`RUN  shared-features (${readyEngineIds.join(", ")})`);
    try {
      const result = await runSharedFeatureSmoke(readyEngineIds);
      if (result.status === "skipped") {
        summary.skipped += 1;
        console.log(`SKIP shared-features: ${result.reason}`);
      } else {
        summary.passed += 1;
        console.log("PASS shared-features");
      }
    } catch (error) {
      summary.failed += 1;
      console.log(`FAIL shared-features: ${error.message || error}`);
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
