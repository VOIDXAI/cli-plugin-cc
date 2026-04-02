import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { collectReviewContext, resolveReviewTarget } from "../git.mjs";
import { interpolateTemplate, loadPromptTemplate } from "../prompts.mjs";

export const ENGINE_INFO = {
  codex: {
    id: "codex",
    label: "Codex",
    supportsGate: true,
    resume: "native",
    authEnvVars: ["OPENAI_API_KEY"],
    authFiles: [".codex/auth.json", ".config/codex/auth.json"]
  },
  gemini: {
    id: "gemini",
    label: "Gemini",
    supportsGate: true,
    resume: "native",
    authEnvVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    authFiles: [".gemini/oauth_creds.json", ".config/gemini/oauth_creds.json"]
  },
  droid: {
    id: "droid",
    label: "Droid",
    supportsGate: true,
    resume: "native",
    authEnvVars: ["FACTORY_API_KEY"],
    authFiles: [".factory/session.json", ".config/factory/session.json", ".factory/auth.encrypted", ".factory/auth.v2.file"]
  }
};

export function engineBin(id) {
  const key =
    id === "codex"
      ? "CLI_PLUGIN_CC_CODEX_BIN"
      : id === "gemini"
        ? "CLI_PLUGIN_CC_GEMINI_BIN"
        : "CLI_PLUGIN_CC_DROID_BIN";
  return process.env[key] || id;
}

export function codexReviewSandbox() {
  return process.env.CLI_PLUGIN_CC_CODEX_REVIEW_SANDBOX ?? process.env.CLI_PLUGIN_CC_CODEX_SANDBOX ?? "danger-full-access";
}

export function codexTaskSandbox() {
  return process.env.CLI_PLUGIN_CC_CODEX_TASK_SANDBOX ?? process.env.CLI_PLUGIN_CC_CODEX_SANDBOX ?? "danger-full-access";
}

export function homeFileExists(relativePath) {
  return fs.existsSync(path.join(os.homedir(), relativePath));
}

export function buildReviewSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string" },
      summary: { type: "string" },
      findings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            severity: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
            file: { type: "string" },
            line_start: { type: "integer" },
            line_end: { type: "integer" },
            confidence: { type: "number" },
            recommendation: { type: "string" }
          },
          required: ["severity", "title", "body", "file", "recommendation"]
        }
      },
      next_steps: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["verdict", "summary", "findings", "next_steps"]
  };
}

export function buildGenericReviewPrompt(context, focusText) {
  const focus = focusText?.trim() || "General correctness, regressions, and ship risk.";
  return [
    "You are performing a software review.",
    `Target: ${context.target.label}`,
    `Focus: ${focus}`,
    "Return only valid JSON matching the provided schema.",
    "Use verdict=needs-attention when you find any material issue, otherwise approve.",
    "Every finding must be grounded in the provided repository context.",
    "",
    context.content
  ].join("\n");
}

export function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate("adversarial-review");
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText?.trim() || "No extra focus provided.",
    REVIEW_INPUT: context.content
  });
}

export function buildTaskPrompt({ prompt, cwd }) {
  return [
    `You are taking over a task from Claude Code in ${cwd}.`,
    "Complete the user request and return a concise final result.",
    "Do not wrap the response in markdown fences unless the content needs it.",
    "",
    prompt
  ].join("\n");
}

export function parseMaybeJson(raw) {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function extractSessionRef(text) {
  if (!text) {
    return null;
  }

  const patterns = [
    /"session_id"\s*:\s*"([^"]+)"/,
    /"sessionId"\s*:\s*"([^"]+)"/,
    /"thread_id"\s*:\s*"([^"]+)"/,
    /"threadId"\s*:\s*"([^"]+)"/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }
  return null;
}

export function mapReasoningEffortForDroid(effort) {
  if (!effort) {
    return null;
  }
  if (effort === "minimal") {
    return "none";
  }
  if (effort === "xhigh") {
    return "high";
  }
  return effort;
}

