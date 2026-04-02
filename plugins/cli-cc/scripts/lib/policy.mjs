import { detectEngine, getEngineInfo, isSupportedEngine, listSupportedEngineIds } from "./engines.mjs";
import { summarizeReviewTarget } from "./git.mjs";

export const AUTO_ENGINE_ID = "auto";
export const DEFAULT_POLICY_PRESET = "balanced";

const POLICY_PRESETS = {
  balanced: {
    label: "Balanced",
    summary: "Favor Codex for edits, Gemini for adversarial review, and Droid for large branch reviews.",
    matrixReviewEngines: ["codex", "gemini", "droid"],
    largeReviewFileThreshold: 8,
    largeReviewLineThreshold: 500
  },
  "quality-first": {
    label: "Quality First",
    summary: "Bias toward deeper review quality, keeping Codex and Gemini early in the chain.",
    matrixReviewEngines: ["codex", "gemini", "droid"],
    largeReviewFileThreshold: 12,
    largeReviewLineThreshold: 900
  },
  "speed-first": {
    label: "Speed First",
    summary: "Prefer faster turn-around, front-loading Droid and Gemini when safe.",
    matrixReviewEngines: ["gemini", "droid"],
    largeReviewFileThreshold: 6,
    largeReviewLineThreshold: 300
  },
  "cost-first": {
    label: "Cost First",
    summary: "Prefer lighter engines first and reserve Codex for later fallbacks.",
    matrixReviewEngines: ["gemini", "droid"],
    largeReviewFileThreshold: 6,
    largeReviewLineThreshold: 300
  }
};

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function unique(items) {
  return [...new Set(items)];
}

function normalizeEngineList(value, fallback = []) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];
  const normalized = unique(source.filter((engine) => isSupportedEngine(engine)));
  return normalized.length > 0 ? normalized : [...fallback];
}

function routeTaskOrder(policyId, readOnly) {
  if (policyId === "speed-first") {
    return readOnly ? ["gemini", "droid", "codex"] : ["droid", "codex", "gemini"];
  }
  if (policyId === "cost-first") {
    return readOnly ? ["gemini", "droid", "codex"] : ["gemini", "droid", "codex"];
  }
  if (policyId === "quality-first") {
    return readOnly ? ["codex", "gemini", "droid"] : ["codex", "droid", "gemini"];
  }
  return readOnly ? ["gemini", "codex", "droid"] : ["codex", "droid", "gemini"];
}

function routeReviewOrder(policyId, isLargeReview) {
  if (policyId === "speed-first") {
    return ["gemini", "droid", "codex"];
  }
  if (policyId === "cost-first") {
    return ["gemini", "droid", "codex"];
  }
  if (policyId === "quality-first") {
    return isLargeReview ? ["codex", "droid", "gemini"] : ["codex", "gemini", "droid"];
  }
  return isLargeReview ? ["droid", "codex", "gemini"] : ["codex", "gemini", "droid"];
}

function routeAdversarialOrder(policyId) {
  if (policyId === "quality-first") {
    return ["gemini", "codex", "droid"];
  }
  if (policyId === "speed-first") {
    return ["gemini", "droid", "codex"];
  }
  if (policyId === "cost-first") {
    return ["gemini", "droid", "codex"];
  }
  return ["gemini", "codex", "droid"];
}

function routeBucket({ policyId, jobClass, readOnly, routeContext }) {
  if (jobClass === "adversarial-review") {
    return {
      name: "adversarial-review",
      order: routeAdversarialOrder(policyId)
    };
  }
  if (jobClass === "review") {
    return {
      name: routeContext?.isLargeReview ? "large-review" : "review",
      order: routeReviewOrder(policyId, Boolean(routeContext?.isLargeReview))
    };
  }
  return {
    name: readOnly ? "read-only-task" : "task",
    order: routeTaskOrder(policyId, readOnly)
  };
}

