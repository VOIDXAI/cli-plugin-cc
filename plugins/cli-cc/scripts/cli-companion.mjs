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
import { buildWorkspaceMemorySnapshot } from "./lib/memory.mjs";
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
  renderMatrixReviewResult,
  renderPolicyReport,
  renderReview,
  renderSetup,
  renderStatusReport,
  renderStoredJobResult,
  renderTaskResult,
  renderWorkspaceMemory
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
import {
  AUTO_ENGINE_ID,
  buildPolicyReport,
  parseEngineList,
  parsePolicyPreset,
  resolveExecutionEngine,
  resolveMatrixReviewEngines,
  shouldUseAutoRouting
} from "./lib/policy.mjs";
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

function normalizeRequestedEngineInput(engine, { allowAuto = false } = {}) {
  const normalized = typeof engine === "string" ? engine.trim().toLowerCase() : "";
  if (!normalized) {
    return normalizeEngine();
  }
  if (allowAuto && normalized === AUTO_ENGINE_ID) {
    return AUTO_ENGINE_ID;
  }
  return normalizeEngine(normalized);
}

function resolveRequestedEngine(options, workspaceRoot, { allowAuto = false } = {}) {
  const config = getConfig(workspaceRoot);
  if (allowAuto && shouldUseAutoRouting(options, config)) {
    return AUTO_ENGINE_ID;
  }
  return normalizeRequestedEngineInput(options.engine || config.defaultEngine, { allowAuto });
}

async function resolveEngineSelection({
  requestedEngine,
  workspaceRoot,
  jobClass,
  readOnly = false,
  scope = null,
  baseRef = null
}) {
  return resolveExecutionEngine({
    requestedEngine,
    cwd: workspaceRoot,
    jobClass,
    readOnly,
    scope,
    baseRef,
    config: getConfig(workspaceRoot)
  });
}

function applyEngineSelectionMetadata(extra = {}, selection = {}, engine = null) {
  return {
    ...extra,
    requestedEngine: selection.requestedEngine ?? engine ?? extra.requestedEngine ?? null,
    policyId: selection.policyId ?? null,
    selectionReason: selection.selectionReason ?? null,
    fallbackChain: Array.isArray(selection.fallbackChain) ? selection.fallbackChain : [],
    routeContext: selection.routeContext ?? null
  };
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
    requestedEngine: extra.requestedEngine ?? engine,
    policyId: extra.policyId ?? null,
    selectionReason: extra.selectionReason ?? null,
    fallbackChain: extra.fallbackChain ?? [],
    routeContext: extra.routeContext ?? null,
    ...extra
  });
}

function createReviewJob({ workspaceRoot, cwd, engine, kind, options, focusText, selection = {} }) {
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
      effort: normalizeReasoningEffort(options.effort),
      ...applyEngineSelectionMetadata({}, selection, engine)
    }
  });
}