export function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }
  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }
  return null;
}

export function parseDroidStreamJson(raw) {
  const lines = String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionRef = null;
  let finalText = "";
  const events = [];

  for (const line of lines) {
    const parsed = parseMaybeJson(line);
    if (!parsed) {
      continue;
    }
    events.push(parsed);
    if (parsed.session_id) {
      sessionRef = parsed.session_id;
    }
    if (parsed.type === "completion") {
      finalText = parsed.finalText ?? finalText;
      sessionRef = parsed.session_id ?? sessionRef;
    }
  }

  return {
    events,
    finalText: finalText || lines.at(-1) || "",
    sessionRef
  };
}

export function createChunkLineCollector(onLine) {
  let buffer = "";

  function flushLine(line) {
    const normalized = String(line ?? "").trim();
    if (normalized) {
      onLine(normalized);
    }
  }

  return {
    push(chunk) {
      buffer += String(chunk ?? "");
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        flushLine(line);
        index = buffer.indexOf("\n");
      }
    },
    flush() {
      if (!buffer.trim()) {
        buffer = "";
        return;
      }
      flushLine(buffer);
      buffer = "";
    }
  };
}

function readEventTextFields(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return null;
  }

  const directMessage =
    typeof source.message === "string" && source.message.trim()
      ? source.message.trim()
      : typeof source.text === "string" && source.text.trim()
        ? source.text.trim()
        : typeof source.summary === "string" && source.summary.trim()
          ? source.summary.trim()
          : typeof source.title === "string" && source.title.trim()
            ? source.title.trim()
            : null;
  if (directMessage) {
    return directMessage;
  }

  if (Array.isArray(source.content)) {
    const text = source.content.find((entry) => entry && typeof entry.text === "string" && entry.text.trim());
    if (text?.text) {
      return text.text.trim();
    }
  }

  return null;
}

export function createDroidStreamObserver(onEvent) {
  let sessionRef = null;
  const collector = createChunkLineCollector((line) => {
    const parsed = parseMaybeJson(line);
    if (!parsed) {
      onEvent?.({
        type: "progress",
        phase: "running",
        message: line
      });
      return;
    }

    if (parsed.session_id && parsed.session_id !== sessionRef) {
      sessionRef = parsed.session_id;
      onEvent?.({
        type: "session_ready",
        phase: "starting",
        message: "Droid session ready.",
        sessionRef
      });
    }

    if (parsed.type === "completion") {
      return;
    }

    const message = readEventTextFields(parsed);
    if (message) {
      onEvent?.({
        type: parsed.type === "tool_call" || parsed.type === "tool" ? "tool_activity" : "progress",
        phase: parsed.type === "tool_call" || parsed.type === "tool" ? "running" : "investigating",
        message,
        sessionRef
      });
    }
  });

  return {
    pushStdout(chunk) {
      collector.push(chunk);
    },
    flush() {
      collector.flush();
    }
  };
}

export function createGeminiCliObserver(onEvent) {
  let sessionRef = null;

  function handleLine(line, source) {
    const parsed = parseMaybeJson(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const nextSessionRef = parsed.session_id ?? parsed.sessionId ?? null;
      if (nextSessionRef && nextSessionRef !== sessionRef) {
        sessionRef = nextSessionRef;
        onEvent?.({
          type: "session_ready",
          phase: "starting",
          message: "Gemini session ready.",
          sessionRef
        });
      }
      return;
    }

    onEvent?.({
      type: source === "stderr" ? "warning" : "progress",
      phase: source === "stderr" ? "running" : "investigating",
      message: line,
      stderrMessage: source === "stderr" ? line : null,
      sessionRef
    });
  }

  const stdoutCollector = createChunkLineCollector((line) => handleLine(line, "stdout"));
  const stderrCollector = createChunkLineCollector((line) => handleLine(line, "stderr"));

  return {
    pushStdout(chunk) {
      stdoutCollector.push(chunk);
    },
    pushStderr(chunk) {
      stderrCollector.push(chunk);
    },
    flush() {
      stdoutCollector.flush();
      stderrCollector.flush();
    }
  };
}

