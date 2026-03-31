import { codexAdapter } from "./codex.mjs";
import { droidAdapter } from "./droid.mjs";
import { geminiAdapter } from "./gemini.mjs";

export const ENGINE_ADAPTERS = {
  codex: codexAdapter,
  gemini: geminiAdapter,
  droid: droidAdapter
};

export function listSupportedEngines() {
  return Object.values(ENGINE_ADAPTERS).map((adapter) => adapter.info);
}

export function normalizeEngine(engineId) {
  return engineId || "codex";
}

export function getEngineAdapter(engineId) {
  const normalized = normalizeEngine(engineId);
  const adapter = ENGINE_ADAPTERS[normalized];
  if (!adapter) {
    throw new Error(`Unsupported engine: ${engineId}`);
  }
  return adapter;
}

export function getEngineInfo(engineId) {
  return getEngineAdapter(engineId).info;
}

export function getResumeMode(engineId) {
  return getEngineInfo(engineId).resume;
}

export function supportsGate(engineId) {
  return getEngineInfo(engineId).supportsGate;
}

export async function detectEngine(engineId, cwd = process.cwd()) {
  return getEngineAdapter(engineId).detect(cwd);
}

export async function interruptEngineJob(cwd, job) {
  return getEngineAdapter(job?.engine).interrupt(cwd, job);
}

export async function runReview(args) {
  const adapter = getEngineAdapter(args.engine);
  return adapter.review(args);
}

export async function runTask(args) {
  const adapter = getEngineAdapter(args.engine);
  if (args.resume && typeof adapter.resume === "function") {
    return adapter.resume(args);
  }
  return adapter.task(args);
}

export async function findResumeCandidate(engine, cwd) {
  const adapter = getEngineAdapter(engine);
  if (typeof adapter.findResumeCandidate === "function") {
    return adapter.findResumeCandidate(cwd);
  }
  return null;
}
