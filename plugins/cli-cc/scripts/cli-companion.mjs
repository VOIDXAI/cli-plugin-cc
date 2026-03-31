#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getSessionRuntimeStatus } from "./lib/codex.mjs";
import {
  detectEngine,
  findResumeCandidate,
  interruptEngineJob,
  listSupportedEngines,
  normalizeEngine,
  runReview,
  runTask
} from "./lib/engines.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  generateJobId,
  getConfig,
  readJob,
  resolveJobFile,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderCancelReport,
  renderJobStatusReport,
  renderReview,
  renderSetup,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult
} from "./lib/render.mjs";
import {
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return normalized;
}

function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`);
  }
  return normalized;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function firstMeaningfulLine(text, fallback = "") {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

function outputResult(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(String(value));
}

async function buildSetupReport(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const requestedEngine = normalizeEngine(options.engine || config.defaultEngine);
  const engineIds = options.all ? listSupportedEngines().map((engine) => engine.id) : [requestedEngine];
  const engines = [];

  for (const id of engineIds) {
    engines.push(await detectEngine(id, cwd));
  }

  return {
    engines,
    config,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot)
  };
}

function resolveEngine(options, workspaceRoot) {
  return normalizeEngine(options.engine || getConfig(workspaceRoot).defaultEngine);
}

function getEngineDefaults(config, engine) {
  return config?.engineDefaults?.[engine] ?? {};
}

function applyEngineDefaults(options, defaults = {}) {
  return {
    ...options,
    model: options.model ?? defaults.model ?? null,
    effort: options.effort ?? defaults.effort ?? null
  };
}

function resolveBackground(options) {
  return Boolean(options.background) && !options.wait;
}

function createBaseJob({ workspaceRoot, cwd, engine, jobClass, title, kindLabel = null, extra = {} }) {
  const id = generateJobId(jobClass === "adversarial-review" ? "adv-review" : jobClass === "task" ? "task" : jobClass);
  const logFile = createJobLogFile(workspaceRoot, id, title);
  return createJobRecord({
    id,
    workspaceRoot,
    cwd,
    engine,
    jobClass,
    kindLabel,
    title,
    status: "queued",
    phase: "queued",
    logFile,
    pid: null,
    ...extra
  });
}

function createReviewJob({ workspaceRoot, cwd, engine, kind, options, focusText }) {
  return createBaseJob({
    workspaceRoot,
    cwd,
    engine,
    jobClass: kind,
    kindLabel: kind,
    title: `${kind} via ${engine}`,
    extra: {
      scope: options.scope || "auto",
      baseRef: options.base ?? null,
      focusText: focusText || null,
      model: normalizeRequestedModel(options.model),
      effort: normalizeReasoningEffort(options.effort)
    }
  });
}

function createTaskJob({ workspaceRoot, cwd, engine, options, prompt, readOnly = false, jobClass = "task" }) {
  return createBaseJob({
    workspaceRoot,
    cwd,
    engine,
    jobClass,
    kindLabel: jobClass === "gate" ? "stop-gate" : "rescue",
    title: `${jobClass === "gate" ? "gate" : "rescue"} via ${engine}`,
    extra: {
      write: !readOnly,
      readOnly,
      prompt,
      resume: Boolean(options.resume),
      resumeSessionRef: null,
      model: normalizeRequestedModel(options.model),
      effort: normalizeReasoningEffort(options.effort)
    }
  });
}

async function maybePopulateResumeSession(job) {
  if (!job.resume) {
    return job;
  }

  const workspaceRoot = job.workspaceRoot;
  const config = getConfig(workspaceRoot);
  const engine = job.engine || config.defaultEngine;
  const existingJobs = buildStatusSnapshot(workspaceRoot, { all: true }).running
    .concat(buildStatusSnapshot(workspaceRoot, { all: true }).recent)
    .concat(buildStatusSnapshot(workspaceRoot, { all: true }).latestFinished ? [buildStatusSnapshot(workspaceRoot, { all: true }).latestFinished] : []);
  const previous = existingJobs.find(
    (entry) => entry.id !== job.id && entry.engine === engine && entry.jobClass === "task" && (entry.sessionRef || entry.threadId)
  );
  if (previous) {
    return {
      ...job,
      resumeSessionRef: previous.sessionRef ?? previous.threadId
    };
  }

  if (engine === "codex") {
    const latestThread = await findResumeCandidate(engine, workspaceRoot);
    if (latestThread?.id) {
      return {
        ...job,
        resumeSessionRef: latestThread.id
      };
    }
  }

  return job;
}

async function executeJob(job) {
  const progressUpdater = createJobProgressUpdater(job.workspaceRoot, job.id);
  const progressReporter = createProgressReporter({
    logFile: job.logFile,
    onEvent: progressUpdater
  });

  return runTrackedJob(
    job,
    async () => {
      let result;
      if (job.jobClass === "review" || job.jobClass === "adversarial-review") {
        result = await runReview({
          engine: job.engine,
          kind: job.jobClass,
          cwd: job.workspaceRoot,
          scope: job.scope,
          baseRef: job.baseRef,
          focusText: job.focusText,
          model: job.model,
          effort: job.effort,
          onProgress: progressReporter
        });
      } else {
        result = await runTask({
          engine: job.engine,
          cwd: job.workspaceRoot,
          prompt: job.prompt,
          resume: Boolean(job.resume),
          resumeSessionRef: job.resumeSessionRef ?? null,
          model: job.model,
          effort: job.effort,
          readOnly: Boolean(job.readOnly),
          onProgress: progressReporter
        });
      }

      const rendered =
        job.jobClass === "review" || job.jobClass === "adversarial-review"
          ? renderReview(result, job)
          : job.jobClass === "gate"
            ? `${result.finalText ?? ""}\n`
            : renderTaskResult(result, job);

      return {
        exitStatus: result.ok ? 0 : 1,
        payload: result,
        rendered,
        summary:
          result.structured?.summary ??
          firstMeaningfulLine(result.finalText, `${job.title} ${result.ok ? "completed" : "failed"}.`),
        threadId: result.threadId ?? null,
        turnId: result.turnId ?? null,
        sessionRef: result.sessionRef ?? result.threadId ?? null
      };
    },
    {
      logFile: job.logFile
    }
  );
}

function storeQueuedJob(job, pid = null) {
  const queuedJob = {
    ...job,
    status: "queued",
    phase: "queued",
    pid
  };
  writeJobFile(job.workspaceRoot, job.id, queuedJob);
  upsertJob(job.workspaceRoot, queuedJob);
  return queuedJob;
}

function spawnBackgroundWorker(job) {
  const child = spawn(process.execPath, [SCRIPT_PATH, "__run-job", job.id, "--cwd", job.workspaceRoot], {
    cwd: job.workspaceRoot,
    env: { ...process.env, CLI_PLUGIN_CC_CWD: job.workspaceRoot },
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  return child.pid ?? null;
}

async function waitForJobCompletion(cwd, reference, options = {}) {
  const timeoutMs =
    options.timeoutMs == null ? DEFAULT_STATUS_WAIT_TIMEOUT_MS : Math.max(1000, Number.parseInt(options.timeoutMs, 10) || 0);
  const pollMs =
    options.pollMs == null ? DEFAULT_STATUS_POLL_INTERVAL_MS : Math.max(250, Number.parseInt(options.pollMs, 10) || 0);
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    if (reference) {
      const snapshot = buildSingleJobSnapshot(cwd, reference);
      if (snapshot.job.status !== "queued" && snapshot.job.status !== "running") {
        return snapshot;
      }
    } else {
      const snapshot = buildStatusSnapshot(cwd, { all: options.all });
      if (snapshot.running.length === 0) {
        return snapshot;
      }
    }
    await sleep(pollMs);
  }

  throw new Error(`Timed out waiting for job completion after ${Math.round(timeoutMs / 1000)}s.`);
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine", "model", "effort"],
    booleanOptions: ["json", "all", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options.all && (options.model != null || options.effort != null)) {
    throw new Error("Use --engine when setting default --model or --effort.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const gateEngine = resolveEngine(options, workspaceRoot);
  const setupEngine = resolveEngine({ ...options, engine: options.engine || config.defaultEngine }, workspaceRoot);

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, {
      stopReviewGate: true,
      stopReviewGateEngine: gateEngine
    });
  }

  if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, { stopReviewGate: false });
  }

  if (options.model != null || options.effort != null) {
    const currentDefaults = getEngineDefaults(getConfig(workspaceRoot), setupEngine);
    setConfig(workspaceRoot, {
      engineDefaults: {
        ...(getConfig(workspaceRoot).engineDefaults ?? {}),
        [setupEngine]: {
          ...currentDefaults,
          ...(options.model != null ? { model: normalizeRequestedModel(options.model) } : {}),
          ...(options.effort != null ? { effort: normalizeReasoningEffort(options.effort) } : {})
        }
      }
    });
  }

  const report = await buildSetupReport(cwd, options);
  outputResult(options.json ? report : renderSetup(report), Boolean(options.json));
}

async function handleReview(argv, kind) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine", "model", "effort", "scope", "base"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const engine = resolveEngine(options, workspaceRoot);
  const resolvedOptions = applyEngineDefaults(options, getEngineDefaults(getConfig(workspaceRoot), engine));
  const job = createReviewJob({
    workspaceRoot,
    cwd,
    engine,
    kind,
    options: resolvedOptions,
    focusText: positionals.join(" ").trim()
  });

  if (resolveBackground(options)) {
    const pid = spawnBackgroundWorker(job);
    storeQueuedJob(job, pid);
    process.stdout.write(`Started ${job.id} in background (pid ${pid}).\n`);
    return;
  }

  const execution = await executeJob(job);
  outputResult(options.json ? execution.payload : execution.rendered, Boolean(options.json));
}

async function handleTask(argv, { jobClass = "task", readOnly = false } = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine", "model", "effort"],
    booleanOptions: ["json", "background", "wait", "resume", "fresh"]
  });

  if (options.resume && options.fresh) {
    throw new Error("Choose either --resume or --fresh.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const engine = resolveEngine(options, workspaceRoot);
  const resolvedOptions = applyEngineDefaults(options, getEngineDefaults(getConfig(workspaceRoot), engine));
  let job = createTaskJob({
    workspaceRoot,
    cwd,
    engine,
    options: resolvedOptions,
    prompt: positionals.join(" ").trim(),
    readOnly,
    jobClass
  });

  job = await maybePopulateResumeSession(job);

  if (resolveBackground(options)) {
    const pid = spawnBackgroundWorker(job);
    storeQueuedJob(job, pid);
    process.stdout.write(`Started ${job.id} in background (pid ${pid}).\n`);
    return;
  }

  const execution = await executeJob(job);
  outputResult(options.json ? execution.payload : execution.rendered, Boolean(options.json));
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? null;

  const snapshot = options.wait
    ? await waitForJobCompletion(cwd, reference, {
        all: Boolean(options.all),
        timeoutMs: options["timeout-ms"],
        pollMs: options["poll-ms"]
      })
    : reference
      ? buildSingleJobSnapshot(cwd, reference)
      : buildStatusSnapshot(cwd, { all: Boolean(options.all) });

  if ("job" in snapshot) {
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), Boolean(options.json));
    return;
  }

  outputResult(options.json ? snapshot : renderStatusReport(snapshot), Boolean(options.json));
}

async function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? null, {
    all: Boolean(options.all)
  });
  const storedJob = readStoredJob(workspaceRoot, job.id);
  outputResult(options.json ? storedJob ?? { job } : renderStoredJobResult(job, storedJob), Boolean(options.json));
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveCancelableJob(cwd, positionals[0] ?? null);
  let interruptDetail = null;

  if (job.status === "running") {
    try {
      interruptDetail = await interruptEngineJob(workspaceRoot, job);
    } catch {
      interruptDetail = null;
    }
  }

  if (job.pid) {
    try {
      terminateProcessTree(job.pid);
    } catch {
      // Ignore stale pids.
    }
  }

  const completedAt = nowIso();
  const cancelledJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    note: "Cancelled by user."
  };
  upsertJob(workspaceRoot, cancelledJob);
  const storedPath = resolveJobFile(workspaceRoot, job.id);
  if (fs.existsSync(storedPath)) {
    const storedJob = readStoredJob(workspaceRoot, job.id) ?? {};
    writeJobFile(workspaceRoot, job.id, {
      ...storedJob,
      ...cancelledJob
    });
  }

  outputResult(options.json ? cancelledJob : renderCancelReport(cancelledJob, interruptDetail), Boolean(options.json));
}

async function runBackgroundWorker(jobId, argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"]
  });
  const cwd = process.env.CLI_PLUGIN_CC_CWD || resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const job = readJob(workspaceRoot, jobId);
  if (!job) {
    process.exit(1);
  }

  const execution = await executeJob({
    ...job,
    workspaceRoot
  });
  if (execution.exitStatus !== 0) {
    process.exit(execution.exitStatus);
  }
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command) {
    throw new Error("Missing command.");
  }

  switch (command) {
    case "__run-job":
      await runBackgroundWorker(argv[0], argv.slice(1));
      return;
    case "setup":
      await handleSetup(argv);
      return;
    case "review":
      await handleReview(argv, "review");
      return;
    case "adversarial-review":
      await handleReview(argv, "adversarial-review");
      return;
    case "task":
      await handleTask(argv);
      return;
    case "gate":
      await handleTask(argv, { jobClass: "gate", readOnly: true });
      return;
    case "status":
      await handleStatus(argv);
      return;
    case "result":
      await handleResult(argv);
      return;
    case "cancel":
      await handleCancel(argv);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
