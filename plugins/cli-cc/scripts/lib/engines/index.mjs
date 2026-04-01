import { codexAdapter } from "./codex.mjs";
import { droidAdapter } from "./droid.mjs";
import { geminiAdapter } from "./gemini.mjs";
import { buildSessionOwnerState, engineEventToProgress, getEngineCapabilities } from "./runtime.mjs";

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

export function getEngineRuntimeCapabilities(engineId) {
  return getEngineCapabilities(normalizeEngine(engineId));
}

export function createEngineOwnerState(engineId, state = "queued", overrides = {}) {
  return buildSessionOwnerState(normalizeEngine(engineId), state, overrides);
}

export { engineEventToProgress };

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

export function startEngineRun(args) {
  const adapter = getEngineAdapter(args.engine);
  if (typeof adapter.startRun !== "function") {
    throw new Error(`Engine ${args.engine} does not implement startRun().`);
  }
  return adapter.startRun(args);
}

export async function runReview(args) {
  return startEngineRun(args).result();
}

export async function runTask(args) {
  return startEngineRun(args).result();
}

export async function findResumeCandidate(engine, cwd) {
  const adapter = getEngineAdapter(engine);
  if (typeof adapter.findResumeCandidate === "function") {
    return adapter.findResumeCandidate(cwd);
  }
  return null;
}