function buildSelectionReason({ engine, config, bucket, routeContext, readyEngines }) {
  const engineLabel = getEngineInfo(engine).label;
  const detail =
    bucket.name === "adversarial-review"
      ? "adversarial reviews default to Gemini-first ordering"
      : bucket.name === "large-review"
        ? `the review target is large (${routeContext.changedFiles} files, ${routeContext.totalLines} changed lines)`
        : bucket.name === "review"
          ? "the review target is small enough for the standard review order"
          : bucket.name === "read-only-task"
            ? "read-only investigation is routed through the read-only task order"
            : "editable rescue work is routed through the task order";
  const readyText = readyEngines.length > 0 ? readyEngines.join(", ") : "none";
  return `Auto routing (${config.policy}) selected ${engineLabel} because ${detail}. Ready engines: ${readyText}.`;
}

function buildReviewRouteContext(cwd, options, config) {
  const summary = summarizeReviewTarget(cwd, {
    scope: options.scope,
    base: options.baseRef
  });
  const isLargeReview =
    summary.changedFiles >= config.largeReviewFileThreshold || summary.totalLines >= config.largeReviewLineThreshold;
  return {
    ...summary,
    isLargeReview
  };
}

function buildUnavailableEngineMessage(statuses) {
  const detail = statuses
    .map((status) => {
      const readiness = status.available && status.auth?.loggedIn ? "ready" : status.auth?.detail ?? "not ready";
      return `${status.id}: ${readiness}`;
    })
    .join("; ");
  return `No supported engine is ready for auto routing. ${detail}`;
}

async function detectReadyEngines(cwd) {
  const engineIds = listSupportedEngineIds();
  const statuses = [];
  for (const engineId of engineIds) {
    statuses.push(await detectEngine(engineId, cwd));
  }
  return {
    statuses,
    readyEngines: statuses.filter((status) => status.available && status.auth?.loggedIn).map((status) => status.id)
  };
}

export function listPolicyPresets() {
  return Object.entries(POLICY_PRESETS).map(([id, preset]) => ({
    id,
    ...preset
  }));
}

export function getPolicyPreset(policyId = DEFAULT_POLICY_PRESET) {
  return POLICY_PRESETS[policyId] ?? POLICY_PRESETS[DEFAULT_POLICY_PRESET];
}

export function parsePolicyPreset(policyId) {
  const normalized = typeof policyId === "string" ? policyId.trim().toLowerCase() : "";
  if (!normalized) {
    return DEFAULT_POLICY_PRESET;
  }
  if (!Object.prototype.hasOwnProperty.call(POLICY_PRESETS, normalized)) {
    throw new Error(
      `Unsupported policy preset "${policyId}". Use one of: ${Object.keys(POLICY_PRESETS).join(", ")}.`
    );
  }
  return normalized;
}

export function parseEngineList(value, fallback = null) {
  const normalized = normalizeEngineList(value, fallback ?? []);
  if (normalized.length === 0) {
    throw new Error(`No supported engines found in "${value}". Use a comma-separated subset of ${listSupportedEngineIds().join(", ")}.`);
  }
  return normalized;
}

export function defaultAutoRoutingConfig() {
  return normalizeAutoRoutingConfig();
}

export function normalizeAutoRoutingConfig(value = {}) {
  const policy = parsePolicyPreset(value.policy ?? DEFAULT_POLICY_PRESET);
  const preset = getPolicyPreset(policy);
  return {
    policy,
    preferAutoRouting: Boolean(value.preferAutoRouting),
    matrixReviewEngines: normalizeEngineList(value.matrixReviewEngines, preset.matrixReviewEngines),
    largeReviewFileThreshold: positiveInteger(value.largeReviewFileThreshold, preset.largeReviewFileThreshold),
    largeReviewLineThreshold: positiveInteger(value.largeReviewLineThreshold, preset.largeReviewLineThreshold)
  };
}

