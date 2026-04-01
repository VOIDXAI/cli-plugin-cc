#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getSessionRuntimeStatus } from "./lib/codex.mjs";
import {
  createEngineOwnerState,
  detectEngine,
  engineEventToProgress,
  getEngineInfo,
  findResumeCandidate,
  getEngineRuntimeCapabilities,
  interruptEngineJob,
  listSupportedEngines,
  normalizeEngine,
  startEngineRun
} from "./lib/engines.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  listResumeCandidates,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob
} from "./lib/job-control.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
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
import {
  normalizeTaskPermission,
  resolveConfiguredTaskPermission,
  formatTaskPermissionSummary
} from "./lib/permissions.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
function normalizeRequestedModel(engine, model) {
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
  const node = binaryAvailable("node", ["--version"], { cwd });
  const npm = binaryAvailable("npm", ["--version"], { cwd });
  const engines = [];

  for (const id of engineIds) {
    engines.push(await detectEngine(id, cwd));
  }

  const nextSteps = [];
  for (const engine of engines) {
    if (engine.id === "codex" && !engine.available && npm.available) {
      nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
    }
    if (engine.id === "codex" && engine.available && !engine.auth.loggedIn) {
      nextSteps.push("Run `!codex login`.");
      nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
    }
  }
  if (!config.stopReviewGate) {
    nextSteps.push(`Optional: run \`/cc:setup --engine ${requestedEngine} --enable-review-gate\` to require a fresh review before stop.`);
  }

  return {
    ready: node.available && engines.every((engine) => engine.available && engine.auth.loggedIn),
    node,
    npm,
    selectedEngine: options.all ? null : requestedEngine,
    engines,
    config,
    sessionRuntime: getSessionRuntimeStatus(process.env, workspaceRoot),
    nextSteps
  };
}

function resolveEngine(options, workspaceRoot) {
  return normalizeEngine(options.engine || getConfig(workspaceRoot).defaultEngine);
}

function getEngineDefaults(config, engine) {
  return config?.engineDefaults?.[engine] ?? {};
}

function emitWarning(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`Warning: ${message}\n`);
}

function resolveConfiguredEffort(engine, explicitEffort, defaultEffort = null, onWarning = null) {
  const normalizedExplicitEffort = normalizeReasoningEffort(explicitEffort);
  const normalizedDefaultEffort = normalizeReasoningEffort(defaultEffort);
  const resolvedEffort = normalizedExplicitEffort ?? normalizedDefaultEffort;
  const capabilities = getEngineRuntimeCapabilities(engine);

  if (resolvedEffort == null) {
    return null;
  }
  if (capabilities.effortControl === "native" || capabilities.effortControl === "mapped") {
    return resolvedEffort;
  }
  if (normalizedExplicitEffort != null) {
    onWarning?.(
      `${getEngineInfo(engine).label} does not support \`--effort\` in this plugin because its CLI does not expose a reasoning-effort flag. Ignoring it.`
    );
  }
  return null;
}

function applyEngineDefaults(engine, options, defaults = {}, onWarning = null) {
  return {
    ...options,
    model: normalizeRequestedModel(engine, options.model ?? defaults.model ?? null),
    effort: resolveConfiguredEffort(engine, options.effort, defaults.effort, onWarning)
  };
}

function applyTaskDefaults(engine, options, defaults = {}, onWarning = null) {
  const resolved = applyEngineDefaults(engine, options, defaults, onWarning);
  const permission = resolveConfiguredTaskPermission(engine, options.permission, defaults.permission);
  return {
    ...resolved,
    requestedPermission: permission.requestedPermission,
    permission: permission.resolvedPermission,
    permissionSource: permission.source,
    permissionNative: permission.nativeLabel
  };
}

function resolveBackground(options) {
  return Boolean(options.background) && !options.wait;
}

function createBaseJob({ workspaceRoot, cwd, engine, jobClass, title, kindLabel = null, extra = {} }) {
  const capabilities = getEngineRuntimeCapabilities(engine);
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
    capabilities,
    ownerState: createEngineOwnerState(engine, "queued"),
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
      model: normalizeRequestedModel(engine, options.model),
      effort: normalizeReasoningEffort(options.effort)
    }
  });
}

