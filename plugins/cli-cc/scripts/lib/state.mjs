import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { terminateProcessTree } from "./process.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "cli-plugin-cc");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      defaultEngine: "codex",
      stopReviewGate: false,
      stopReviewGateEngine: "codex",
      engineDefaults: {}
    },
    jobs: []
  };
}

function normalizeEngineDefaults(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const normalized = {};
  for (const [engine, defaults] of Object.entries(value)) {
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      continue;
    }
    normalized[engine] = {
      model: typeof defaults.model === "string" && defaults.model.trim() ? defaults.model.trim() : null,
      effort: typeof defaults.effort === "string" && defaults.effort.trim() ? defaults.effort.trim() : null
    };
  }
  return normalized;
}

function normalizeConfig(config) {
  return {
    ...defaultState().config,
    ...(config ?? {}),
    engineDefaults: normalizeEngineDefaults(config?.engineDefaults)
  };
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

export function resolveStateDir(cwd = process.cwd()) {
  if (process.env.CLI_PLUGIN_CC_DATA_DIR) {
    return process.env.CLI_PLUGIN_CC_DATA_DIR;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state", "cli-plugin-cc") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd = process.cwd()) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd = process.cwd()) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd = process.cwd()) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: normalizeConfig(parsed.config),
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);

  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: normalizeConfig(state.config),
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeFileIfExists(resolveJobFile(cwd, job.id));
    removeFileIfExists(resolveJobLogFile(cwd, job.id));
    removeFileIfExists(job.resultFile);
  }

  fs.writeFileSync(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
  return nextState;
}

export function updateState(cwd, mutate) {
  const state = loadState(cwd);
  mutate(state);
  return saveState(cwd, state);
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const index = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (index === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }

    state.jobs[index] = {
      ...state.jobs[index],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function readJob(cwd, jobId) {
  return listJobs(cwd).find((job) => job.id === jobId) ?? null;
}

export function readLatestJob(cwd) {
  return listJobs(cwd)[0] ?? null;
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function setConfig(cwd, partialOrKey, value) {
  return updateState(cwd, (state) => {
    state.config =
      typeof partialOrKey === "string"
        ? { ...state.config, [partialOrKey]: value }
        : { ...state.config, ...(partialOrKey ?? {}) };
  });
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function makeJobPaths(cwd, jobId) {
  return {
    logFile: resolveJobLogFile(cwd, jobId),
    resultFile: path.join(resolveJobsDir(cwd), `${jobId}.result.json`)
  };
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  fs.writeFileSync(jobFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

export function writeJobResult(job, result) {
  if (!job?.resultFile) {
    return;
  }
  fs.writeFileSync(job.resultFile, `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export function readJobResult(job) {
  if (!job?.resultFile || !fs.existsSync(job.resultFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(job.resultFile, "utf8"));
}

export function appendJobLog(job, chunk) {
  if (!job?.logFile || !chunk) {
    return;
  }
  fs.appendFileSync(job.logFile, String(chunk).endsWith("\n") ? String(chunk) : `${String(chunk)}\n`);
}

export function cleanupSessionState(cwd, sessionId) {
  if (!sessionId) {
    return;
  }

  return updateState(cwd, (state) => {
    const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
    for (const job of removedJobs) {
      const stillRunning = job.status === "queued" || job.status === "running";
      if (stillRunning) {
        try {
          terminateProcessTree(job.pid ?? Number.NaN);
        } catch {
          // Ignore teardown failures during session shutdown.
        }
      }

      removeFileIfExists(resolveJobFile(cwd, job.id));
      removeFileIfExists(resolveJobLogFile(cwd, job.id));
      removeFileIfExists(job.resultFile);
    }

    state.jobs = state.jobs.filter((job) => job.sessionId !== sessionId);
  });
}