export function buildPolicyReport(config = {}) {
  const normalized = normalizeAutoRoutingConfig(config);
  const preset = getPolicyPreset(normalized.policy);
  return {
    config: normalized,
    preset: {
      id: normalized.policy,
      label: preset.label,
      summary: preset.summary
    },
    presets: listPolicyPresets()
  };
}

export function shouldUseAutoRouting(options, config = {}) {
  if (options.engine === AUTO_ENGINE_ID) {
    return true;
  }
  return options.engine == null && Boolean(config.autoRouting?.preferAutoRouting);
}

export async function resolveExecutionEngine({
  requestedEngine,
  jobClass,
  readOnly = false,
  cwd,
  scope = null,
  baseRef = null,
  config = {}
}) {
  if (!requestedEngine || requestedEngine !== AUTO_ENGINE_ID) {
    return {
      requestedEngine: requestedEngine ?? null,
      engine: requestedEngine ?? null,
      policyId: null,
      selectionReason: null,
      fallbackChain: [],
      routeContext: null,
      readyEngines: []
    };
  }

  const normalizedConfig = normalizeAutoRoutingConfig(config.autoRouting ?? config);
  const readiness = await detectReadyEngines(cwd);
  if (readiness.readyEngines.length === 0) {
    throw new Error(buildUnavailableEngineMessage(readiness.statuses));
  }

  const routeContext =
    jobClass === "review" || jobClass === "adversarial-review"
      ? buildReviewRouteContext(cwd, { scope, baseRef }, normalizedConfig)
      : null;
  const bucket = routeBucket({
    policyId: normalizedConfig.policy,
    jobClass,
    readOnly,
    routeContext
  });
  const orderedReadyEngines = bucket.order.filter((engine) => readiness.readyEngines.includes(engine));
  if (orderedReadyEngines.length === 0) {
    throw new Error(buildUnavailableEngineMessage(readiness.statuses));
  }

  const engine = orderedReadyEngines[0];
  return {
    requestedEngine: AUTO_ENGINE_ID,
    engine,
    policyId: normalizedConfig.policy,
    selectionReason: buildSelectionReason({
      engine,
      config: normalizedConfig,
      bucket,
      routeContext,
      readyEngines: readiness.readyEngines
    }),
    fallbackChain: bucket.order.filter((candidate) => candidate !== engine),
    routeContext:
      routeContext == null
        ? null
        : {
            targetMode: routeContext.target.mode,
            targetLabel: routeContext.target.label,
            changedFiles: routeContext.changedFiles,
            totalLines: routeContext.totalLines,
            additions: routeContext.additions,
            deletions: routeContext.deletions,
            isLargeReview: routeContext.isLargeReview
          },
    readyEngines: readiness.readyEngines
  };
}

export async function resolveMatrixReviewEngines({ cwd, requestedEngines = null, config = {} }) {
  const normalizedConfig = normalizeAutoRoutingConfig(config.autoRouting ?? config);
  const readiness = await detectReadyEngines(cwd);
  if (readiness.readyEngines.length === 0) {
    throw new Error(buildUnavailableEngineMessage(readiness.statuses));
  }

  const requested = requestedEngines ? parseEngineList(requestedEngines) : [...normalizedConfig.matrixReviewEngines];
  const selected = requested.filter((engine) => readiness.readyEngines.includes(engine));
  if (requestedEngines && selected.length !== requested.length) {
    const missing = requested.filter((engine) => !selected.includes(engine));
    throw new Error(`The requested matrix-review engines are not all ready: ${missing.join(", ")}.`);
  }
  if (selected.length === 0) {
    throw new Error(buildUnavailableEngineMessage(readiness.statuses));
  }

  return {
    engines: selected,
    requestedEngines: requested,
    policyId: normalizedConfig.policy,
    selectionReason: requestedEngines
      ? `Matrix review will use the explicitly requested engines that are ready: ${selected.join(", ")}.`
      : `Matrix review (${normalizedConfig.policy}) will use the ready configured engines: ${selected.join(", ")}.`
  };
}
