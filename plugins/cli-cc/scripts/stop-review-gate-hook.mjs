#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectEngine } from "./lib/engines.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    return {
      last_assistant_message: raw
    };
  }
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate("stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

async function buildSetupNote(cwd, engine) {
  const status = await detectEngine(engine, cwd);
  if (status.available && status.auth.loggedIn) {
    return null;
  }

  const detail = status.auth.detail ? ` ${status.auth.detail}.` : "";
  return `${engine} is not set up for the review gate.${detail} Run /cc:setup --engine ${engine} and sign in if needed.`;
}

function parseStopReviewOutput(rawOutput, engine) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason: `The ${engine} stop-time review task returned no final output. Run /cc:review --engine ${engine} --wait manually or bypass the gate.`
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `${engine} stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason: `The ${engine} stop-time review task returned an unexpected answer. Run /cc:review --engine ${engine} --wait manually or bypass the gate.`
  };
}

function runStopReview(cwd, input = {}, engine = "codex") {
  const scriptPath = path.join(SCRIPT_DIR, "cli-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const result = spawnSync(process.execPath, [scriptPath, "gate", "--engine", engine, "--json", prompt], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason: `The ${engine} stop-time review task timed out after 15 minutes. Run /cc:review --engine ${engine} --wait manually or bypass the gate.`
    };
  }

  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    return {
      ok: false,
      reason: detail
        ? `The ${engine} stop-time review task failed: ${detail}`
        : `The ${engine} stop-time review task failed. Run /cc:review --engine ${engine} --wait manually or bypass the gate.`
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.finalText, engine);
  } catch {
    return {
      ok: false,
      reason: `The ${engine} stop-time review task returned invalid JSON. Run /cc:review --engine ${engine} --wait manually or bypass the gate.`
    };
  }
}

async function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const engine = config.stopReviewGateEngine || config.defaultEngine || "codex";

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => (job.status === "queued" || job.status === "running") && job.jobClass !== "gate");
  const runningTaskNote = runningJob
    ? `cli-plugin-cc job ${runningJob.id} is still running. Check /cc:status and use /cc:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = await buildSetupNote(cwd, engine);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input, engine);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
