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
  readWorkflowPlanFile,
  normalizeWorkflowPlan,
  interpolateWorkflowTemplate
} from "./lib/orchestration.mjs";
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
  appendLogBlock,
  appendLogLine,
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
const WORKFLOW_STEP_OUTPUT_MAX_CHARS = 12000;
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

function cloneJson(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function createWorkflowStepRecord(step, index) {
  return {
    index: index + 1,
    id: step.id,
    title: step.title,
    engine: step.engine,
    assignmentSource: step.assignmentSource,
    kind: step.kind,
    input: step.input ?? null,
    options: step.options ?? {},
    resolvedInput: null,
    status: "pending",
    phase: "pending",
    summary: null,
    sessionRef: null,
    threadId: null,
    turnId: null,
    startedAt: null,
    completedAt: null,
    model: null,
    effort: null,
    permission: null,
    permissionNative: null,
    permissionSource: null,
    ownerState: createEngineOwnerState(step.engine, "queued"),
    rendered: null,
    output: null,
    result: null
  };
}

function createOrchestrateJob({ workspaceRoot, cwd, plan }) {
  return createBaseJob({
    workspaceRoot,
    cwd,
    engine: "multi",
    jobClass: "orchestrate",
    kindLabel: "orchestrate",
    title: plan.title,
    extra: {
      workflow: plan,
      totalSteps: plan.steps.length,
      currentStepIndex: null,
      currentStepId: null,
      steps: plan.steps.map((step, index) => createWorkflowStepRecord(step, index)),
      summary: `Queued ${plan.steps.length}-step workflow.`,
      lastCompletedStepIndex: null
    }
  });
}

function workflowStepLabel(step, index, totalSteps) {
  return `Step ${index + 1}/${totalSteps}: ${step.title}`;
}

function workflowRunningPhase(index, totalSteps, phase = "running") {
  return `step ${index + 1}/${totalSteps} ${phase}`;
}

function updateWorkflowJobState(workspaceRoot, jobId, mutate) {
  const existing = readStoredJob(workspaceRoot, jobId) ?? readJob(workspaceRoot, jobId);
  if (!existing) {
    throw new Error(`Workflow job ${jobId} could not be loaded from state.`);
  }

  const next = cloneJson(existing);
  mutate(next);
  next.updatedAt = nowIso();
  writeJobFile(workspaceRoot, jobId, next);
  upsertJob(workspaceRoot, next);
  return next;
}

function buildWorkflowInterpolationContext(workflowJob) {
  const steps = {};
  for (const step of workflowJob.steps ?? []) {
    steps[step.id] = {
      summary: step.summary ?? "",
      output: step.output ?? ""
    };
  }
  return {
    workflowTask: workflowJob.workflow?.task ?? "",
    steps
  };
}

async function assertWorkflowEnginesReady(plan, cwd) {
  const engines = [...new Set(plan.steps.map((step) => step.engine))];
  for (const engine of engines) {
    const detected = await detectEngine(engine, cwd);
    if (!detected.available) {
      throw new Error(`${detected.label} is not installed or not on PATH. Run /cc:setup --engine ${engine} first.`);
    }
    if (!detected.auth?.loggedIn) {
      throw new Error(
        `${detected.label} is available but not authenticated. ${detected.auth?.detail ?? `Run /cc:setup --engine ${engine} for guidance.`}`
      );
    }
  }
}

function buildWorkflowStepExecutionJob({ workflowJob, step, resolvedInput, resolvedOptions }) {
  if (step.kind === "task") {
    const semanticPermission = normalizeTaskPermission(resolvedOptions.permission);
    return {
      id: `${workflowJob.id}:${step.id}`,
      workspaceRoot: workflowJob.workspaceRoot,
      cwd: workflowJob.workspaceRoot,
      engine: step.engine,
      jobClass: "task",
      kindLabel: "rescue",
      title: step.title,
      prompt: resolvedInput,
      readOnly: false,
      write: semanticPermission !== "read-only",
      resume: false,
      model: normalizeRequestedModel(step.engine, resolvedOptions.model),
      effort: normalizeReasoningEffort(resolvedOptions.effort),
      requestedPermission: normalizeTaskPermission(resolvedOptions.requestedPermission),
      permission: semanticPermission,
      permissionSource: resolvedOptions.permissionSource ?? "legacy",
      permissionNative: resolvedOptions.permissionNative ?? null,
      permissionSummary: formatTaskPermissionSummary({
        permission: semanticPermission,
        nativeLabel: resolvedOptions.permissionNative
      }),
      capabilities: getEngineRuntimeCapabilities(step.engine),
      ownerState: createEngineOwnerState(step.engine, "queued")
    };
  }

  return {
    id: `${workflowJob.id}:${step.id}`,
    workspaceRoot: workflowJob.workspaceRoot,
    cwd: workflowJob.workspaceRoot,
    engine: step.engine,
    jobClass: step.kind,
    kindLabel: step.kind,
    title: step.title,
    scope: resolvedOptions.scope || "auto",
    baseRef: resolvedOptions.base ?? null,
    focusText: step.kind === "adversarial-review" ? resolvedInput ?? null : null,
    model: normalizeRequestedModel(step.engine, resolvedOptions.model),
    effort: normalizeReasoningEffort(resolvedOptions.effort),
    capabilities: getEngineRuntimeCapabilities(step.engine),
    ownerState: createEngineOwnerState(step.engine, "queued")
  };
}

function buildWorkflowStepRequest(stepJob) {
  if (stepJob.jobClass === "review" || stepJob.jobClass === "adversarial-review") {
    return {
      engine: stepJob.engine,
      kind: stepJob.jobClass,
      cwd: stepJob.workspaceRoot,
      scope: stepJob.scope,
      baseRef: stepJob.baseRef,
      focusText: stepJob.focusText,
      model: stepJob.model,
      effort: stepJob.effort
    };
  }

  return {
    engine: stepJob.engine,
    kind: "task",
    cwd: stepJob.workspaceRoot,
    prompt: stepJob.prompt,
    resume: false,
    resumeSessionRef: null,
    model: stepJob.model,
    effort: stepJob.effort,
    readOnly: false,
    permission: stepJob.permission
  };
}

function renderWorkflowStepResult(result, stepJob) {
  return stepJob.jobClass === "review" || stepJob.jobClass === "adversarial-review"
    ? renderReview(result, stepJob)
    : renderTaskResult(result, stepJob);
}

function summarizeWorkflowCompletion(workflowJob, options = {}) {
  const completed = (workflowJob.steps ?? []).filter((step) => step.status === "completed").length;
  const total = workflowJob.steps?.length ?? 0;
  if (options.status === "failed" && options.step) {
    return `Failed at step ${options.index + 1}/${total}: ${options.step.title}`;
  }
  if (options.status === "cancelled" && options.step) {
    return `Cancelled at step ${options.index + 1}/${total}: ${options.step.title}`;
  }
  if (total === 0) {
    return "Workflow complete.";
  }
  return `Completed ${completed}/${total} steps.`;
}

function renderOrchestrationResult(jobLike) {
  const lines = ["# Orchestration Result", "", `Workflow: ${jobLike.title}`, `Task: ${jobLike.workflow?.task ?? ""}`, ""];
  lines.push("| Step | Kind | Engine | Source | Status | Summary |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const step of jobLike.steps ?? []) {
    lines.push(
      `| ${escapeMarkdown(step.index ? `${step.index}. ${step.title ?? ""}` : step.title ?? "")} | ${escapeMarkdown(step.kind ?? "")} | ${escapeMarkdown(step.engine ?? "")} | ${escapeMarkdown(step.assignmentSource ?? "")} | ${escapeMarkdown(step.status ?? "")} | ${escapeMarkdown(step.summary ?? "")} |`
    );
  }

  for (const step of jobLike.steps ?? []) {
    lines.push("", `## Step ${step.index}: ${step.title}`, "");
    lines.push(`- Kind: ${step.kind}`);
    lines.push(`- Engine: ${step.engine}`);
    lines.push(`- Source: ${step.assignmentSource}`);
    lines.push(`- Status: ${step.status}`);
    if (step.summary) {
      lines.push(`- Summary: ${step.summary}`);
    }
    if (step.rendered) {
      lines.push("", step.rendered.trimEnd());
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function escapeMarkdown(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

async function executeWorkflowStep(workflowJob, step, index, totalSteps) {
  const config = getConfig(workflowJob.workspaceRoot);
  const defaults = getEngineDefaults(config, step.engine);
  const context = buildWorkflowInterpolationContext(workflowJob);
  const resolvedInput =
    step.input == null
      ? null
      : interpolateWorkflowTemplate(step.input, context, {
          maxStepOutputChars: WORKFLOW_STEP_OUTPUT_MAX_CHARS
        });
  const resolvedOptions =
    step.kind === "task"
      ? applyTaskDefaults(step.engine, step.options ?? {}, defaults, emitWarning)
      : applyEngineDefaults(step.engine, step.options ?? {}, defaults, emitWarning);
  const stepJob = buildWorkflowStepExecutionJob({
    workflowJob,
    step,
    resolvedInput,
    resolvedOptions
  });
  const request = buildWorkflowStepRequest(stepJob);

  let latestWorkflowJob = updateWorkflowJobState(workflowJob.workspaceRoot, workflowJob.id, (stored) => {
    const storedStep = stored.steps[index];
    stored.currentStepIndex = index;
    stored.currentStepId = storedStep.id;
    stored.summary = workflowStepLabel(storedStep, index, totalSteps);
    stored.phase = workflowRunningPhase(index, totalSteps, "starting");
    storedStep.status = "running";
    storedStep.phase = "starting";
    storedStep.startedAt = storedStep.startedAt ?? nowIso();
    storedStep.resolvedInput = resolvedInput;
    storedStep.model = stepJob.model ?? null;
    storedStep.effort = stepJob.effort ?? null;
    storedStep.permission = stepJob.permission ?? null;
    storedStep.permissionNative = stepJob.permissionNative ?? null;
    storedStep.permissionSource = stepJob.permissionSource ?? null;
    stored.threadId = null;
    stored.turnId = null;
    stored.sessionRef = null;
  });
  appendLogLine(
    workflowJob.logFile,
    `${workflowStepLabel(step, index, totalSteps)} started (${step.kind} via ${step.engine}, source=${step.assignmentSource}).`
  );

  const handle = startEngineRun(request);
  const pumpEvents = (async () => {
    for await (const event of handle.events()) {
      const progress = engineEventToProgress(event, step.engine);
      if (progress.message) {
        appendLogLine(workflowJob.logFile, `${workflowStepLabel(step, index, totalSteps)} ${progress.message}`);
      }
      if (progress.logTitle && progress.logBody) {
        appendLogBlock(workflowJob.logFile, `${workflowStepLabel(step, index, totalSteps)} ${progress.logTitle}`, progress.logBody);
      }

      latestWorkflowJob = updateWorkflowJobState(workflowJob.workspaceRoot, workflowJob.id, (stored) => {
        const storedStep = stored.steps[index];
        stored.currentStepIndex = index;
        stored.currentStepId = storedStep.id;
        stored.summary = workflowStepLabel(storedStep, index, totalSteps);
        stored.phase = workflowRunningPhase(index, totalSteps, progress.phase ?? storedStep.phase ?? "running");
        storedStep.status = "running";
        storedStep.phase = progress.phase ?? storedStep.phase ?? "running";
        if (progress.message) {
          storedStep.summary = progress.message;
        }
        if (progress.sessionRef) {
          stored.sessionRef = progress.sessionRef;
          storedStep.sessionRef = progress.sessionRef;
        }
        if (progress.threadId) {
          stored.threadId = progress.threadId;
          storedStep.threadId = progress.threadId;
        }
        if (progress.turnId) {
          stored.turnId = progress.turnId;
          storedStep.turnId = progress.turnId;
        }
        if (progress.ownerState) {
          storedStep.ownerState = progress.ownerState;
        }
      });
    }
  })();

  let result;
  try {
    result = await handle.result();
  } finally {
    await pumpEvents;
  }

  const rendered = renderWorkflowStepResult(result, stepJob);
  const completionStatus = result.ok ? "completed" : "failed";
  const completedAt = nowIso();
  const completionSummary =
    result.structured?.summary ??
    firstMeaningfulLine(result.finalText, `${step.title} ${result.ok ? "completed" : "failed"}.`);

  latestWorkflowJob = updateWorkflowJobState(workflowJob.workspaceRoot, workflowJob.id, (stored) => {
    const storedStep = stored.steps[index];
    stored.currentStepIndex = index;
    stored.currentStepId = storedStep.id;
    storedStep.status = completionStatus;
    storedStep.phase = result.ok ? "done" : "failed";
    storedStep.summary = completionSummary;
    storedStep.completedAt = completedAt;
    storedStep.sessionRef = result.sessionRef ?? storedStep.sessionRef ?? null;
    storedStep.threadId = result.threadId ?? storedStep.threadId ?? null;
    storedStep.turnId = result.turnId ?? storedStep.turnId ?? null;
    storedStep.ownerState = createEngineOwnerState(step.engine, result.ok ? "completed" : "failed", {
      sessionRef: result.sessionRef ?? result.threadId ?? null,
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null
    });
    storedStep.rendered = rendered;
    storedStep.output = rendered.trim();
    storedStep.result = result;
    stored.summary = result.ok
      ? index === totalSteps - 1
        ? summarizeWorkflowCompletion(stored, { status: "completed" })
        : `Completed step ${index + 1}/${totalSteps}: ${storedStep.title}`
      : summarizeWorkflowCompletion(stored, {
          status: "failed",
          step: storedStep,
          index
        });
    stored.phase = result.ok
      ? index === totalSteps - 1
        ? "done"
        : workflowRunningPhase(index + 1 < totalSteps ? index + 1 : index, totalSteps, "waiting")
      : workflowRunningPhase(index, totalSteps, "failed");
    stored.lastCompletedStepIndex = index;
    stored.threadId = result.threadId ?? stored.threadId ?? null;
    stored.turnId = result.turnId ?? stored.turnId ?? null;
    stored.sessionRef = result.sessionRef ?? stored.sessionRef ?? null;
  });

  appendLogBlock(workflowJob.logFile, `${workflowStepLabel(step, index, totalSteps)} output`, rendered);

  return {
    workflowJob: latestWorkflowJob,
    stepJob,
    result,
    rendered,
    summary: completionSummary
  };
}

async function executeOrchestrateJob(job) {
  return runTrackedJob(
    job,
    async () => {
      let workflowJob = readStoredJob(job.workspaceRoot, job.id) ?? job;
      const totalSteps = workflowJob.steps?.length ?? 0;
      let finalStepResult = null;

      for (let index = 0; index < totalSteps; index += 1) {
        const step = workflowJob.steps[index];
        const execution = await executeWorkflowStep(workflowJob, step, index, totalSteps);
        workflowJob = execution.workflowJob;
        finalStepResult = execution.result;
        if (!execution.result.ok) {
          return {
            exitStatus: 1,
            payload: {
              workflow: workflowJob.workflow,
              steps: workflowJob.steps
            },
            rendered: renderOrchestrationResult(workflowJob),
            summary: summarizeWorkflowCompletion(workflowJob, {
              status: "failed",
              step,
              index
            }),
            threadId: execution.result.threadId ?? null,
            turnId: execution.result.turnId ?? null,
            sessionRef: execution.result.sessionRef ?? execution.result.threadId ?? null,
            capabilities: getEngineRuntimeCapabilities(step.engine),
            ownerState: createEngineOwnerState("multi", "failed", {
              sessionRef: execution.result.sessionRef ?? execution.result.threadId ?? null,
              threadId: execution.result.threadId ?? null,
              turnId: execution.result.turnId ?? null
            })
          };
        }
      }

      const completedWorkflow = updateWorkflowJobState(job.workspaceRoot, job.id, (stored) => {
        stored.currentStepIndex = totalSteps > 0 ? totalSteps - 1 : null;
        stored.currentStepId = totalSteps > 0 ? stored.steps[totalSteps - 1]?.id ?? null : null;
        stored.summary = summarizeWorkflowCompletion(stored, { status: "completed" });
        stored.phase = "done";
      });

      return {
        exitStatus: 0,
        payload: {
          workflow: completedWorkflow.workflow,
          steps: completedWorkflow.steps
        },
        rendered: renderOrchestrationResult(completedWorkflow),
        summary: summarizeWorkflowCompletion(completedWorkflow, { status: "completed" }),
        threadId: finalStepResult?.threadId ?? null,
        turnId: finalStepResult?.turnId ?? null,
        sessionRef: finalStepResult?.sessionRef ?? finalStepResult?.threadId ?? null,
        capabilities: getEngineRuntimeCapabilities("multi"),
        ownerState: createEngineOwnerState("multi", "completed", {
          sessionRef: finalStepResult?.sessionRef ?? finalStepResult?.threadId ?? null,
          threadId: finalStepResult?.threadId ?? null,
          turnId: finalStepResult?.turnId ?? null
        })
      };
    },
    {
      logFile: job.logFile
    }
  );
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

async function handleOrchestrate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "plan-file"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const plan = normalizeWorkflowPlan(readWorkflowPlanFile(options["plan-file"]), {
    supportedEngines: listSupportedEngines().map((engine) => engine.id)
  });
  await assertWorkflowEnginesReady(plan, cwd);

  const job = createOrchestrateJob({
    workspaceRoot,
    cwd,
    plan
  });

  if (resolveBackground(options)) {
    const pid = spawnBackgroundWorker(job);
    const queuedJob = storeQueuedJob(job, pid);
    outputResult(options.json ? queuedJob : `Started ${job.id} in background (pid ${pid}).\n`, Boolean(options.json));
    return;
  }

  const execution = await executeOrchestrateJob(job);
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
  const activeJob = readStoredJob(workspaceRoot, job.id) ?? job;
  let interruptDetail = null;

  if (activeJob.status === "running") {
    try {
      if (activeJob.jobClass === "orchestrate") {
        const activeStep =
          Number.isInteger(activeJob.currentStepIndex) && activeJob.currentStepIndex >= 0
            ? activeJob.steps?.[activeJob.currentStepIndex] ?? null
            : null;
        if (activeStep?.engine === "codex") {
          interruptDetail = await interruptEngineJob(workspaceRoot, {
            engine: activeStep.engine,
            threadId: activeStep.threadId ?? null,
            turnId: activeStep.turnId ?? null
          });
        }
      } else {
        interruptDetail = await interruptEngineJob(workspaceRoot, activeJob);
      }
    } catch {
      interruptDetail = null;
    }
  }

  if (activeJob.pid) {
    try {
      terminateProcessTree(activeJob.pid);
    } catch {
      // Ignore stale pids.
    }
  }

  const completedAt = nowIso();
  const cancelledJob = {
    ...activeJob,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt,
    note: "Cancelled by user."
  };
  if (cancelledJob.jobClass === "orchestrate" && Number.isInteger(cancelledJob.currentStepIndex) && cancelledJob.currentStepIndex >= 0) {
    const activeStep = cancelledJob.steps?.[cancelledJob.currentStepIndex] ?? null;
    if (activeStep) {
      activeStep.status = "cancelled";
      activeStep.phase = "cancelled";
      activeStep.completedAt = completedAt;
      activeStep.summary = activeStep.summary ?? "Cancelled by user.";
    }
    cancelledJob.summary = summarizeWorkflowCompletion(cancelledJob, {
      status: "cancelled",
      step: activeStep,
      index: cancelledJob.currentStepIndex
    });
  }
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
  const job = readStoredJob(workspaceRoot, jobId) ?? readJob(workspaceRoot, jobId);
  if (!job) {
    process.exit(1);
  }

  const execution =
    job.jobClass === "orchestrate"
      ? await executeOrchestrateJob({
          ...job,
          workspaceRoot
        })
      : await executeJob({
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
    case "orchestrate":
      await handleOrchestrate(argv);
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