function createTaskJob({ workspaceRoot, cwd, engine, options, prompt, readOnly = false, jobClass = "task", selection = {} }) {
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
      permissionSummary,
      ...applyEngineSelectionMetadata({}, selection, engine)
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
    requestedEngine: step.engine,
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
    policyId: null,
    selectionReason: null,
    fallbackChain: [],
    routeContext: null,
    ownerState: createEngineOwnerState(step.engine === AUTO_ENGINE_ID ? "multi" : step.engine, "queued"),
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

function createMatrixReviewerRecord(engine, index) {
  return {
    index: index + 1,
    id: `reviewer-${engine}`,
    title: `adversarial-review via ${engine}`,
    engine,
    requestedEngine: engine,
    status: "pending",
    phase: "pending",
    verdict: null,
    summary: null,
    sessionRef: null,
    threadId: null,
    turnId: null,
    startedAt: null,
    completedAt: null,
    ownerState: createEngineOwnerState(engine, "queued"),
    rendered: null,
    result: null
  };
}

function createMatrixReviewJob({ workspaceRoot, cwd, engines, options, focusText, selection }) {
  return createBaseJob({
    workspaceRoot,
    cwd,
    engine: "multi",
    jobClass: "matrix-review",
    kindLabel: "matrix-review",
    title: `matrix review via ${engines.join(", ")}`,
    extra: {
      reviewKind: "adversarial-review",
      scope: options.scope || "auto",
      baseRef: options.base ?? null,
      focusText: focusText || null,
      reviewers: engines.map((engine, index) => createMatrixReviewerRecord(engine, index)),
      targetLabel: null,
      consensus: null,
      summary: `Queued ${engines.length}-engine matrix review.`,
      ...applyEngineSelectionMetadata(
        {
          requestedEngine: Array.isArray(selection.requestedEngines)
            ? selection.requestedEngines.join(",")
            : engines.join(",")
        },
        selection,
        "multi"
      )
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
    if (engine === AUTO_ENGINE_ID) {
      const firstAutoStep = plan.steps.find((step) => step.engine === AUTO_ENGINE_ID);
      await resolveEngineSelection({
        requestedEngine: AUTO_ENGINE_ID,
        workspaceRoot: cwd,
        jobClass: firstAutoStep?.kind ?? "task",
        readOnly: false,
        scope: firstAutoStep?.options?.scope ?? null,
        baseRef: firstAutoStep?.options?.base ?? null
      });
      continue;
    }

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

function buildWorkflowStepExecutionJob({ workflowJob, step, resolvedInput, resolvedOptions, engine, selection = {} }) {
  if (step.kind === "task") {
    const semanticPermission = normalizeTaskPermission(resolvedOptions.permission);
    return {
      id: `${workflowJob.id}:${step.id}`,
      workspaceRoot: workflowJob.workspaceRoot,
      cwd: workflowJob.workspaceRoot,
      engine,
      jobClass: "task",
      kindLabel: "rescue",
      title: step.title,
      prompt: resolvedInput,
      readOnly: false,
      write: semanticPermission !== "read-only",
      resume: false,
      model: normalizeRequestedModel(engine, resolvedOptions.model),
      effort: normalizeReasoningEffort(resolvedOptions.effort),
      requestedPermission: normalizeTaskPermission(resolvedOptions.requestedPermission),
      permission: semanticPermission,
      permissionSource: resolvedOptions.permissionSource ?? "legacy",
      permissionNative: resolvedOptions.permissionNative ?? null,
      permissionSummary: formatTaskPermissionSummary({
        permission: semanticPermission,
        nativeLabel: resolvedOptions.permissionNative
      }),
      capabilities: getEngineRuntimeCapabilities(engine),
      ownerState: createEngineOwnerState(engine, "queued"),
      ...applyEngineSelectionMetadata({}, selection, engine)
    };
  }

  return {
    id: `${workflowJob.id}:${step.id}`,
    workspaceRoot: workflowJob.workspaceRoot,
    cwd: workflowJob.workspaceRoot,
    engine,
    jobClass: step.kind,
    kindLabel: step.kind,
    title: step.title,
    scope: resolvedOptions.scope || "auto",
    baseRef: resolvedOptions.base ?? null,
    focusText: step.kind === "adversarial-review" ? resolvedInput ?? null : null,
    model: normalizeRequestedModel(engine, resolvedOptions.model),
    effort: normalizeReasoningEffort(resolvedOptions.effort),
    capabilities: getEngineRuntimeCapabilities(engine),
    ownerState: createEngineOwnerState(engine, "queued"),
    ...applyEngineSelectionMetadata({}, selection, engine)
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
  const requestedEngine = step.requestedEngine ?? step.engine;
  const selection = await resolveEngineSelection({
    requestedEngine,
    workspaceRoot: workflowJob.workspaceRoot,
    jobClass: step.kind === "task" ? "task" : step.kind,
    readOnly: false,
    scope: step.options?.scope ?? null,
    baseRef: step.options?.base ?? null
  });
  const resolvedEngine = selection.engine ?? requestedEngine;
  const config = getConfig(workflowJob.workspaceRoot);
  const defaults = getEngineDefaults(config, resolvedEngine);
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
    resolvedOptions,
    engine: resolvedEngine,
    selection
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
    storedStep.requestedEngine = requestedEngine;
    storedStep.engine = resolvedEngine;
    storedStep.model = stepJob.model ?? null;
    storedStep.effort = stepJob.effort ?? null;
    storedStep.permission = stepJob.permission ?? null;
    storedStep.permissionNative = stepJob.permissionNative ?? null;
    storedStep.permissionSource = stepJob.permissionSource ?? null;
    storedStep.policyId = selection.policyId ?? null;
    storedStep.selectionReason = selection.selectionReason ?? null;
    storedStep.fallbackChain = selection.fallbackChain ?? [];
    storedStep.routeContext = selection.routeContext ?? null;
    storedStep.ownerState = createEngineOwnerState(resolvedEngine, "running");
    stored.threadId = null;
    stored.turnId = null;
    stored.sessionRef = null;
  });
  appendLogLine(
    workflowJob.logFile,
    `${workflowStepLabel(step, index, totalSteps)} started (${step.kind} via ${resolvedEngine}, source=${step.assignmentSource}).`
  );

  const handle = startEngineRun(request);
  const pumpEvents = (async () => {
    for await (const event of handle.events()) {
      const progress = engineEventToProgress(event, resolvedEngine);
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
    storedStep.ownerState = createEngineOwnerState(resolvedEngine, result.ok ? "completed" : "failed", {
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

function buildMatrixReviewerJobLike(job, reviewer) {
  return {
    id: `${job.id}:${reviewer.id}`,
    engine: reviewer.engine,
    requestedEngine: reviewer.requestedEngine ?? reviewer.engine,
    policyId: null,
    selectionReason: null,
    fallbackChain: [],
    routeContext: null,
    jobClass: job.reviewKind,
    kindLabel: job.reviewKind,
    title: reviewer.title
  };
}

function normalizeConsensusFinding(finding, engine) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) {
    return null;
  }
  const file = typeof finding.file === "string" && finding.file.trim() ? finding.file.trim() : "unknown";
  const title = typeof finding.title === "string" && finding.title.trim() ? finding.title.trim() : "Finding";
  const body = typeof finding.body === "string" && finding.body.trim() ? finding.body.trim() : "No details provided.";
  const lineStart = Number.isInteger(finding.line_start) && finding.line_start > 0 ? finding.line_start : null;
  const lineEnd = Number.isInteger(finding.line_end) && finding.line_end >= (lineStart ?? 0) ? finding.line_end : lineStart;
  return {
    key: JSON.stringify([file, lineStart, lineEnd, title, body]),
    severity: typeof finding.severity === "string" && finding.severity.trim() ? finding.severity.trim() : "low",
    title,
    body,
    file,
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof finding.recommendation === "string" ? finding.recommendation.trim() : "",
    engines: [engine]
  };
}

function aggregateMatrixReviewConsensus(reviewers) {
  const completed = reviewers.filter((reviewer) => reviewer.status === "completed");
  const failed = reviewers.filter((reviewer) => reviewer.status === "failed");
  const approveCount = completed.filter((reviewer) => reviewer.verdict === "approve").length;
  const attentionCount = completed.filter((reviewer) => reviewer.verdict === "needs-attention").length;
  const unstructuredCount = completed.length - approveCount - attentionCount;
  const mergedFindings = new Map();

  for (const reviewer of completed) {
    const findings = Array.isArray(reviewer.result?.structured?.findings) ? reviewer.result.structured.findings : [];
    for (const finding of findings) {
      const normalized = normalizeConsensusFinding(finding, reviewer.engine);
      if (!normalized) {
        continue;
      }
      const existing = mergedFindings.get(normalized.key);
      if (!existing) {
        mergedFindings.set(normalized.key, normalized);
        continue;
      }
      existing.engines = [...new Set([...existing.engines, reviewer.engine])];
    }
  }

  const disagreements = [];
  if (approveCount > 0 && attentionCount > 0) {
    disagreements.push(`${approveCount} reviewer(s) approved while ${attentionCount} reviewer(s) flagged issues.`);
  }
  if (failed.length > 0) {
    disagreements.push(`${failed.length} reviewer(s) failed before returning a complete review.`);
  }
  if (unstructuredCount > 0) {
    disagreements.push(`${unstructuredCount} reviewer(s) returned unstructured output that may need manual inspection.`);
  }

  const verdict = attentionCount > 0 || failed.length > 0 ? "needs-attention" : "approve";
  const summary =
    verdict === "approve"
      ? `All ${completed.length} reviewer(s) approved the change.`
      : `${attentionCount}/${completed.length || 1} completed reviewer(s) flagged issues${failed.length > 0 ? ` and ${failed.length} reviewer(s) failed.` : "."}`;

  return {
    verdict,
    summary,
    findings: [...mergedFindings.values()].sort((left, right) =>
      ["critical", "high", "medium", "low"].indexOf(left.severity) - ["critical", "high", "medium", "low"].indexOf(right.severity)
    ),
    disagreements
  };
}

async function executeMatrixReviewer(matrixJob, reviewer, index, totalReviewers) {
  let latestMatrixJob = updateWorkflowJobState(matrixJob.workspaceRoot, matrixJob.id, (stored) => {
    const storedReviewer = stored.reviewers[index];
    storedReviewer.status = "running";
    storedReviewer.phase = "starting";
    storedReviewer.startedAt = storedReviewer.startedAt ?? nowIso();
    storedReviewer.ownerState = createEngineOwnerState(reviewer.engine, "running");
    stored.summary = `Running reviewer ${index + 1}/${totalReviewers}: ${reviewer.engine}`;
    stored.phase = `reviewer ${index + 1}/${totalReviewers} starting`;
  });
  appendLogLine(matrixJob.logFile, `Reviewer ${index + 1}/${totalReviewers} started (${reviewer.engine}).`);

  const defaults = getEngineDefaults(getConfig(matrixJob.workspaceRoot), reviewer.engine);
  const resolvedOptions = applyEngineDefaults(reviewer.engine, {}, defaults, emitWarning);
  const request = {
    engine: reviewer.engine,
    kind: matrixJob.reviewKind,
    cwd: matrixJob.workspaceRoot,
    scope: matrixJob.scope,
    baseRef: matrixJob.baseRef,
    focusText: matrixJob.focusText,
    model: resolvedOptions.model ?? null,
    effort: resolvedOptions.effort ?? null
  };
  const handle = startEngineRun(request);

  const pumpEvents = (async () => {
    for await (const event of handle.events()) {
      const progress = engineEventToProgress(event, reviewer.engine);
      if (progress.message) {
        appendLogLine(matrixJob.logFile, `Reviewer ${reviewer.engine}: ${progress.message}`);
      }
      if (progress.logTitle && progress.logBody) {
        appendLogBlock(matrixJob.logFile, `Reviewer ${reviewer.engine} ${progress.logTitle}`, progress.logBody);
      }
      latestMatrixJob = updateWorkflowJobState(matrixJob.workspaceRoot, matrixJob.id, (stored) => {
        const storedReviewer = stored.reviewers[index];
        storedReviewer.status = "running";
        storedReviewer.phase = progress.phase ?? storedReviewer.phase ?? "running";
        if (progress.message) {
          storedReviewer.summary = progress.message;
        }
        if (progress.sessionRef) {
          storedReviewer.sessionRef = progress.sessionRef;
        }
        if (progress.threadId) {
          storedReviewer.threadId = progress.threadId;
        }
        if (progress.turnId) {
          storedReviewer.turnId = progress.turnId;
        }
        if (progress.ownerState) {
          storedReviewer.ownerState = progress.ownerState;
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

  const rendered = renderReview(result, buildMatrixReviewerJobLike(matrixJob, reviewer));
  const status = result.ok ? "completed" : "failed";
  const verdict = result.structured?.verdict ?? (result.ok ? "unstructured" : "failed");
  const summary =
    result.structured?.summary ??
    firstMeaningfulLine(result.finalText, `${reviewer.engine} review ${result.ok ? "completed" : "failed"}.`);

  latestMatrixJob = updateWorkflowJobState(matrixJob.workspaceRoot, matrixJob.id, (stored) => {
    const storedReviewer = stored.reviewers[index];
    storedReviewer.status = status;
    storedReviewer.phase = result.ok ? "done" : "failed";
    storedReviewer.verdict = verdict;
    storedReviewer.summary = summary;
    storedReviewer.rendered = rendered;
    storedReviewer.result = result;
    storedReviewer.completedAt = nowIso();
    storedReviewer.sessionRef = result.sessionRef ?? storedReviewer.sessionRef ?? null;
    storedReviewer.threadId = result.threadId ?? storedReviewer.threadId ?? null;
    storedReviewer.turnId = result.turnId ?? storedReviewer.turnId ?? null;
    storedReviewer.ownerState = createEngineOwnerState(reviewer.engine, result.ok ? "completed" : "failed", {
      sessionRef: result.sessionRef ?? result.threadId ?? null,
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null
    });
    stored.targetLabel = stored.targetLabel ?? result.targetLabel ?? null;
    const finished = stored.reviewers.filter((entry) => entry.status === "completed" || entry.status === "failed").length;
    stored.summary =
      finished === totalReviewers ? `Completed ${totalReviewers}/${totalReviewers} reviewers.` : `Completed ${finished}/${totalReviewers} reviewers.`;
    stored.phase = finished === totalReviewers ? "finalizing" : `reviewer ${finished + 1}/${totalReviewers} running`;
  });

  appendLogBlock(matrixJob.logFile, `Reviewer ${reviewer.engine} output`, rendered);

  return {
    reviewer: latestMatrixJob.reviewers[index],
    result
  };
}

async function executeMatrixReviewJob(job) {
  return runTrackedJob(
    job,
    async () => {
      let matrixJob = readStoredJob(job.workspaceRoot, job.id) ?? job;
      const totalReviewers = matrixJob.reviewers?.length ?? 0;

      await Promise.all(
        (matrixJob.reviewers ?? []).map((reviewer, index) => executeMatrixReviewer(matrixJob, reviewer, index, totalReviewers))
      );

      matrixJob = readStoredJob(job.workspaceRoot, job.id) ?? matrixJob;
      const consensus = aggregateMatrixReviewConsensus(matrixJob.reviewers ?? []);
      const hadFailures = (matrixJob.reviewers ?? []).some((reviewer) => reviewer.status === "failed");
      const finalized = updateWorkflowJobState(job.workspaceRoot, job.id, (stored) => {
        stored.consensus = consensus;
        stored.summary = consensus.summary;
        stored.phase = hadFailures ? "failed" : "done";
      });

      return {
        exitStatus: hadFailures ? 1 : 0,
        payload: {
          consensus,
          reviewers: finalized.reviewers,
          targetLabel: finalized.targetLabel ?? null
        },
        rendered: renderMatrixReviewResult(finalized),
        summary: consensus.summary,
        threadId: null,
        turnId: null,
        sessionRef: null,
        capabilities: getEngineRuntimeCapabilities("multi"),
        ownerState: createEngineOwnerState("multi", hadFailures ? "failed" : "completed")
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
  if (normalizeRequestedEngineInput(options.engine, { allowAuto: true }) === AUTO_ENGINE_ID) {
    throw new Error("`setup` does not accept `--engine auto`. Use `/cc:policy` to configure auto routing.");
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
  const requestedEngine = resolveRequestedEngine(options, workspaceRoot, { allowAuto: true });
  const focusText = positionals.join(" ").trim();
  if (kind === "review" && focusText) {
    throw new Error(
      `\`/cc:review\` does not support custom focus text. Retry with \`/cc:adversarial-review --engine ${requestedEngine} ${focusText}\` for focused review instructions.`
    );
  }
  const selection = await resolveEngineSelection({
    requestedEngine,
    workspaceRoot,
    jobClass: kind,
    readOnly: true,
    scope: options.scope ?? null,
    baseRef: options.base ?? null
  });
  const engine = selection.engine ?? requestedEngine;
  const resolvedOptions = applyEngineDefaults(engine, options, getEngineDefaults(getConfig(workspaceRoot), engine), emitWarning);
  const job = createReviewJob({
    workspaceRoot,
    cwd,
    engine,
    kind,
    options: resolvedOptions,
    focusText,
    selection
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
  const requestedEngine = resolveRequestedEngine(options, workspaceRoot, { allowAuto: true });
  const selection = await resolveEngineSelection({
    requestedEngine,
    workspaceRoot,
    jobClass,
    readOnly,
    scope: null,
    baseRef: null
  });
  const engine = selection.engine ?? requestedEngine;
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
    jobClass,
    selection
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

async function handleMatrixReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "engines", "scope", "base"],
    booleanOptions: ["json", "background", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const focusText = positionals.join(" ").trim();
  const selection = await resolveMatrixReviewEngines({
    cwd: workspaceRoot,
    requestedEngines: options.engines ?? null,
    config: getConfig(workspaceRoot)
  });
  const job = createMatrixReviewJob({
    workspaceRoot,
    cwd,
    engines: selection.engines,
    options,
    focusText,
    selection
  });

  if (resolveBackground(options)) {
    const pid = spawnBackgroundWorker(job);
    const queuedJob = storeQueuedJob(job, pid);
    outputResult(options.json ? queuedJob : `Started ${job.id} in background (pid ${pid}).\n`, Boolean(options.json));
    return;
  }

  const execution = await executeMatrixReviewJob(job);
  process.exitCode = execution.exitStatus;
  outputResult(options.json ? execution.payload : execution.rendered, Boolean(options.json));
}

function renderReplayReport(job, storedJob, logText) {
  const lines = [
    "# cli-plugin-cc replay",
    "",
    `Job: ${job.id}`,
    `Status: ${storedJob?.status ?? job.status}`,
    `Kind: ${storedJob?.jobClass ?? job.jobClass}`,
    `Engine: ${storedJob?.engine ?? job.engine}`
  ];

  if (storedJob?.summary || job.summary) {
    lines.push(`Summary: ${storedJob?.summary ?? job.summary}`);
  }
  if (storedJob?.selectionReason || job.selectionReason) {
    lines.push(`Routing: ${storedJob?.selectionReason ?? job.selectionReason}`);
  }
  lines.push("", "Timeline:", "", "```text", (logText || "(no log captured)").trimEnd(), "```");

  if (storedJob?.rendered) {
    lines.push("", "Result:", "", storedJob.rendered.trimEnd());
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function handlePolicy(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "set", "matrix-engines", "threshold-files", "threshold-lines"],
    booleanOptions: ["json", "prefer-auto", "disable-auto"]
  });

  if (options["prefer-auto"] && options["disable-auto"]) {
    throw new Error("Choose either --prefer-auto or --disable-auto.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const nextAutoRouting = {
    ...(config.autoRouting ?? {})
  };

  if (options.set != null) {
    nextAutoRouting.policy = parsePolicyPreset(options.set);
  }
  if (options["prefer-auto"]) {
    nextAutoRouting.preferAutoRouting = true;
  }
  if (options["disable-auto"]) {
    nextAutoRouting.preferAutoRouting = false;
  }
  if (options["matrix-engines"] != null) {
    nextAutoRouting.matrixReviewEngines = parseEngineList(options["matrix-engines"]);
  }
  if (options["threshold-files"] != null) {
    nextAutoRouting.largeReviewFileThreshold = Number.parseInt(options["threshold-files"], 10);
  }
  if (options["threshold-lines"] != null) {
    nextAutoRouting.largeReviewLineThreshold = Number.parseInt(options["threshold-lines"], 10);
  }

  if (
    options.set != null ||
    options["prefer-auto"] ||
    options["disable-auto"] ||
    options["matrix-engines"] != null ||
    options["threshold-files"] != null ||
    options["threshold-lines"] != null
  ) {
    setConfig(workspaceRoot, {
      autoRouting: nextAutoRouting
    });
  }

  const report = buildPolicyReport(getConfig(workspaceRoot).autoRouting);
  outputResult(options.json ? report : renderPolicyReport(report), Boolean(options.json));
}

function handleMemory(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const snapshot = buildWorkspaceMemorySnapshot(cwd);
  outputResult(options.json ? snapshot : renderWorkspaceMemory(snapshot), Boolean(options.json));
}

function handleReplay(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "all"]
  });

  const cwd = resolveCommandCwd(options);
  const { workspaceRoot, job } = resolveResultJob(cwd, positionals[0] ?? null, {
    all: Boolean(options.all)
  });
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const logFile = storedJob?.logFile ?? job.logFile ?? null;
  const logText = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
  const payload = {
    job: storedJob ?? job,
    log: logText
  };
  outputResult(options.json ? payload : renderReplayReport(job, storedJob, logText), Boolean(options.json));
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
  const engine = normalizeRequestedEngineInput(options.engine || getConfig(workspaceRoot).defaultEngine);
  if (engine === AUTO_ENGINE_ID) {
    throw new Error("`task-resume-candidate` does not accept `--engine auto`.");
  }
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
      : job.jobClass === "matrix-review"
        ? await executeMatrixReviewJob({
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
    case "policy":
      handlePolicy(argv);
      return;
    case "review":
      await handleReview(argv, "review");
      return;
    case "adversarial-review":
      await handleReview(argv, "adversarial-review");
      return;
    case "memory":
      handleMemory(argv);
      return;
    case "replay":
      handleReplay(argv);
      return;
    case "task":
      await handleTask(argv);
      return;
    case "orchestrate":
      await handleOrchestrate(argv);
      return;
    case "matrix-review":
      await handleMatrixReview(argv);
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
