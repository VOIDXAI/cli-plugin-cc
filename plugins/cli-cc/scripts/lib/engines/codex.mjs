import {
  buildNativeReviewTarget,
  buildReviewSchema,
  codexReviewSandbox,
  codexTaskSandbox,
  ENGINE_INFO,
  resolveReviewRequest
} from "./shared.mjs";
import {
  buildCompletedEvent,
  createEngineRunController,
  getEngineCapabilities,
  progressEventToEngineEvent
} from "./runtime.mjs";
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
const runtimeCapabilities = getEngineCapabilities(info.id);

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
    resume: info.resume,
    ...runtimeCapabilities
  };
}

async function runReviewInternal({ kind, cwd, scope, baseRef, focusText, model, effort, onProgress }) {
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

async function runTaskInternal({ cwd, prompt, model, effort, readOnly = false, onProgress }) {
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

async function runResumeInternal({ cwd, prompt, resumeSessionRef, model, effort, readOnly = false, onProgress }) {
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

function emitResultLifecycle(controller, result, options = {}) {
  const includeSessionReady = options.includeSessionReady !== false;
  const sessionReadyMessage = options.sessionReadyMessage ?? "Codex session ready.";
  if (includeSessionReady && (result.sessionRef || result.threadId || result.turnId)) {
    controller.emit({
      type: "session_ready",
      phase: "starting",
      message: sessionReadyMessage,
      sessionRef: result.sessionRef ?? result.threadId ?? null,
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null
    });
  }

  if (result.structured) {
    controller.emit({
      type: "structured_review",
      phase: "finalizing",
      message: "Structured review output captured.",
      sessionRef: result.sessionRef ?? result.threadId ?? null,
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null,
      payload: result.structured
    });
  }

  controller.emit({
    type: result.ok ? "final_text" : "failure",
    phase: result.ok ? "finalizing" : "failed",
    message: result.ok ? "Codex final output captured." : "Codex run failed.",
    sessionRef: result.sessionRef ?? result.threadId ?? null,
    threadId: result.threadId ?? null,
    turnId: result.turnId ?? null,
    logTitle: result.ok ? "Final output" : "Failure",
    logBody: result.finalText ?? "",
    payload: result.ok ? null : { ok: false }
  });
  controller.emit(buildCompletedEvent(result, "codex"));
}

function buildProgressForwarder(controller, state) {
  return (value) => {
    const event = progressEventToEngineEvent(value);
    if (event.threadId && !state.threadId) {
      state.threadId = event.threadId;
    }
    if (event.turnId && !state.turnId) {
      state.turnId = event.turnId;
    }
    if (!state.sessionReadyEmitted && (event.sessionRef || event.threadId || event.turnId)) {
      state.sessionReadyEmitted = true;
      controller.emit({
        type: "session_ready",
        phase: event.phase ?? "starting",
        message: event.message || "Codex session ready.",
        sessionRef: event.sessionRef ?? event.threadId ?? null,
        threadId: event.threadId ?? null,
        turnId: event.turnId ?? null
      });
    }
    controller.emit(event);
  };
}

function attachCapabilities(result) {
  return {
    ...result,
    capabilities: capabilities(),
    raw: {
      threadId: result.threadId ?? null,
      turnId: result.turnId ?? null
    }
  };
}

function startRun(request) {
  const state = {
    threadId: null,
    turnId: null,
    sessionReadyEmitted: false
  };
  const controller = createEngineRunController({
    engine: info.id,
    request,
    capabilities: capabilities(),
    cancel: async () =>
      await interrupt(request.cwd, {
        threadId: state.threadId,
        turnId: state.turnId
      })
  });

  controller.emit({
    type: "run_started",
    phase: "starting",
    message:
      request.kind === "review" || request.kind === "adversarial-review"
        ? "Starting Codex review run."
        : "Starting Codex task run."
  });

  const onProgress = buildProgressForwarder(controller, state);
  void (async () => {
    try {
      const result =
        request.kind === "review" || request.kind === "adversarial-review"
          ? await runReviewInternal({ ...request, onProgress })
          : request.resume
            ? await runResumeInternal({ ...request, onProgress })
            : await runTaskInternal({ ...request, onProgress });

      if (result.threadId && !state.threadId) {
        state.threadId = result.threadId;
      }
      if (result.turnId && !state.turnId) {
        state.turnId = result.turnId;
      }
      if (!state.sessionReadyEmitted && (result.sessionRef || result.threadId || result.turnId)) {
        state.sessionReadyEmitted = true;
        controller.emit({
          type: "session_ready",
          phase: "starting",
          message: "Codex session ready.",
          sessionRef: result.sessionRef ?? result.threadId ?? null,
          threadId: result.threadId ?? null,
          turnId: result.turnId ?? null
        });
      }

      const normalized = attachCapabilities(result);
      emitResultLifecycle(controller, normalized, {
        includeSessionReady: !state.sessionReadyEmitted,
        sessionReadyMessage: "Codex session ready."
      });
      controller.resolve(normalized);
    } catch (error) {
      controller.emit({
        type: "failure",
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
        threadId: state.threadId,
        turnId: state.turnId
      });
      controller.emit(
        buildCompletedEvent(
          {
            ok: false,
            sessionRef: state.threadId,
            threadId: state.threadId,
            turnId: state.turnId
          },
          "codex"
        )
      );
      controller.reject(error);
    }
  })();

  return controller.handle;
}

async function review(args) {
  return startRun(args).result();
}

async function task(args) {
  return startRun({ ...args, resume: false }).result();
}

async function resume(args) {
  return startRun({ ...args, resume: true }).result();
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
  startRun,
  review,
  task,
  resume,
  interrupt,
  capabilities,
  findResumeCandidate
};
