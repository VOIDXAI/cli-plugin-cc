import { parseStructuredOutput } from "../codex.mjs";
import {
  commandExists,
  createGeminiCliObserver,
  ENGINE_INFO,
  engineBin,
  envAuthStatus,
  normalizeReviewPayload,
  parseGeminiJsonOutput,
  resolveReviewRequest,
  runProcessWithScriptPty
} from "./shared.mjs";
import { buildCompletedEvent, createEngineRunController, getEngineCapabilities } from "./runtime.mjs";

const info = ENGINE_INFO.gemini;
const runtimeCapabilities = getEngineCapabilities(info.id);
const GEMINI_FAST_FAIL_PATTERNS = [
  /MODEL_CAPACITY_EXHAUSTED/i,
  /RESOURCE_EXHAUSTED/i,
  /No capacity available for model/i
];

function capabilities() {
  return {
    gate: info.supportsGate,
    resume: info.resume,
    ...runtimeCapabilities
  };
}

async function detect() {
  const available = await commandExists(engineBin(info.id));
  const auth = envAuthStatus(info, available);
  return {
    id: info.id,
    label: info.label,
    available,
    auth,
    capabilities: capabilities()
  };
}

function resolveGeminiModel(model) {
  const normalized = typeof model === "string" ? model.trim() : "";
  return normalized || null;
}

function shouldAbortGeminiOutput(combinedText) {
  return GEMINI_FAST_FAIL_PATTERNS.some((pattern) => pattern.test(combinedText));
}

function extractGeminiFailure(rawText, fallbackModel = null) {
  const text = String(rawText ?? "");
  const model =
    text.match(/"model"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/model\s+([a-z0-9.\-_]+)\s+on the server/i)?.[1] ??
    fallbackModel ??
    null;
  const code = text.match(/"code"\s*:\s*(\d+)/)?.[1] ?? null;
  const reason =
    text.match(/"reason"\s*:\s*"([^"]+)"/)?.[1] ??
    (shouldAbortGeminiOutput(text) ? "MODEL_CAPACITY_EXHAUSTED" : null);
  const message =
    text.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ??
    text.match(/No capacity available for model[^\n\r]*/i)?.[0] ??
    null;

  if (!model && !code && !reason && !message) {
    return null;
  }

  return {
    model,
    code,
    reason,
    message
  };
}

function formatGeminiFailure(details, fallbackText = "") {
  if (!details) {
    return fallbackText || "Gemini failed without returning a structured error.";
  }

  const parts = [];
  if (details.model) {
    parts.push(`model=${details.model}`);
  }
  if (details.code) {
    parts.push(`code=${details.code}`);
  }
  if (details.reason) {
    parts.push(`reason=${details.reason}`);
  }
  const headline = parts.length > 0 ? `Gemini request failed (${parts.join(", ")}).` : "Gemini request failed.";
  return details.message ? `${headline} ${details.message}` : headline;
}

async function runGeminiCommand({ cwd, args, model, onEvent }) {
  const resolvedModel = resolveGeminiModel(model);
  const finalArgs = [...args];
  if (resolvedModel && !args.includes("--model")) {
    finalArgs.push("--model", resolvedModel);
  }

  const observer = createGeminiCliObserver(onEvent);

  const result = await runProcessWithScriptPty({
    command: engineBin(info.id),
    args: finalArgs,
    cwd,
    onStdout: (chunk) => observer.pushStdout(chunk),
    onStderr: (chunk) => observer.pushStderr(chunk),
    abortOnOutput: ({ combined }) => (shouldAbortGeminiOutput(combined) ? "gemini-model-failure" : null)
  });
  observer.flush();
  const payload = parseGeminiJsonOutput(result.stdout, result.stderr);
  const failure = extractGeminiFailure(`${result.stdout}\n${result.stderr}`, resolvedModel);

  return {
    result,
    payload,
    model: resolvedModel,
    failure,
    ok: !result.aborted && result.code === 0 && !payload?.parsed?.error
  };
}

async function runReviewInternal({ kind, cwd, scope, baseRef, focusText, model, onEvent }) {
  const { target, prompt } = resolveReviewRequest({ cwd, scope, baseRef, kind, focusText });
  const { payload, model: resolvedModel, failure, ok } = await runGeminiCommand({
    cwd,
    model,
    onEvent,
    args: ["-p", prompt, "--output-format", "json", "--approval-mode", "plan"]
  });
  const parsed = ok ? parseStructuredOutput(payload.finalText) : { parsed: null, parseError: null };
  return {
    ok,
    finalText: ok ? payload.finalText : formatGeminiFailure(failure, payload.finalText),
    structured: ok ? normalizeReviewPayload(parsed.parsed) : null,
    parseError: parsed.parseError,
    sessionRef: payload.sessionRef,
    targetLabel: target.label,
    model: resolvedModel
  };
}

