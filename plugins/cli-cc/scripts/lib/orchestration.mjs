import fs from "node:fs";

export const WORKFLOW_PLAN_VERSION = 1;
export const MAX_WORKFLOW_STEPS = 5;
export const WORKFLOW_STEP_KINDS = new Set(["task", "review", "adversarial-review"]);
export const WORKFLOW_ASSIGNMENT_SOURCES = new Set(["auto", "manual"]);
export const WORKFLOW_AUTO_ENGINE = "auto";

const STEP_OPTION_KEYS = {
  task: new Set(["model", "effort", "permission"]),
  review: new Set(["model", "effort", "scope", "base"]),
  "adversarial-review": new Set(["model", "effort", "scope", "base"])
};

const TEMPLATE_PATTERN = /\{\{\s*(workflow_task|step_summary:[A-Za-z0-9._-]+|step_output:[A-Za-z0-9._-]+)\s*\}\}/g;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function normalizeNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function normalizeOptionalString(value, label) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string when provided.`);
  }
  const normalized = value.trim();
  return normalized || null;
}

function normalizeStepOptions(step, index) {
  const source = step.options ?? {};
  assertObject(source, `steps[${index}].options`);
  const allowedKeys = STEP_OPTION_KEYS[step.kind];
  const normalized = {};

  for (const [key, rawValue] of Object.entries(source)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`steps[${index}].options.${key} is not supported for step kind "${step.kind}".`);
    }
    if (rawValue == null) {
      continue;
    }
    if (typeof rawValue !== "string") {
      throw new Error(`steps[${index}].options.${key} must be a string when provided.`);
    }
    const trimmed = rawValue.trim();
    if (!trimmed) {
      continue;
    }
    normalized[key] = trimmed;
  }

  return normalized;
}

export function collectWorkflowTemplateReferences(template) {
  const references = [];
  if (typeof template !== "string" || !template.includes("{{")) {
    return references;
  }

  for (const match of template.matchAll(TEMPLATE_PATTERN)) {
    const token = match[1].trim();
    if (token === "workflow_task") {
      references.push({
        kind: "workflow_task",
        token
      });
      continue;
    }

    const separator = token.indexOf(":");
    references.push({
      kind: token.slice(0, separator),
      stepId: token.slice(separator + 1),
      token
    });
  }

  return references;
}

function validateInputReferences(steps) {
  const seenStepIds = new Set();
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const references = collectWorkflowTemplateReferences(step.input ?? "");
    for (const reference of references) {
      if (reference.kind === "workflow_task") {
        continue;
      }
      if (!seenStepIds.has(reference.stepId)) {
        throw new Error(
          `steps[${index}].input references "${reference.token}" before step "${reference.stepId}" is available.`
        );
      }
    }
    seenStepIds.add(step.id);
  }
}

export function readWorkflowPlanFile(planFile) {
  if (!planFile) {
    throw new Error("Missing --plan-file for orchestrate.");
  }

  try {
    return JSON.parse(fs.readFileSync(planFile, "utf8"));
  } catch (error) {
    throw new Error(`Failed to read workflow plan from ${planFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function normalizeWorkflowPlan(source, options = {}) {
  assertObject(source, "Workflow plan");
  const supportedEngines = new Set(options.supportedEngines ?? []);
  const version = source.version == null ? WORKFLOW_PLAN_VERSION : Number(source.version);
  if (version !== WORKFLOW_PLAN_VERSION) {
    throw new Error(`Unsupported workflow plan version "${source.version}". Expected ${WORKFLOW_PLAN_VERSION}.`);
  }

  const task = normalizeNonEmptyString(source.task, "task");
  const title = normalizeOptionalString(source.title, "title") ?? task;
  if (!Array.isArray(source.steps) || source.steps.length === 0) {
    throw new Error("steps must be a non-empty array.");
  }
  if (source.steps.length > MAX_WORKFLOW_STEPS) {
    throw new Error(`steps may contain at most ${MAX_WORKFLOW_STEPS} entries.`);
  }

  const seenIds = new Set();
  const normalizedSteps = source.steps.map((rawStep, index) => {
    assertObject(rawStep, `steps[${index}]`);
    const kind = normalizeNonEmptyString(rawStep.kind, `steps[${index}].kind`);
    if (!WORKFLOW_STEP_KINDS.has(kind)) {
      throw new Error(`steps[${index}].kind must be one of: task, review, adversarial-review.`);
    }

    const id = normalizeNonEmptyString(rawStep.id, `steps[${index}].id`);
    if (seenIds.has(id)) {
      throw new Error(`steps[${index}].id "${id}" is duplicated.`);
    }
    seenIds.add(id);

    const engine = normalizeNonEmptyString(rawStep.engine, `steps[${index}].engine`);
    if (engine !== WORKFLOW_AUTO_ENGINE && supportedEngines.size > 0 && !supportedEngines.has(engine)) {
      throw new Error(`steps[${index}].engine "${engine}" is not supported.`);
    }

    const assignmentSource = normalizeOptionalString(rawStep.assignmentSource, `steps[${index}].assignmentSource`) ?? "auto";
    if (!WORKFLOW_ASSIGNMENT_SOURCES.has(assignmentSource)) {
      throw new Error(`steps[${index}].assignmentSource must be "auto" or "manual".`);
    }

    const titleValue = normalizeOptionalString(rawStep.title, `steps[${index}].title`) ?? `${kind} via ${engine}`;
    const input = normalizeOptionalString(rawStep.input, `steps[${index}].input`);
    if (kind === "task" && !input) {
      throw new Error(`steps[${index}].input is required for task steps.`);
    }
    if (kind === "review" && input) {
      throw new Error(`steps[${index}].input is not supported for review steps.`);
    }

    return {
      id,
      title: titleValue,
      engine,
      assignmentSource,
      kind,
      input: input ?? null,
      options: normalizeStepOptions({ ...rawStep, kind }, index)
    };
  });

  validateInputReferences(normalizedSteps);

  return {
    version: WORKFLOW_PLAN_VERSION,
    title,
    task,
    steps: normalizedSteps
  };
}

function truncateWorkflowValue(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated to ${maxChars} chars]`;
}

export function interpolateWorkflowTemplate(template, context, options = {}) {
  if (template == null) {
    return null;
  }
  if (typeof template !== "string") {
    throw new Error("Workflow template must be a string.");
  }

  const maxStepOutputChars = options.maxStepOutputChars ?? 12000;
  return template.replace(TEMPLATE_PATTERN, (_, rawToken) => {
    const token = rawToken.trim();
    if (token === "workflow_task") {
      return context.workflowTask ?? "";
    }

    const separator = token.indexOf(":");
    const key = token.slice(0, separator);
    const stepId = token.slice(separator + 1);
    const step = context.steps?.[stepId];
    if (!step) {
      throw new Error(`Unknown workflow template reference "${token}".`);
    }

    if (key === "step_summary") {
      return step.summary ?? "";
    }
    if (key === "step_output") {
      return truncateWorkflowValue(step.output ?? "", maxStepOutputChars);
    }

    throw new Error(`Unsupported workflow template reference "${token}".`);
  });
}
