import path from "node:path";

import { writeExecutable } from "./helpers.mjs";

export function installFakeEngines(binDir) {
  const statePath = path.join(binDir, "fake-codex-state.json");
  const geminiLogPath = path.join(binDir, "fake-gemini-log.jsonl");
  const droidLogPath = path.join(binDir, "fake-droid-log.jsonl");
  const codexPath = path.join(binDir, "codex");
  const geminiPath = path.join(binDir, "gemini");
  const droidPath = path.join(binDir, "droid");

  writeExecutable(
    codexPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");

const STATE_PATH = ${JSON.stringify(statePath)};
const interruptibleTurns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextThreadId: 1, nextTurnId: 1, threads: [], events: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function recordEvent(state, type, payload) {
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({ type, payload });
  saveState(state);
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function buildThread(thread) {
  return {
    id: thread.id,
    preview: "",
    ephemeral: Boolean(thread.ephemeral),
    modelProvider: "openai",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    status: { type: "idle" },
    cwd: thread.cwd,
    source: "appServer",
    name: thread.name || null,
    turns: []
  };
}

function buildTurn(id, status = "inProgress") {
  return { id, status, items: [], error: null };
}

function nextThread(state, cwd, ephemeral) {
  const thread = {
    id: "thr_" + state.nextThreadId++,
    cwd: cwd || process.cwd(),
    name: null,
    ephemeral: Boolean(ephemeral),
    createdAt: now(),
    updatedAt: now()
  };
  state.threads.unshift(thread);
  saveState(state);
  return thread;
}

function ensureThread(state, threadId) {
  const thread = state.threads.find((entry) => entry.id === threadId);
  if (!thread) {
    throw new Error("unknown thread " + threadId);
  }
  return thread;
}

function nextTurnId(state) {
  const turnId = "turn_" + state.nextTurnId++;
  saveState(state);
  return turnId;
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  return JSON.stringify({
    verdict: "approve",
    summary: "No material issues found.",
    findings: [],
    next_steps: []
  });
}

function taskPayload(prompt, resumed) {
  if (prompt.includes("Run a stop-gate review of the previous Claude turn")) {
    return process.env.FAKE_STOP_GATE_DECISION === "BLOCK"
      ? "BLOCK: A blocking issue was found in the previous turn."
      : "ALLOW: No blocking issues found in the previous turn.";
  }
  if (resumed || prompt.includes("Continue from the current thread state")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }
  return "Handled the requested task.\\nTask prompt accepted.";
}

function emitTurnFinal(threadId, turnId, items, status = "completed") {
  send({ method: "turn/started", params: { threadId, turn: buildTurn(turnId) } });
  for (const item of items) {
    if (item.started) {
      send({ method: "item/started", params: { threadId, turnId, item: item.started } });
    }
    if (item.completed) {
      send({ method: "item/completed", params: { threadId, turnId, item: item.completed } });
    }
  }
  send({ method: "turn/completed", params: { threadId, turn: buildTurn(turnId, status) } });
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("codex-cli test");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  console.log("logged in");
  process.exit(0);
}
if (args[0] === "app-server" && args[1] === "--help") {
  console.log("fake app-server help");
  process.exit(0);
}
if (args[0] !== "app-server") {
  process.exit(1);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  const message = JSON.parse(line);
  const state = loadState();

  try {
    switch (message.method) {
      case "initialize":
        send({ id: message.id, result: { userAgent: "fake-codex-app-server" } });
        break;
      case "initialized":
        break;
      case "thread/start": {
        const thread = nextThread(state, message.params.cwd, message.params.ephemeral);
        recordEvent(state, "thread/start", message.params);
        send({ id: message.id, result: { thread: buildThread(thread) } });
        send({ method: "thread/started", params: { thread: { id: thread.id } } });
        break;
      }
      case "thread/name/set": {
        const thread = ensureThread(state, message.params.threadId);
        thread.name = message.params.name;
        thread.updatedAt = now();
        saveState(state);
        send({ id: message.id, result: {} });
        break;
      }
      case "thread/resume": {
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);
        recordEvent(state, "thread/resume", message.params);
        send({ id: message.id, result: { thread: buildThread(thread) } });
        break;
      }
      case "thread/list": {
        let threads = state.threads.slice();
        if (message.params.cwd) {
          threads = threads.filter((thread) => thread.cwd === message.params.cwd);
        }
        if (message.params.searchTerm) {
          threads = threads.filter((thread) => (thread.name || "").includes(message.params.searchTerm));
        }
        threads.sort((left, right) => right.updatedAt - left.updatedAt);
        send({ id: message.id, result: { data: threads.map(buildThread), nextCursor: null } });
        break;
      }
      case "review/start": {
        const turnId = nextTurnId(state);
        recordEvent(state, "review/start", message.params);
        const reviewText = process.env.FAKE_NATIVE_REVIEW_TEXT || "Reviewed current changes.\\nNo material issues found.";
        send({ id: message.id, result: { turn: buildTurn(turnId) } });
        emitTurnFinal(message.params.threadId, turnId, [
          {
            started: { type: "enteredReviewMode", id: turnId, review: "current changes" }
          },
          {
            completed: {
              type: "reasoning",
              id: "reasoning_" + turnId,
              summary: [{ text: "Reviewed the changed files and checked likely regression paths." }],
              content: []
            }
          },
            {
              completed: {
                type: "exitedReviewMode",
                id: turnId,
                review: reviewText
              }
            }
        ]);
        break;
      }
      case "turn/start": {
        const thread = ensureThread(state, message.params.threadId);
        thread.updatedAt = now();
        saveState(state);

        const prompt = (message.params.input || [])
          .filter((item) => item.type === "text")
          .map((item) => item.text)
          .join("\\n");
        recordEvent(state, "turn/start", {
          threadId: message.params.threadId,
          model: message.params.model ?? null,
          effort: message.params.effort ?? null,
          sandbox: message.params.sandbox ?? null,
          prompt,
          hasOutputSchema: Boolean(message.params.outputSchema)
        });
        const turnId = nextTurnId(state);
        const permissionFailure = process.env.FAKE_CODEX_PERMISSION_ERROR === "1" && !prompt.includes("Return only valid JSON");
        const payload = prompt.includes("Return only valid JSON")
          ? structuredReviewPayload(prompt)
          : permissionFailure
            ? "Sandbox blocked write access in workspace-write mode."
            : taskPayload(prompt, false);
        const delayMs = Number(process.env.FAKE_ENGINE_DELAY_MS || "0");

        send({ id: message.id, result: { turn: buildTurn(turnId) } });
        interruptibleTurns.set(turnId, { threadId: message.params.threadId, done: false });

        setTimeout(() => {
          const entry = interruptibleTurns.get(turnId);
          if (!entry || entry.done) {
            return;
          }
          entry.done = true;
          emitTurnFinal(message.params.threadId, turnId, [
            {
              completed: {
                type: "reasoning",
                id: "reasoning_" + turnId,
                summary: [{ text: "Checked the repository context and prepared the final response." }],
                content: []
              }
            },
            {
              completed: {
                type: "agentMessage",
                id: "agent_" + turnId,
                phase: "final_answer",
                text: payload
              }
            }
          ], permissionFailure ? "failed" : "completed");
        }, delayMs);
        break;
      }
      case "turn/interrupt": {
        const entry = interruptibleTurns.get(message.params.turnId);
        if (entry) {
          entry.done = true;
          send({ id: message.id, result: {} });
          send({
            method: "turn/completed",
            params: {
              threadId: message.params.threadId,
              turn: buildTurn(message.params.turnId, "interrupted")
            }
          });
        } else {
          send({ id: message.id, result: {} });
        }
        break;
      }
      default:
        send({ id: message.id, error: { code: -32601, message: "Unsupported method" } });
        break;
    }
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
`
  );

  writeExecutable(
    geminiPath,
    `#!/usr/bin/env node
const fs = require("node:fs");

const LOG_PATH = ${JSON.stringify(geminiLogPath)};

function getFlag(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\\n");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  appendLog({ args });
  if (args.includes("--version") || args.includes("-v")) {
    console.log("gemini-cli test");
    return;
  }

  const prompt = getFlag(args, "--prompt") || getFlag(args, "-p") || "";
  const resumeValue = getFlag(args, "--resume") || getFlag(args, "-r");
  const model = getFlag(args, "--model") || getFlag(args, "-m") || null;
  const delayMs = Number(process.env.FAKE_ENGINE_DELAY_MS || "0");
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  if (process.env.FAKE_GEMINI_ERROR_MESSAGE) {
    const failureModel = process.env.FAKE_GEMINI_ERROR_MODEL || model || "gemini-3.1-pro-preview";
    process.stdout.write(JSON.stringify({
      session_id: resumeValue || "gemini-session-123",
      error: {
        type: "Error",
        message: process.env.FAKE_GEMINI_ERROR_MESSAGE,
        code: Number(process.env.FAKE_GEMINI_ERROR_CODE || "1"),
        reason: process.env.FAKE_GEMINI_ERROR_REASON || "MODEL_CAPACITY_EXHAUSTED",
        model: failureModel
      }
    }) + "\\n");
    process.exit(Number(process.env.FAKE_GEMINI_ERROR_EXIT_CODE || "1"));
  }

  let response = "Gemini completed task.";
  if (prompt.includes("Return only valid JSON")) {
    if (process.env.FAKE_GEMINI_OVERALL_ASSESSMENT_REVIEW === "1") {
      const fence = String.fromCharCode(96).repeat(3);
      response = [
        fence + "json",
        JSON.stringify(
          {
            findings: [
              {
                affected_file: "src/app.js",
                line_start: 1,
                line_end: 3,
                confidence: 1,
                summary: "The prior review found the semantic inversion, but it understated the silent corruption risk to downstream callers.",
                recommendation: "Restore addition semantics or force an explicit API rename and caller migration."
              }
            ],
            overall_assessment: "needs-attention"
          },
          null,
          2
        ),
        fence
      ].join("\\n");
    } else if (process.env.FAKE_GEMINI_FINDING_TYPE_REVIEW === "1") {
      const fence = String.fromCharCode(96).repeat(3);
      response = [
        fence + "json",
        JSON.stringify(
          {
            finding_type: "needs-attention",
            summary: "This change introduces a critical, silent API contract violation that should not ship.",
            findings: [
              {
                file: "src/app.js",
                line_start: 2,
                line_end: 2,
                confidence: 1,
                description:
                  "Changing an exported sum helper from addition to subtraction silently breaks callers and corrupts downstream results.",
                recommendation: "Restore addition semantics or rename the API and update every caller."
              }
            ]
          },
          null,
          2
        ),
        fence
      ].join("\\n");
    } else if (process.env.FAKE_GEMINI_OUTCOME_REVIEW === "1") {
      const fence = String.fromCharCode(96).repeat(3);
      response = [
        fence + "json",
        JSON.stringify(
          {
            outcome: "needs-attention",
            summary: "Prior review found the right regression, but it understates the silent corruption risk.",
            findings: [
              {
                affected_file: "src/app.js",
                line_start: 2,
                line_end: 4,
                confidence: 0.98,
                recommendation:
                  "Call out that changing addition to subtraction silently corrupts results for every caller until the behavior is restored."
              }
            ]
          },
          null,
          2
        ),
        fence
      ].join("\\n");
    } else if (process.env.FAKE_GEMINI_FENCED_REVIEW === "1") {
      const fence = String.fromCharCode(96).repeat(3);
      response = [
        fence + "json",
        JSON.stringify(
          {
            verdict: "approved",
            findings: [
              {
                range: {
                  start_line: 2,
                  end_line: 4,
                  file: "src/app.js"
                },
                severity: "info",
                message: "Guarding empty arrays avoids an undefined access."
              }
            ]
          },
          null,
          2
        ),
        fence
      ].join("\\n");
    } else {
      response = JSON.stringify({
        verdict: "approve",
        summary: "Gemini review completed.",
        findings: [],
        next_steps: []
      });
    }
  } else if (prompt.includes("Run a stop-gate review of the previous Claude turn")) {
    response = process.env.FAKE_STOP_GATE_DECISION === "BLOCK"
      ? "BLOCK: A blocking issue was found in the previous turn."
      : "ALLOW: No blocking issues found in the previous turn.";
  } else if (resumeValue) {
    response = "Gemini resumed the prior session.";
  }

  process.stdout.write(JSON.stringify({
    response,
    session_id: resumeValue || "gemini-session-123"
  }) + "\\n");
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error.message));
  process.exit(1);
});
`
  );

  writeExecutable(
    droidPath,
    `#!/usr/bin/env node
const fs = require("node:fs");

const LOG_PATH = ${JSON.stringify(droidLogPath)};

function getFlag(args, name, alias = null) {
  const names = [name];
  if (alias) {
    names.push(alias);
  }
  for (const candidate of names) {
    const index = args.indexOf(candidate);
    if (index >= 0) {
      return args[index + 1];
    }
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(entry) {
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\\n");
}

async function main() {
  const args = process.argv.slice(2);
  appendLog({ args });
  if (args.includes("--version") || args.includes("-v") || args[0] === "--help") {
    console.log("droid test");
    return;
  }

  const outputFormat = getFlag(args, "--output-format", "-o") || "text";
  const sessionId = getFlag(args, "--session-id", "-s") || "droid-session-123";
  const prompt = args.at(-1) || "";
  const permissionError = process.env.FAKE_DROID_PERMISSION_ERROR === "1" && !prompt.includes("Return only valid JSON");
  const delayMs = Number(process.env.FAKE_ENGINE_DELAY_MS || "0");
  const emitInitBeforeDelay = process.env.FAKE_DROID_INIT_BEFORE_DELAY === "1" && outputFormat === "stream-json";
  if (emitInitBeforeDelay) {
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
  }
  if (delayMs > 0) {
    await sleep(delayMs);
  }

  let response = "Droid completed task.";
  if (prompt.includes("Return only valid JSON")) {
    response = JSON.stringify(
      process.env.FAKE_DROID_DECISION_ONLY === "1"
        ? {
            decision: "needs-attention",
            summary: "Droid decision-mode review found one issue.",
            findings: [
              {
                severity: "medium",
                title: "Missing guard",
                body: "Add an empty-state guard.",
                file: "src/app.js",
                recommendation: "Check for missing data before indexing."
              }
            ],
            next_steps: ["Add an empty-state test."]
          }
        : {
            verdict: "needs-attention",
            summary: "Droid review found one issue.",
            findings: [
              {
                severity: "medium",
                title: "Missing guard",
                body: "Add an empty-state guard.",
                file: "src/app.js",
                recommendation: "Check for missing data before indexing."
              }
            ],
            next_steps: ["Add an empty-state test."]
          }
    );
  } else if (prompt.includes("Run a stop-gate review of the previous Claude turn")) {
    response = process.env.FAKE_STOP_GATE_DECISION === "BLOCK"
      ? "BLOCK: A blocking issue was found in the previous turn."
      : "ALLOW: No blocking issues found in the previous turn.";
  } else if (permissionError) {
    response = "Exec ended early: insufficient permission to proceed. Re-run with --auto medium or --auto high. For destructive commands, use --skip-permissions-unsafe.";
  } else if (args.includes("--session-id") || args.includes("-s")) {
    response = "Droid resumed the prior session.";
  }

  if (outputFormat === "stream-json") {
    if (!emitInitBeforeDelay) {
      process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: sessionId }) + "\\n");
    }
    process.stdout.write(JSON.stringify({ type: "completion", finalText: response, session_id: sessionId }) + "\\n");
    if (permissionError) {
      process.exit(1);
    }
    return;
  }

  process.stdout.write(JSON.stringify({ finalText: response, session_id: sessionId }) + "\\n");
  if (permissionError) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error.message));
  process.exit(1);
});
`
  );

  return {
    codexStatePath: statePath,
    geminiLogPath,
    droidLogPath
  };
}
