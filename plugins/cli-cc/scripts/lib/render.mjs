import {
  buildTaskPermissionProfile,
  formatConfiguredTaskPermission,
  formatTaskPermissionSummary
} from "./permissions.mjs";

function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

function summarizeRoutingContext(routeContext) {
  if (!routeContext || typeof routeContext !== "object") {
    return null;
  }
  if (routeContext.targetMode) {
    return `${routeContext.targetMode}, ${routeContext.changedFiles ?? 0} files, ${routeContext.totalLines ?? 0} changed lines`;
  }
  return null;
}

function buildRoutingLines(source) {
  const lines = [];
  const shouldShowRequestedEngine =
    Boolean(source?.requestedEngine) &&
    (source.requestedEngine === "auto" ||
      source.engine !== source.requestedEngine ||
      source.policyId != null ||
      source.selectionReason != null);
  if (shouldShowRequestedEngine) {
    lines.push(`Requested engine: ${source.requestedEngine}`);
  }
  if (source?.engine && source.engine !== "multi" && source.engine !== source.requestedEngine) {
    lines.push(`Selected engine: ${source.engine}`);
  }
  if (source?.policyId) {
    lines.push(`Policy: ${source.policyId}`);
  }
  if (Array.isArray(source?.fallbackChain) && source.fallbackChain.length > 0) {
    lines.push(`Fallbacks: ${source.fallbackChain.join(", ")}`);
  }
  const routeContextSummary = summarizeRoutingContext(source?.routeContext);
  if (routeContextSummary) {
    lines.push(`Route context: ${routeContextSummary}`);
  }
  if (source?.selectionReason) {
    lines.push(`Why: ${source.selectionReason}`);
  }
  return lines;
}

function validateReviewResultShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

function normalizeReviewFinding(finding, index) {
  const source = finding && typeof finding === "object" && !Array.isArray(finding) ? finding : {};
  const lineStart = Number.isInteger(source.line_start) && source.line_start > 0 ? source.line_start : null;
  const lineEnd =
    Number.isInteger(source.line_end) && source.line_end > 0 && (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps
      .filter((step) => typeof step === "string" && step.trim())
      .map((step) => step.trim())
  };
}

function isStructuredReviewResult(result) {
  return Boolean(result && typeof result === "object" && !Array.isArray(result) && "structured" in result);
}

function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError") ||
    Object.prototype.hasOwnProperty.call(result, "structured")
  );
}

function reviewLabelForJob(job) {
  return job.jobClass === "adversarial-review" ? "Adversarial Review" : "Review";
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.engine) {
    parts.push(job.engine);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

function getEffectiveSessionId(job) {
  return job?.threadId ?? job?.sessionRef ?? job?.ownerState?.threadId ?? job?.ownerState?.sessionRef ?? null;
}

function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function getWorkflowStepSessionId(step) {
  return step?.threadId ?? step?.sessionRef ?? step?.ownerState?.threadId ?? step?.ownerState?.sessionRef ?? null;
}

function appendWorkflowStepsTable(lines, steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return;
  }

  lines.push("", "Steps:");
  lines.push("| Step | Kind | Engine | Source | Status | Phase | Session ID | Summary |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const step of steps) {
    lines.push(
      `| ${escapeMarkdownCell(step.index ? `${step.index}. ${step.title ?? step.id ?? ""}` : step.title ?? step.id ?? "")} | ${escapeMarkdownCell(step.kind ?? "")} | ${escapeMarkdownCell(step.engine ?? "")} | ${escapeMarkdownCell(step.assignmentSource ?? "")} | ${escapeMarkdownCell(step.status ?? "")} | ${escapeMarkdownCell(step.phase ?? "")} | ${escapeMarkdownCell(getWorkflowStepSessionId(step) ?? "")} | ${escapeMarkdownCell(step.summary ?? "")} |`
    );
  }
}