export function extractTrailingJsonObject(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const candidateIndexes = [];
  if (text.startsWith("{")) {
    candidateIndexes.push(0);
  }

  const lineStartJson = /\n\{/g;
  let match;
  while ((match = lineStartJson.exec(text)) !== null) {
    candidateIndexes.push(match.index + 1);
  }

  for (let index = candidateIndexes.length - 1; index >= 0; index -= 1) {
    const candidate = text.slice(candidateIndexes[index]).trim();
    const parsed = parseMaybeJson(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return {
        parsed,
        raw: candidate
      };
    }
  }

  return null;
}

export function parseGeminiJsonOutput(raw, stderr = "") {
  const stdoutText = String(raw ?? "").trim();
  const stderrText = String(stderr ?? "").trim();
  const combinedText = [stdoutText, stderrText].filter(Boolean).join("\n");
  const extracted =
    extractTrailingJsonObject(stdoutText) ??
    extractTrailingJsonObject(combinedText) ??
    null;
  const parsed = extracted?.parsed ?? {};

  const errorMessage =
    typeof parsed?.error?.message === "string" && parsed.error.message.trim() ? parsed.error.message.trim() : null;
  const responseText = typeof parsed?.response === "string" && parsed.response.trim() ? parsed.response.trim() : null;

  return {
    parsed,
    finalText: responseText ?? errorMessage ?? stdoutText ?? stderrText,
    sessionRef: parsed.session_id ?? parsed.sessionId ?? null
  };
}

export function normalizeReviewPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const sourceFindings = Array.isArray(payload.findings)
    ? payload.findings
    : Array.isArray(payload.reviews)
      ? payload.reviews
      : Array.isArray(payload.sub_findings)
        ? payload.sub_findings
        : null;
  const verdict =
    typeof payload.verdict === "string"
      ? payload.verdict
      : typeof payload.decision === "string"
        ? payload.decision
        : typeof payload.outcome === "string"
          ? payload.outcome
          : typeof payload.finding_type === "string"
            ? payload.finding_type
            : typeof payload.overall_assessment === "string"
              ? payload.overall_assessment
        : null;
  if (!verdict || !sourceFindings) {
    return null;
  }

  const findings = sourceFindings.map((finding, index) => {
    const source = finding && typeof finding === "object" ? finding : {};
    return {
      severity:
        typeof source.severity === "string"
          ? source.severity
          : typeof source.priority === "number"
            ? source.priority <= 1
              ? "high"
              : source.priority === 2
                ? "medium"
                : "low"
            : "medium",
      title:
        typeof source.title === "string"
          ? source.title
          : typeof source.headline === "string"
            ? source.headline
            : typeof source.affected_file === "string"
              ? `Issue in ${source.affected_file}`
              : `Finding ${index + 1}`,
      body:
        typeof source.body === "string"
          ? source.body
          : typeof source.summary === "string"
            ? source.summary
            : typeof source.description === "string"
              ? source.description
              : typeof source.message === "string"
                ? source.message
                : typeof source.review_comment === "string"
                  ? source.review_comment
                  : typeof source.recommendation === "string"
                    ? source.recommendation
                    : "No details provided.",
      file:
        typeof source.file === "string"
          ? source.file
          : typeof source.range?.file === "string"
            ? source.range.file
            : typeof source.file_path === "string"
              ? source.file_path
              : typeof source.affected_file === "string"
                ? source.affected_file
            : "unknown",
      line_start:
        Number.isInteger(source.line_start)
          ? source.line_start
          : Number.isInteger(source.range?.start_line)
            ? source.range.start_line
            : Number.isInteger(source.line_number)
              ? source.line_number
            : null,
      line_end:
        Number.isInteger(source.line_end)
          ? source.line_end
          : Number.isInteger(source.range?.end_line)
            ? source.range.end_line
            : Number.isInteger(source.line_number)
              ? source.line_number
            : null,
      confidence:
        typeof source.confidence === "number"
          ? source.confidence
          : typeof source.confidence_score === "number"
            ? source.confidence_score
            : null,
      recommendation: typeof source.recommendation === "string" ? source.recommendation : ""
    };
  });
  const findingSummary = sourceFindings.find((finding) => typeof finding?.summary === "string" && finding.summary.trim())?.summary ?? null;

  return {
    verdict,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary
        : typeof payload.comment === "string" && payload.comment.trim()
          ? payload.comment
          : typeof payload.reason === "string" && payload.reason.trim()
            ? payload.reason
            : findingSummary
              ? findingSummary
              : findings.length > 0
                ? `${findings.length} material finding(s) reported.`
                : "No material issues found.",
    findings,
    next_steps: Array.isArray(payload.next_steps) ? payload.next_steps : []
  };
}

