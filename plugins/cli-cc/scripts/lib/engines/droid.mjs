import { parseStructuredOutput } from "../codex.mjs";
import {
  commandExists,
  createDroidStreamObserver,
  ENGINE_INFO,
  engineBin,
  envAuthStatus,
  mapReasoningEffortForDroid,
  normalizeReviewPayload,
  parseDroidStreamJson,
  resolveReviewRequest,
  runProcess
} from "./shared.mjs";
import { buildCompletedEvent, createEngineRunController, getEngineCapabilities } from "./runtime.mjs";
import { appendTaskPermissionFailureGuidance, buildTaskPermissionProfile } from "../permissions.mjs";

const info = ENGINE_INFO.droid;
const runtimeCapabilities = getEngineCapabilities(info.id);

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

async function runDroidCommand({ cwd, args, onEvent }) {
  const observer = createDroidStreamObserver(onEvent);
  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd,
    onStdout: (chunk) => observer.pushStdout(chunk)
  });
  observer.flush();
  return result;
}

async function runReviewInternal({ kind, cwd, scope, baseRef, focusText, model, effort, onEvent }) {
  const { target, prompt } = resolveReviewRequest({ cwd, scope, baseRef, kind, focusText });
  const args = ["exec", "--cwd", cwd, "--output-format", "stream-json"];
  if (model) {
    args.push("--model", model);
  }
  const mappedEffort = mapReasoningEffortForDroid(effort);
  if (mappedEffort) {
    args.push("--reasoning-effort", mappedEffort);
  }
  args.push(prompt);

  const result = await runDroidCommand({ cwd, args, onEvent });
  const payload = parseDroidStreamJson(result.stdout);
  const parsed = parseStructuredOutput(payload.finalText);
  return {
    ok: result.code === 0,
    finalText: payload.finalText,
    structured: normalizeReviewPayload(parsed.parsed),
    parseError: parsed.parseError,
    sessionRef: payload.sessionRef,
    targetLabel: target.label
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

async function runTaskInternal({ cwd, prompt, model, effort, readOnly = false, permission = null, onEvent }) {
  const args = ["exec", "--cwd", cwd, "--output-format", "stream-json"];
  if (!readOnly) {
    const permissionProfile = buildTaskPermissionProfile(info.id, permission);
    if (permissionProfile.skipPermissionsUnsafe) {
      args.push("--skip-permissions-unsafe");
    } else if (permissionProfile.autoMode) {
      args.push("--auto", permissionProfile.autoMode);
    }
  }
  if (model) {
    args.push("--model", model);
  }
  const mappedEffort = mapReasoningEffortForDroid(effort);
  if (mappedEffort) {
    args.push("--reasoning-effort", mappedEffort);
  }
  args.push(buildTaskPrompt({ prompt, cwd }));

  const result = await runDroidCommand({ cwd, args, onEvent });
  const payload = parseDroidStreamJson(result.stdout);
  return {
    ok: result.code === 0,
    finalText:
      result.code === 0
        ? payload.finalText
        : appendTaskPermissionFailureGuidance(
            info.id,
            permission,
            [payload.finalText, result.stderr].filter(Boolean).join("\n").trim() || "Droid run failed."
          ),
    sessionRef: payload.sessionRef
  };
}

async function runResumeInternal({ cwd, prompt, resumeSessionRef, model, effort, readOnly = false, permission = null, onEvent }) {
  const args = ["exec", "--cwd", cwd, "--output-format", "stream-json"];
  if (!readOnly) {
    const permissionProfile = buildTaskPermissionProfile(info.id, permission);
    if (permissionProfile.skipPermissionsUnsafe) {
      args.push("--skip-permissions-unsafe");
    } else if (permissionProfile.autoMode) {
      args.push("--auto", permissionProfile.autoMode);
    }
  }
  if (model) {
    args.push("--model", model);
  }
  const mappedEffort = mapReasoningEffortForDroid(effort);
  if (mappedEffort) {
    args.push("--reasoning-effort", mappedEffort);
  }
  if (resumeSessionRef) {
    args.push("--session-id", resumeSessionRef);
  }
  args.push(buildTaskPrompt({ prompt, cwd }));

  const result = await runDroidCommand({ cwd, args, onEvent });
  const payload = parseDroidStreamJson(result.stdout);
  return {
    ok: result.code === 0,
    finalText:
      result.code === 0
        ? payload.finalText
        : appendTaskPermissionFailureGuidance(
            info.id,
            permission,
            [payload.finalText, result.stderr].filter(Boolean).join("\n").trim() || "Droid run failed."
          ),
    sessionRef: payload.sessionRef
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
      message: "Droid session ready.",
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
    message: result.ok ? "Droid final output captured." : "Droid run failed.",
    sessionRef: result.sessionRef ?? null,
    logTitle: result.ok ? "Final output" : "Failure",
    logBody: result.finalText ?? ""
  });
  controller.emit(buildCompletedEvent(result, "droid"));
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
        ? "Invoking Droid CLI for review."
        : "Invoking Droid CLI for task."
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
        sessionRef: result.sessionRef ?? null
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
      controller.emit(buildCompletedEvent({ ok: false }, "droid"));
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

export const droidAdapter = {
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
