import { parseStructuredOutput } from "../codex.mjs";
import {
  commandExists,
  ENGINE_INFO,
  engineBin,
  envAuthStatus,
  mapReasoningEffortForDroid,
  normalizeReviewPayload,
  parseDroidStreamJson,
  resolveReviewRequest,
  runProcess
} from "./shared.mjs";

const info = ENGINE_INFO.droid;

function capabilities() {
  return {
    gate: info.supportsGate,
    resume: info.resume
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

async function review({ kind, cwd, scope, baseRef, focusText, model, effort }) {
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

  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
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

async function task({ cwd, prompt, model, effort, readOnly = false }) {
  const args = ["exec", "--cwd", cwd, "--output-format", "stream-json"];
  if (!readOnly) {
    args.push("--auto", "low");
  }
  if (model) {
    args.push("--model", model);
  }
  const mappedEffort = mapReasoningEffortForDroid(effort);
  if (mappedEffort) {
    args.push("--reasoning-effort", mappedEffort);
  }
  args.push(buildTaskPrompt({ prompt, cwd }));

  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
  const payload = parseDroidStreamJson(result.stdout);
  return {
    ok: result.code === 0,
    finalText: payload.finalText,
    sessionRef: payload.sessionRef
  };
}

async function resume({ cwd, prompt, resumeSessionRef, model, effort, readOnly = false }) {
  const args = ["exec", "--cwd", cwd, "--output-format", "stream-json"];
  if (!readOnly) {
    args.push("--auto", "low");
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

  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
  const payload = parseDroidStreamJson(result.stdout);
  return {
    ok: result.code === 0,
    finalText: payload.finalText,
    sessionRef: payload.sessionRef
  };
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
  review,
  task,
  resume,
  interrupt,
  capabilities
};