export function quoteShellArg(value) {
  const text = String(value ?? "");
  if (!text) {
    return "''";
  }
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(command, args = []) {
  return [command, ...args].map(quoteShellArg).join(" ");
}

export function runProcess({ command, args, cwd, input, env, onStdout, onStderr, abortOnOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    let aborted = false;
    let abortReason = null;

    const triggerAbort = (source, chunk) => {
      if (aborted || typeof abortOnOutput !== "function") {
        return;
      }

      const maybeReason = abortOnOutput({
        source,
        chunk,
        stdout,
        stderr,
        combined: [stdout, stderr].filter(Boolean).join("\n")
      });

      if (!maybeReason) {
        return;
      }

      aborted = true;
      abortReason = typeof maybeReason === "string" ? maybeReason : "aborted";
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 1000);
      killTimer.unref?.();
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
      triggerAbort("stdout", text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
      triggerAbort("stderr", text);
    });

    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, aborted, abortReason }));

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

let hasScriptPromise = null;

export async function supportsScriptPty() {
  if (process.platform === "win32") {
    return false;
  }
  if (!hasScriptPromise) {
    hasScriptPromise = commandExists("script");
  }
  return hasScriptPromise;
}

export async function runProcessWithScriptPty({ command, args, cwd, env, onStdout, onStderr, abortOnOutput }) {
  if (!(await supportsScriptPty())) {
    return runProcess({
      command,
      args,
      cwd,
      env,
      onStdout,
      onStderr,
      abortOnOutput
    });
  }

  return runProcess({
    command: "script",
    args: ["-qefc", buildShellCommand(command, args), "/dev/null"],
    cwd,
    env,
    onStdout,
    onStderr,
    abortOnOutput
  });
}

export function envAuthStatus(info, available) {
  const loggedIn = info.authEnvVars.some((name) => process.env[name]) || info.authFiles.some(homeFileExists);
  return {
    status: loggedIn ? "logged-in" : available ? "unknown" : "unavailable",
    loggedIn
  };
}

export async function commandExists(command) {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("where", [command], { stdio: "ignore" })
        : spawn("bash", ["-lc", `command -v "${command}" >/dev/null 2>&1`], {
            stdio: "ignore"
          });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

export function resolveReviewRequest({ cwd, scope, baseRef, kind, focusText }) {
  const target = resolveReviewTarget(cwd, {
    scope: scope || "auto",
    base: baseRef ?? null
  });
  const context = collectReviewContext(cwd, target);
  const prompt =
    kind === "adversarial-review"
      ? buildAdversarialReviewPrompt(context, focusText)
      : buildGenericReviewPrompt(context, focusText);

  return {
    target,
    context,
    prompt
  };
}
