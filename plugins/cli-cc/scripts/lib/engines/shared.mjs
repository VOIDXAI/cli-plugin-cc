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

export function parseGeminiJsonOutput(raw) {
  const parsed = parseMaybeJson(String(raw ?? "").trim()) ?? {};
  return {
    parsed,
    finalText: parsed.response ?? String(raw ?? "").trim(),
    sessionRef: parsed.session_id ?? parsed.sessionId ?? null
  };
}

export function normalizeReviewPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  if (typeof payload.verdict !== "string" || !Array.isArray(payload.findings)) {
    return null;
  }

  const findings = payload.findings.map((finding, index) => {
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
      title: typeof source.title === "string" ? source.title : `Finding ${index + 1}`,
      body:
        typeof source.body === "string"
          ? source.body
          : typeof source.summary === "string"
            ? source.summary
            : typeof source.description === "string"
              ? source.description
              : "No details provided.",
      file: typeof source.file === "string" ? source.file : "unknown",
      line_start: Number.isInteger(source.line_start) ? source.line_start : null,
      line_end: Number.isInteger(source.line_end) ? source.line_end : null,
      confidence:
        typeof source.confidence === "number"
          ? source.confidence
          : typeof source.confidence_score === "number"
            ? source.confidence_score
            : null,
      recommendation: typeof source.recommendation === "string" ? source.recommendation : ""
    };
  });

  return {
    verdict: payload.verdict,
    summary:
      typeof payload.summary === "string" && payload.summary.trim()
        ? payload.summary
        : findings.length > 0
          ? `${findings.length} material finding(s) reported.`
          : "No material issues found.",
    findings,
    next_steps: Array.isArray(payload.next_steps) ? payload.next_steps : []
  };
}

export function runProcess({ command, args, cwd, input, env, onStdout, onStderr }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      onStderr?.(text);
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, stdout, stderr }));

    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
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