function renderOrchestrationStoredJobResult(job, storedJob) {
  const workflow = storedJob?.workflow ?? job?.workflow ?? null;
  const steps = Array.isArray(storedJob?.steps) ? storedJob.steps : Array.isArray(job?.steps) ? job.steps : [];
  const lines = ["# Orchestration Result", ""];
  if (workflow?.title || job?.title) {
    lines.push(`Workflow: ${workflow?.title ?? job.title}`);
  }
  if (workflow?.task) {
    lines.push(`Task: ${workflow.task}`);
  }
  lines.push(`Status: ${storedJob?.status ?? job?.status ?? "unknown"}`);
  if (storedJob?.summary || job?.summary) {
    lines.push(`Summary: ${storedJob?.summary ?? job?.summary}`);
  }

  appendWorkflowStepsTable(lines, steps);

  for (const step of steps) {
    lines.push("", `## Step ${step.index ?? "?"}: ${step.title ?? step.id ?? "workflow-step"}`, "");
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

function formatResumeCommand(job) {
  if (!job?.engine) {
    return null;
  }
  const sessionId = getEffectiveSessionId(job);
  if (job.engine === "codex" && (job.threadId || job.ownerState?.threadId)) {
    return `codex resume ${job.threadId ?? job.ownerState?.threadId}`;
  }
  if (sessionId && job.jobClass === "task") {
    return `/cc:rescue --engine ${job.engine} --resume`;
  }
  return null;
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Engine | Status | Phase | Elapsed | Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/cc:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/cc:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.engine ?? "")} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(getEffectiveSessionId(job) ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function buildStatusActions(job) {
  const actions = [`/cc:status ${job.id}`];
  if (job.status === "queued" || job.status === "running") {
    actions.push(`/cc:cancel ${job.id}`);
    return actions;
  }
  actions.push(`/cc:result ${job.id}`);
  return actions;
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (getEffectiveSessionId(job)) {
    lines.push(`  Session ID: ${getEffectiveSessionId(job)}`);
  }
  if (job.jobClass === "orchestrate" && Number.isInteger(job.currentStepIndex) && (job.totalSteps ?? 0) > 0) {
    lines.push(`  Current step: ${job.currentStepIndex + 1}/${job.totalSteps}`);
  }
  const permissionSummary = formatJobPermission(job);
  if (permissionSummary) {
    lines.push(`  Permission: ${permissionSummary}`);
  }
  const resumeCommand = formatResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /cc:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /cc:result ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push(`  Review changes: /cc:review --engine ${job.engine} --wait`);
    lines.push(`  Stricter review: /cc:adversarial-review --engine ${job.engine} --wait`);
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
  for (const line of buildRoutingLines(job)) {
    lines.push(`  ${line}`);
  }
}

function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

function appendRoutingSection(lines, source) {
  const routingLines = buildRoutingLines(source);
  if (routingLines.length === 0) {
    return;
  }

  lines.push("", "Routing:");
  for (const line of routingLines) {
    lines.push(`- ${line}`);
  }
}

function appendSession(lines, result) {
  const sessionId = result?.threadId ?? result?.sessionRef ?? null;
  if (sessionId) {
    lines.push("", `Session: ${sessionId}`);
  }
  if (result?.turnId) {
    lines.push(`Turn: ${result.turnId}`);
  }
}

function formatConfiguredEffort(engine, defaults = {}) {
  const storedEffort = defaults.effort ?? null;
  if (engine?.capabilities?.effortControl === "unsupported") {
    return storedEffort ? `ignored (${storedEffort})` : "none";
  }
  return storedEffort ?? "none";
}

function formatJobPermission(job) {
  if (job?.jobClass !== "task") {
    return null;
  }
  if (typeof job.permissionSummary === "string" && job.permissionSummary.trim()) {
    return job.permissionSummary.trim();
  }
  const fallbackProfile = buildTaskPermissionProfile(job.engine, job.permission ?? null);
  return formatTaskPermissionSummary({
    permission: job.permission ?? null,
    nativeLabel: job.permissionNative ?? fallbackProfile.nativeLabel
  });
}

export function renderSetup(report) {
  const lines = [
    "# cli-plugin-cc setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node?.detail ?? "unknown"}`,
    `- npm: ${report.npm?.detail ?? "unknown"}`,
    `Codex runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"} (${report.config.stopReviewGateEngine})`,
    "",
    "Engines:"
  ];

  for (const engine of report.engines) {
    const status = engine.available ? "available" : "missing";
    const auth = engine.auth.loggedIn ? "authenticated" : engine.auth.status;
    lines.push(
      `- ${engine.id}: ${status}, auth=${auth}, resume=${engine.capabilities.resume}, gate=${engine.capabilities.gate ? "yes" : "no"}`
    );
    if (engine.auth.detail) {
      lines.push(`  ${engine.auth.detail}`);
    }
  }

  lines.push("", `Default engine: ${report.config.defaultEngine}`);
  lines.push("Configured defaults:");
  for (const engine of report.engines) {
    const defaults = report.config.engineDefaults?.[engine.id] ?? {};
    const model = defaults.model ?? "none";
    const effort = formatConfiguredEffort(engine, defaults);
    const permission = formatConfiguredTaskPermission(defaults.permission);
    lines.push(`- ${engine.id}: model=${model}, effort=${effort}, permission=${permission}`);
  }
  if (Array.isArray(report.nextSteps) && report.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderPolicyReport(report) {
  const lines = [
    "# cli-plugin-cc policy",
    "",
    `Auto routing by default: ${report.config.preferAutoRouting ? "enabled" : "disabled"}`,
    `Active preset: ${report.preset.id} (${report.preset.label})`,
    "",
    report.preset.summary,
    "",
    `Matrix review engines: ${report.config.matrixReviewEngines.join(", ")}`,
    `Large review threshold: ${report.config.largeReviewFileThreshold} files or ${report.config.largeReviewLineThreshold} changed lines`,
    "",
    "Available presets:"
  ];

  for (const preset of report.presets) {
    lines.push(`- ${preset.id}: ${preset.summary}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderWorkspaceMemory(snapshot) {
  const lines = [
    "# cli-plugin-cc memory",
    "",
    `Jobs tracked: ${snapshot.totalJobs}`,
    `Finished jobs: ${snapshot.finishedJobs}`,
    `Completed: ${snapshot.completedJobs}`,
    `Failed: ${snapshot.failedJobs}`,
    `Cancelled: ${snapshot.cancelledJobs}`
  ];

  const recommendationEntries = [
    ["task", snapshot.recommendations.task],
    ["review", snapshot.recommendations.review],
    ["adversarial-review", snapshot.recommendations.adversarialReview]
  ].filter(([, recommendation]) => recommendation);

  if (recommendationEntries.length > 0) {
    lines.push("", "Recommended engines:");
    for (const [jobClass, recommendation] of recommendationEntries) {
      lines.push(
        `- ${jobClass}: ${recommendation.engine} (${recommendation.successRate}% success over ${recommendation.total} finished run(s))`
      );
    }
  }

  if (Array.isArray(snapshot.autoRoutingHistory) && snapshot.autoRoutingHistory.length > 0) {
    lines.push("", "Auto-routing history:");
    for (const entry of snapshot.autoRoutingHistory) {
      lines.push(`- ${entry.engine}: selected ${entry.count} time(s)`);
    }
  }

  if (Array.isArray(snapshot.recentSuccesses) && snapshot.recentSuccesses.length > 0) {
    lines.push("", "Recent successes:");
    for (const job of snapshot.recentSuccesses) {
      lines.push(`- ${job.id} (${job.jobClass} via ${job.engine}): ${job.summary ?? job.title ?? "completed"}`);
    }
  }

  if (Array.isArray(snapshot.recentFailures) && snapshot.recentFailures.length > 0) {
    lines.push("", "Recent failures:");
    for (const job of snapshot.recentFailures) {
      lines.push(`- ${job.id} (${job.jobClass} via ${job.engine}): ${job.summary ?? job.title ?? "failed"}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReview(result, job) {
  const parsedResult = {
    parsed: result.structured ?? null,
    parseError: result.parseError ?? null,
    rawOutput: result.finalText ?? "",
    reasoningSummary: result.reasoningSummary ?? []
  };
  return renderReviewResult(parsedResult, {
    engine: job.engine,
    reviewLabel: reviewLabelForJob(job),
    targetLabel: result.targetLabel,
    reasoningSummary: result.reasoningSummary ?? [],
    threadId: result.threadId ?? null,
    sessionRef: result.sessionRef ?? null,
    turnId: result.turnId ?? null,
    rawFallback: result.finalText ?? "",
    ok: result.ok,
    requestedEngine: job.requestedEngine ?? job.engine,
    policyId: job.policyId ?? null,
    selectionReason: job.selectionReason ?? null,
    fallbackChain: job.fallbackChain ?? [],
    routeContext: job.routeContext ?? null
  });
}

export function renderReviewResult(parsedResult, meta) {
  const lines = [
    `# ${meta.reviewLabel} (${meta.engine})`,
    ""
  ];

  if (meta.targetLabel) {
    lines.push(`Target: ${meta.targetLabel}`);
  }

  if (!parsedResult.parsed) {
    if (parsedResult.parseError) {
      lines.push("The engine did not return valid structured review JSON.", "", `- Parse error: ${parsedResult.parseError}`);
    } else if (!meta.ok) {
      lines.push("The review run failed.");
    } else {
      lines.push("The review completed without structured findings.");
    }

    if (parsedResult.rawOutput) {
      lines.push("", parsedResult.rawOutput);
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    appendRoutingSection(lines, meta);
    appendSession(lines, {
      threadId: meta.threadId ?? null,
      sessionRef: meta.sessionRef ?? null,
      turnId: meta.turnId ?? null
    });
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    lines.push("The engine returned JSON with an unexpected review shape.", "", `- Validation error: ${validationError}`);
    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }
    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
    appendRoutingSection(lines, meta);
    appendSession(lines, {
      threadId: meta.threadId ?? null,
      sessionRef: meta.sessionRef ?? null,
      turnId: meta.turnId ?? null
    });
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  lines.push(`Verdict: ${data.verdict}`, "", data.summary, "");

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${formatLineRange(finding)})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);
  appendRoutingSection(lines, meta);
  appendSession(lines, {
    threadId: meta.threadId ?? null,
    sessionRef: meta.sessionRef ?? null,
    turnId: meta.turnId ?? null
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderTaskResult(result, job) {
  const label = job.jobClass === "gate" ? "Gate Result" : "Rescue Result";
  const lines = [`# ${label} (${job.engine})`, ""];
  lines.push(result.finalText ?? "No output received.");
  const permissionSummary = formatJobPermission(job);
  if (permissionSummary) {
    lines.push("", `Permission: ${permissionSummary}`);
  }
  appendReasoningSection(lines, result.reasoningSummary ?? []);
  appendRoutingSection(lines, job);
  appendSession(lines, result);

  if (Array.isArray(result.touchedFiles) && result.touchedFiles.length > 0) {
    lines.push("", "Touched files:");
    for (const file of result.touchedFiles) {
      lines.push(`- ${file}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

function normalizeMatrixReviewer(reviewer, index) {
  const source = reviewer && typeof reviewer === "object" && !Array.isArray(reviewer) ? reviewer : {};
  return {
    index: Number.isInteger(source.index) ? source.index : index + 1,
    id: source.id ?? `reviewer-${index + 1}`,
    engine: source.engine ?? "unknown",
    status: source.status ?? "unknown",
    phase: source.phase ?? "",
    verdict: source.verdict ?? null,
    summary: source.summary ?? "",
    rendered: source.rendered ?? "",
    threadId: source.threadId ?? null,
    sessionRef: source.sessionRef ?? null
  };
}

function appendMatrixReviewersTable(lines, reviewers) {
  const normalized = Array.isArray(reviewers) ? reviewers.map((reviewer, index) => normalizeMatrixReviewer(reviewer, index)) : [];
  if (normalized.length === 0) {
    return;
  }

  lines.push("", "Reviewers:");
  lines.push("| Reviewer | Engine | Status | Verdict | Session ID | Summary |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const reviewer of normalized) {
    lines.push(
      `| ${escapeMarkdownCell(reviewer.index)} | ${escapeMarkdownCell(reviewer.engine)} | ${escapeMarkdownCell(reviewer.status)} | ${escapeMarkdownCell(reviewer.verdict ?? "")} | ${escapeMarkdownCell(reviewer.threadId ?? reviewer.sessionRef ?? "")} | ${escapeMarkdownCell(reviewer.summary)} |`
    );
  }
}

function renderMatrixFinding(finding, index) {
  const normalized = normalizeReviewFinding(finding, index);
  const engines = Array.isArray(finding?.engines) ? finding.engines.filter(Boolean) : [];
  return {
    ...normalized,
    engines
  };
}

export function renderMatrixReviewResult(job, storedJob = null) {
  const source = storedJob ?? job ?? {};
  const consensus = source.consensus ?? source.result?.consensus ?? null;
  const reviewers = Array.isArray(source.reviewers) ? source.reviewers : [];
  const lines = ["# Matrix Review", ""];

  if (source.reviewKind) {
    lines.push(`Kind: ${source.reviewKind}`);
  }
  if (source.targetLabel) {
    lines.push(`Target: ${source.targetLabel}`);
  }
  if (consensus?.verdict) {
    lines.push(`Consensus: ${consensus.verdict}`);
  }
  if (consensus?.summary) {
    lines.push("", consensus.summary);
  }

  appendRoutingSection(lines, source);
  appendMatrixReviewersTable(lines, reviewers);

  if (Array.isArray(consensus?.findings) && consensus.findings.length > 0) {
    lines.push("", "Consensus findings:");
    for (const [index, finding] of consensus.findings.entries()) {
      const normalized = renderMatrixFinding(finding, index);
      const reportedBy = normalized.engines.length > 0 ? ` [reported by ${normalized.engines.join(", ")}]` : "";
      lines.push(
        `- [${normalized.severity}] ${normalized.title} (${normalized.file}${formatLineRange(normalized)})${reportedBy}`
      );
      lines.push(`  ${normalized.body}`);
      if (normalized.recommendation) {
        lines.push(`  Recommendation: ${normalized.recommendation}`);
      }
    }
  }

  if (Array.isArray(consensus?.disagreements) && consensus.disagreements.length > 0) {
    lines.push("", "Disagreements:");
    for (const disagreement of consensus.disagreements) {
      lines.push(`- ${disagreement}`);
    }
  }

  for (const [index, reviewer] of reviewers.entries()) {
    const normalized = normalizeMatrixReviewer(reviewer, index);
    lines.push("", `## Reviewer ${normalized.index}: ${normalized.engine}`, "");
    lines.push(`- Status: ${normalized.status}`);
    if (normalized.verdict) {
      lines.push(`- Verdict: ${normalized.verdict}`);
    }
    if (normalized.summary) {
      lines.push(`- Summary: ${normalized.summary}`);
    }
    if (normalized.rendered) {
      lines.push("", normalized.rendered.trimEnd());
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatusReport(report) {
  const lines = [
    "# cli-plugin-cc status",
    "",
    `Codex runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"} (${report.config.stopReviewGateEngine})`,
    ""
  ];

  const jobs = [...report.running];
  if (report.latestFinished) {
    jobs.push(report.latestFinished);
  }
  jobs.push(...report.recent);

  if (jobs.length === 0) {
    lines.push("No jobs recorded yet.", "");
  } else {
    lines.push("| Job | Kind | Engine | Status | Phase | Time | Session ID | Summary | Actions |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const job of jobs) {
      const timeLabel = job.status === "queued" || job.status === "running" ? job.elapsed ?? "" : job.duration ?? "";
      lines.push(
        `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.engine ?? "")} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(timeLabel)} | ${escapeMarkdownCell(getEffectiveSessionId(job) ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${buildStatusActions(job).map((action) => `\`${action}\``).join("<br>")} |`
      );
    }
    lines.push("");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push(`Ending the session will trigger a fresh ${report.config.stopReviewGateEngine} stop-time review and block if it finds issues.`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# cli-plugin-cc job status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  if (job.jobClass === "orchestrate") {
    appendWorkflowStepsTable(lines, job.steps ?? []);
  } else if (job.jobClass === "matrix-review") {
    appendMatrixReviewersTable(lines, job.reviewers ?? []);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (job?.jobClass === "orchestrate" || storedJob?.jobClass === "orchestrate") {
    return renderOrchestrationStoredJobResult(job, storedJob);
  }
  if (job?.jobClass === "matrix-review" || storedJob?.jobClass === "matrix-review") {
    return renderMatrixReviewResult(job, storedJob);
  }
  const threadId = storedJob?.threadId ?? job.threadId ?? job.ownerState?.threadId ?? null;
  const sessionRef = storedJob?.sessionRef ?? job.sessionRef ?? job.ownerState?.sessionRef ?? null;
  const resumeCommand = formatResumeCommand({
    ...job,
    threadId,
    sessionRef
  });
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    const lines = [output.trimEnd()];
    appendRoutingSection(lines, storedJob ?? job);
    if (threadId || sessionRef) {
      lines.push("", `Session ID: ${threadId ?? sessionRef}`);
    }
    if (resumeCommand) {
      lines.push(`Resume: ${resumeCommand}`);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  if (isStructuredReviewStoredResult(storedJob)) {
    const result = storedJob.result;
    const rendered = renderReviewResult(
      {
        parsed: result.structured ?? result.result ?? null,
        parseError: result.parseError ?? null,
        rawOutput: result.finalText ?? result.rawOutput ?? "",
        reasoningSummary: result.reasoningSummary ?? []
      },
      {
        engine: job.engine,
        reviewLabel: reviewLabelForJob(job),
        targetLabel: result.targetLabel ?? null,
        reasoningSummary: result.reasoningSummary ?? [],
        threadId,
        sessionRef,
        turnId: storedJob.turnId ?? job.turnId ?? null,
        ok: job.status === "completed",
        requestedEngine: storedJob.requestedEngine ?? job.requestedEngine ?? job.engine,
        policyId: storedJob.policyId ?? job.policyId ?? null,
        selectionReason: storedJob.selectionReason ?? job.selectionReason ?? null,
        fallbackChain: storedJob.fallbackChain ?? job.fallbackChain ?? [],
        routeContext: storedJob.routeContext ?? job.routeContext ?? null
      }
    );
    return rendered;
  }

  const rawOutput =
    (typeof storedJob?.result?.finalText === "string" && storedJob.result.finalText) ||
    (typeof storedJob?.result?.rawOutput === "string" && storedJob.result.rawOutput) ||
    "";
  if (rawOutput) {
    const lines = [rawOutput];
    const permissionSummary = formatJobPermission(job);
    if (permissionSummary) {
      lines.push("", `Permission: ${permissionSummary}`);
    }
    appendRoutingSection(lines, storedJob ?? job);
    if (threadId || sessionRef) {
      lines.push("", `Session ID: ${threadId ?? sessionRef}`);
    }
    if (resumeCommand) {
      lines.push(`Resume: ${resumeCommand}`);
    }
    return `${lines.join("\n").trimEnd()}\n`;
  }

  const lines = [
    `# ${job.title ?? "cli-plugin-cc result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId || sessionRef) {
    lines.push(`Session ID: ${threadId ?? sessionRef}`);
  }
  if (resumeCommand) {
    lines.push(`Resume: ${resumeCommand}`);
  }
  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }
  const routingLines = buildRoutingLines(storedJob ?? job);
  for (const line of routingLines) {
    lines.push(line);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job, interruptDetail = null) {
  const lines = [
    "# cli-plugin-cc cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.engine) {
    lines.push(`- Engine: ${job.engine}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  if (interruptDetail?.detail) {
    lines.push(`- Interrupt: ${interruptDetail.detail}`);
  }
  lines.push("- Check `/cc:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStatus(snapshotOrState) {
  if (snapshotOrState && "running" in snapshotOrState) {
    return renderStatusReport(snapshotOrState);
  }

  const jobs = Array.isArray(snapshotOrState?.jobs) ? snapshotOrState.jobs : [];
  const lines = ["# cli-plugin-cc jobs", ""];
  if (jobs.length === 0) {
    lines.push("No jobs recorded.");
    return `${lines.join("\n")}\n`;
  }

  for (const job of jobs) {
    lines.push(`- ${formatJobLine(job)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredResult(job, resultOrStoredJob) {
  if (!job) {
    return "No matching job found.\n";
  }
  if (!resultOrStoredJob) {
    return `No stored result for ${job.id}.\n`;
  }

  if (resultOrStoredJob && typeof resultOrStoredJob === "object" && "result" in resultOrStoredJob) {
    return renderStoredJobResult(job, resultOrStoredJob);
  }

  if (job.jobClass === "review" || job.jobClass === "adversarial-review" || isStructuredReviewResult(resultOrStoredJob)) {
    return renderReview(resultOrStoredJob, job);
  }
  return renderTaskResult(resultOrStoredJob, job);
}
