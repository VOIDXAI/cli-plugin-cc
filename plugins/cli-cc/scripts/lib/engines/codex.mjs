import {
  buildNativeReviewTarget,
  buildReviewSchema,
  codexReviewSandbox,
  codexTaskSandbox,
  ENGINE_INFO,
  resolveReviewRequest
} from "./shared.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAvailability,
  getCodexLoginStatus,
  interruptAppServerTurn,
  parseStructuredOutput,
  runAppServerReview,
  runAppServerTurn
} from "../codex.mjs";

const info = ENGINE_INFO.codex;

async function detect(cwd) {
  const availability = getCodexAvailability(cwd);
  const auth = getCodexLoginStatus(cwd);
  return {
    id: info.id,
    label: info.label,
    available: availability.available,
    auth: {
      status: auth.loggedIn ? "logged-in" : availability.available ? "not-authenticated" : "unavailable",
      loggedIn: auth.loggedIn,
      detail: auth.detail
    },
    capabilities: capabilities()
  };
}

function capabilities() {
  return {
    gate: info.supportsGate,
    resume: info.resume
  };
}

async function review({ kind, cwd, scope, baseRef, focusText, model, effort, onProgress }) {
  const { target, prompt } = resolveReviewRequest({ cwd, scope, baseRef, kind, focusText });

  if (kind === "review" && !focusText?.trim()) {
    const result = await runAppServerReview(cwd, {
      model,
      target: buildNativeReviewTarget(target),
      sandbox: codexReviewSandbox(),
      onProgress
    });
    return {
      ok: result.status === 0,
      finalText: result.reviewText,
      structured: null,
      sessionRef: result.threadId,
      threadId: result.threadId,
      turnId: result.turnId,
      reasoningSummary: result.reasoningSummary,
      targetLabel: target.label
    };
  }

  const result = await runAppServerTurn(cwd, {
    prompt,
    model,
    effort,
    sandbox: codexReviewSandbox(),
    outputSchema: buildReviewSchema(),
    onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    reasoningSummary: result.reasoningSummary
  });
  return {
    ok: result.status === 0,
    finalText: parsed.rawOutput,
    structured: normalizeStructuredReview(parsed.parsed),
    parseError: parsed.parseError,
    sessionRef: result.threadId,
    threadId: result.threadId,
    turnId: result.turnId,
    reasoningSummary: result.reasoningSummary,
    targetLabel: target.label
  };
}

function normalizeStructuredReview(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return parsed;
}

async function task({ cwd, prompt, model, effort, readOnly = false, onProgress }) {
  const taskPrompt = [
    `You are taking over a task from Claude Code in ${cwd}.`,
    "Complete the user request and return a concise final result.",
    "Do not wrap the response in markdown fences unless the content needs it.",
    "",
    prompt
  ].join("\n");

  const normalizedPrompt = prompt?.trim() ? taskPrompt : DEFAULT_CONTINUE_PROMPT;
  const threadName = buildPersistentTaskThreadName(normalizedPrompt);
  const result = await runAppServerTurn(cwd, {
    prompt: normalizedPrompt,
    defaultPrompt: DEFAULT_CONTINUE_PROMPT,
    persistThread: true,
    threadName,
    model,
    effort,
    sandbox: readOnly ? codexReviewSandbox() : codexTaskSandbox(),
    onProgress
  });
  return {
    ok: result.status === 0,
    finalText: result.finalMessage,
    sessionRef: result.threadId,
    threadId: result.threadId,
    turnId: result.turnId,
    reasoningSummary: result.reasoningSummary,
    touchedFiles: result.touchedFiles
  };
}

async function resume({ cwd, prompt, resumeSessionRef, model, effort, readOnly = false, onProgress }) {
  const taskPrompt = [
    `You are taking over a task from Claude Code in ${cwd}.`,
    "Complete the user request and return a concise final result.",
    "Do not wrap the response in markdown fences unless the content needs it.",
    "",
    prompt
  ].join("\n");

  const normalizedPrompt = prompt?.trim() ? taskPrompt : DEFAULT_CONTINUE_PROMPT;
  const threadName = buildPersistentTaskThreadName(normalizedPrompt);
  const result = await runAppServerTurn(cwd, {
    prompt: normalizedPrompt,
    defaultPrompt: DEFAULT_CONTINUE_PROMPT,
    resumeThreadId: resumeSessionRef ?? null,
    persistThread: true,
    threadName,
    model,
    effort,
    sandbox: readOnly ? codexReviewSandbox() : codexTaskSandbox(),
    onProgress
  });
  return {
    ok: result.status === 0,
    finalText: result.finalMessage,
    sessionRef: result.threadId,
    threadId: result.threadId,
    turnId: result.turnId,
    reasoningSummary: result.reasoningSummary,
    touchedFiles: result.touchedFiles
  };
}

async function interrupt(cwd, job) {
  if (job?.threadId && job?.turnId) {
    return interruptAppServerTurn(cwd, {
      threadId: job.threadId,
      turnId: job.turnId
    });
  }

  return {
    attempted: false,
    interrupted: false,
    detail: "No engine-level interruption available."
  };
}

async function findResumeCandidate(cwd) {
  return findLatestTaskThread(cwd);
}

export const codexAdapter = {
  id: info.id,
  info,
  detect,
  review,
  task,
  resume,
  interrupt,
  capabilities,
  findResumeCandidate
};
