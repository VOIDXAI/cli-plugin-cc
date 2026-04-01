import fs from "node:fs";
import process from "node:process";

import { readJobFile, resolveJobFile, resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";

export const SESSION_ID_ENV = "CLI_PLUGIN_CC_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      sessionRef: typeof value.sessionRef === "string" && value.sessionRef.trim() ? value.sessionRef.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd(),
      ownerState: value.ownerState && typeof value.ownerState === "object" && !Array.isArray(value.ownerState) ? value.ownerState : null
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    sessionRef: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null,
    ownerState: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastSessionRef = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastOwnerStateKey = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.sessionRef && normalized.sessionRef !== lastSessionRef) {
      lastSessionRef = normalized.sessionRef;
      patch.sessionRef = normalized.sessionRef;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.ownerState) {
      const ownerStateKey = JSON.stringify(normalized.ownerState);
      if (ownerStateKey !== lastOwnerStateKey) {
        lastOwnerStateKey = ownerStateKey;
        patch.ownerState = normalized.ownerState;
        changed = true;
      }
    }

    if (!changed) {
      return;
    }

    upsertJob(workspaceRoot, patch);

    const jobFile = resolveJobFile(workspaceRoot, jobId);
    if (!fs.existsSync(jobFile)) {
      return;
    }

    const storedJob = readJobFile(jobFile);
    writeJobFile(workspaceRoot, jobId, {
      ...storedJob,
      ...patch
    });
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[cli-plugin-cc] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    ownerState: job.ownerState ? { ...job.ownerState, state: "running" } : null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  try {
    const execution = await runner();
    const completionStatus = execution.exitStatus === 0 ? "completed" : execution.exitStatus === 130 ? "cancelled" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      status: completionStatus,
      threadId: execution.threadId ?? runningRecord.threadId ?? null,
      turnId: execution.turnId ?? runningRecord.turnId ?? null,
      sessionRef: execution.sessionRef ?? runningRecord.sessionRef ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      completedAt,
      capabilities: execution.capabilities ?? runningRecord.capabilities ?? null,
      ownerState:
        execution.ownerState ??
        (runningRecord.ownerState
          ? {
              ...runningRecord.ownerState,
              state: completionStatus,
              sessionRef: execution.sessionRef ?? runningRecord.sessionRef ?? null,
              threadId: execution.threadId ?? runningRecord.threadId ?? null,
              turnId: execution.turnId ?? runningRecord.turnId ?? null
            }
          : null),
      result: execution.payload,
      rendered: execution.rendered,
      summary: execution.summary ?? runningRecord.summary ?? null,
      note: execution.note ?? runningRecord.note ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      sessionRef: execution.sessionRef ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      capabilities: execution.capabilities ?? null,
      ownerState: execution.ownerState ?? null,
      pid: null,
      completedAt
    });
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered ?? execution.summary ?? "");
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: "failed",
      phase: "failed",
      errorMessage,
      pid: null,
      completedAt,
      ownerState: existing.ownerState ? { ...existing.ownerState, state: "failed" } : existing.ownerState ?? null,
      logFile: options.logFile ?? job.logFile ?? existing.logFile ?? null
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: "failed",
      phase: "failed",
      ownerState: existing.ownerState ? { ...existing.ownerState, state: "failed" } : existing.ownerState ?? null,
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}
