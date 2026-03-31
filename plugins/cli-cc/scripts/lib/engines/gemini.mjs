import { parseStructuredOutput } from "../codex.mjs";
import {
  commandExists,
  ENGINE_INFO,
  engineBin,
  envAuthStatus,
  normalizeReviewPayload,
  parseGeminiJsonOutput,
  resolveReviewRequest,
  runProcess
} from "./shared.mjs";

const info = ENGINE_INFO.gemini;

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

async function review({ kind, cwd, scope, baseRef, focusText, model }) {
  const { target, prompt } = resolveReviewRequest({ cwd, scope, baseRef, kind, focusText });
  const args = ["-p", prompt, "--output-format", "json", "--approval-mode", "plan"];
  if (model) {
    args.push("--model", model);
  }
  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
  const payload = parseGeminiJsonOutput(result.stdout);
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

async function task({ cwd, prompt, model, readOnly = false }) {
  const args = ["-p", buildTaskPrompt({ prompt, cwd }), "--output-format", "json", "--approval-mode", readOnly ? "plan" : "auto_edit"];
  if (model) {
    args.push("--model", model);
  }
  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
  const payload = parseGeminiJsonOutput(result.stdout);
  return {
    ok: result.code === 0,
    finalText: payload.finalText,
    sessionRef: payload.sessionRef
  };
}

async function resume({ cwd, prompt, resumeSessionRef, model, readOnly = false }) {
  const args = ["-p", buildTaskPrompt({ prompt, cwd }), "--output-format", "json", "--approval-mode", readOnly ? "plan" : "auto_edit"];
  if (model) {
    args.push("--model", model);
  }
  args.push("--resume", resumeSessionRef || "latest");
  const result = await runProcess({
    command: engineBin(info.id),
    args,
    cwd
  });
  const payload = parseGeminiJsonOutput(result.stdout);
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

export const geminiAdapter = {
  id: info.id,
  info,
  detect,
  review,
  task,
  resume,
  interrupt,
  capabilities
};