function buildTaskPrompt({ prompt, cwd }) {
  return [
    `You are taking over a task from Claude Code in ${cwd}.`,
    "Complete the user request and return a concise final result.",
    "Do not wrap the response in markdown fences unless the content needs it.",
    "",
    prompt
  ].join("\n");
}

async function runTaskInternal({ cwd, prompt, model, readOnly = false, onEvent }) {
  const { payload, model: resolvedModel, failure, ok } = await runGeminiCommand({
    cwd,
    model,
    onEvent,
    args: ["-p", buildTaskPrompt({ prompt, cwd }), "--output-format", "json", "--approval-mode", readOnly ? "plan" : "auto_edit"]
  });
  return {
    ok,
    finalText: ok ? payload.finalText : formatGeminiFailure(failure, payload.finalText),
    sessionRef: payload.sessionRef,
    model: resolvedModel
  };
}

async function runResumeInternal({ cwd, prompt, resumeSessionRef, model, readOnly = false, onEvent }) {
  const { payload, model: resolvedModel, failure, ok } = await runGeminiCommand({
    cwd,
    model,
    onEvent,
    args: [
      "-p",
      buildTaskPrompt({ prompt, cwd }),
      "--output-format",
      "json",
      "--approval-mode",
      readOnly ? "plan" : "auto_edit",
      "--resume",
      resumeSessionRef || "latest"
    ]
  });
  return {
    ok,
    finalText: ok ? payload.finalText : formatGeminiFailure(failure, payload.finalText),
    sessionRef: payload.sessionRef,
    model: resolvedModel
  };
}

function attachCapabilities(result, raw = null) {
  return {
    ...result,
    capabilities: capabilities(),
    raw
  };
}

function emitLifecycle(controller, result, options = {}) {
  if (options.includeSessionReady !== false && result.sessionRef) {
    controller.emit({
      type: "session_ready",
      phase: "starting",
      message: "Gemini session ready.",
      sessionRef: result.sessionRef
    });
  }
  if (result.structured) {
    controller.emit({
      type: "structured_review",
      phase: "finalizing",
      message: "Structured review output captured.",
      sessionRef: result.sessionRef ?? null,
      payload: result.structured
    });
  }
  controller.emit({
    type: result.ok ? "final_text" : "failure",
    phase: result.ok ? "finalizing" : "failed",
    message: result.ok ? "Gemini final output captured." : "Gemini run failed.",
    sessionRef: result.sessionRef ?? null,
    logTitle: result.ok ? "Final output" : "Failure",
    logBody: result.finalText ?? ""
  });
  controller.emit(buildCompletedEvent(result, "gemini"));
}

function startRun(request) {
  const state = {
    sessionReadyEmitted: false
  };
  const controller = createEngineRunController({
    engine: info.id,
    request,
    capabilities: capabilities(),
    cancel: async () => await interrupt()
  });

  controller.emit({
    type: "run_started",
    phase: "starting",
    message:
      request.kind === "review" || request.kind === "adversarial-review"
        ? "Invoking Gemini CLI for review."
        : "Invoking Gemini CLI for task."
  });

  const onEvent = (event) => {
    if (event?.type === "session_ready") {
      state.sessionReadyEmitted = true;
    }
    controller.emit(event);
  };

  void (async () => {
    try {
      const result =
        request.kind === "review" || request.kind === "adversarial-review"
          ? await runReviewInternal({ ...request, onEvent })
          : request.resume
            ? await runResumeInternal({ ...request, onEvent })
            : await runTaskInternal({ ...request, onEvent });

      const normalized = attachCapabilities(result, {
        sessionRef: result.sessionRef ?? null,
        model: result.model ?? null
      });
      emitLifecycle(controller, normalized, {
        includeSessionReady: !state.sessionReadyEmitted
      });
      controller.resolve(normalized);
    } catch (error) {
      controller.emit({
        type: "failure",
        phase: "failed",
        message: error instanceof Error ? error.message : String(error)
      });
      controller.emit(buildCompletedEvent({ ok: false }, "gemini"));
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

async function interrupt() {
  return {
    attempted: false,
    interrupted: false,
    detail: "No engine-level interruption available."
  };
}

export const geminiAdapter = {
  id: info.id,
  info,
  detect,
  startRun,
  review,
  task,
  resume,
  interrupt,
  capabilities
};