function createTaskJob({ workspaceRoot, cwd, engine, options, prompt, readOnly = false, jobClass = "task" }) {
  const semanticPermission = !readOnly && jobClass === "task" ? normalizeTaskPermission(options.permission) : null;
  const permissionSummary =
    !readOnly && jobClass === "task"
      ? formatTaskPermissionSummary({
          permission: semanticPermission,
          nativeLabel: options.permissionNative
        })
      : null;
  return createBaseJob({
    workspaceRoot,
    cwd,
    engine,
    jobClass,
    kindLabel: jobClass === "gate" ? "stop-gate" : "rescue",
    title: `${jobClass === "gate" ? "gate" : "rescue"} via ${engine}`,
    extra: {
      write: !readOnly && semanticPermission !== "read-only",
      readOnly,
      prompt,
      resume: Boolean(options.resume),
      resumeSessionRef: null,
      model: normalizeRequestedModel(engine, options.model),
      effort: normalizeReasoningEffort(options.effort),
      requestedPermission: !readOnly && jobClass === "task" ? normalizeTaskPermission(options.requestedPermission) : null,
      permission: semanticPermission,
      permissionSource: !readOnly && jobClass === "task" ? options.permissionSource ?? "legacy" : null,
      permissionNative: !readOnly && jobClass === "task" ? options.permissionNative ?? null : null,
      permissionSummary
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
  const previous = listResumeCandidates(workspaceRoot, engine, {
    all: false,
    excludeJobId: job.id
  })[0];
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
      const handle = startEngineRun(
        job.jobClass === "review" || job.jobClass === "adversarial-review"
          ? {
              engine: job.engine,
              kind: job.jobClass,
              cwd: job.workspaceRoot,
              scope: job.scope,
              baseRef: job.baseRef,
              focusText: job.focusText,
              model: job.model,
              effort: job.effort
            }
          : {
              engine: job.engine,
              kind: "task",
              cwd: job.workspaceRoot,
              prompt: job.prompt,
              resume: Boolean(job.resume),
              resumeSessionRef: job.resumeSessionRef ?? null,
              model: job.model,
              effort: job.effort,
              readOnly: Boolean(job.readOnly),
              permission: job.permission
            }
      );

      const pumpEvents = (async () => {
        for await (const event of handle.events()) {
          progressReporter?.(engineEventToProgress(event, job.engine));
        }
      })();

      let result;
      try {
        result = await handle.result();
      } finally {
        await pumpEvents;
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
        sessionRef: result.sessionRef ?? result.threadId ?? null,
        capabilities: handle.capabilities,
        ownerState: createEngineOwnerState(job.engine, result.ok ? "completed" : "failed", {
          sessionRef: result.sessionRef ?? result.threadId ?? null,
          threadId: result.threadId ?? null,
          turnId: result.turnId ?? null
        })
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

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine", "model", "effort", "permission"],
    booleanOptions: ["json", "all", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options.all && (options.model != null || options.effort != null || options.permission != null)) {
    throw new Error("Use --engine when setting default --model, --effort, or --permission.");
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

  if (options.model != null || options.effort != null || options.permission != null) {
    const normalizedEffort = resolveConfiguredEffort(setupEngine, options.effort, null, emitWarning);
    const normalizedPermission = normalizeTaskPermission(options.permission);
    const currentDefaults = getEngineDefaults(getConfig(workspaceRoot), setupEngine);
    setConfig(workspaceRoot, {
      engineDefaults: {
        ...(getConfig(workspaceRoot).engineDefaults ?? {}),
        [setupEngine]: {
          ...currentDefaults,
          ...(options.model != null ? { model: normalizeRequestedModel(setupEngine, options.model) } : {}),
          ...(options.effort != null ? { effort: normalizedEffort } : {}),
          ...(options.permission != null ? { permission: normalizedPermission } : {})
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
  const focusText = positionals.join(" ").trim();
  if (kind === "review" && focusText) {
    throw new Error(
      `\`/cc:review\` does not support custom focus text. Retry with \`/cc:adversarial-review --engine ${engine} ${focusText}\` for focused review instructions.`
    );
  }
  const resolvedOptions = applyEngineDefaults(engine, options, getEngineDefaults(getConfig(workspaceRoot), engine), emitWarning);
  const job = createReviewJob({
    workspaceRoot,
    cwd,
    engine,
    kind,
    options: resolvedOptions,
    focusText
  });

  if (resolveBackground(options)) {
    const pid = spawnBackgroundWorker(job);
    storeQueuedJob(job, pid);
    process.stdout.write(`Started ${job.id} in background (pid ${pid}).\n`);
    return;
  }

  const execution = await executeJob(job);
  process.exitCode = execution.exitStatus;
  outputResult(options.json ? execution.payload : execution.rendered, Boolean(options.json));
}

async function handleTask(argv, { jobClass = "task", readOnly = false } = {}) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine", "model", "effort", "permission"],
    booleanOptions: ["json", "background", "wait", "resume", "fresh"]
  });

  if (options.resume && options.fresh) {
    throw new Error("Choose either --resume or --fresh.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const engine = resolveEngine(options, workspaceRoot);
  const resolvedOptions = readOnly
    ? applyEngineDefaults(engine, options, getEngineDefaults(getConfig(workspaceRoot), engine), emitWarning)
    : applyTaskDefaults(engine, options, getEngineDefaults(getConfig(workspaceRoot), engine), emitWarning);
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
  process.exitCode = execution.exitStatus;
  outputResult(options.json ? execution.payload : execution.rendered, Boolean(options.json));
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? null;

  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"] ?? options["poll-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), Boolean(options.json));
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const snapshot = buildStatusSnapshot(cwd, { all: Boolean(options.all) });
  outputResult(options.json ? snapshot : renderStatusReport(snapshot), Boolean(options.json));
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engine"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const engine = normalizeEngine(options.engine || getConfig(workspaceRoot).defaultEngine);
  const candidates = listResumeCandidates(workspaceRoot, engine, {
    all: Boolean(options.all)
  });
  const payload = {
    available: candidates.length > 0,
    sessionId: process.env.CLI_PLUGIN_CC_SESSION_ID ?? null,
    engine,
    candidate: candidates[0] ?? null
  };
  outputResult(options.json ? payload : JSON.stringify(payload, null, 2), Boolean(options.json));
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
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
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
