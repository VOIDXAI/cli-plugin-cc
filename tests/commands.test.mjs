import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "cli-cc");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /review-only/i);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /return the engine output verbatim to the user/i);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /--engine <codex\|gemini\|droid\|auto>/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\]/);
  assert.match(source, /--engine auto.*valid/i);
  assert.match(source, /prefer-auto/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /does not support custom focus text/i);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /Do not call `BashOutput`/);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /review-only/i);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /return the engine output verbatim to the user/i);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /--engine <codex\|gemini\|droid\|auto>/);
  assert.match(source, /\[focus \.\.\.\]/);
  assert.match(source, /uses the same review target selection as `\/cc:review`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /--engine auto.*valid/i);
  assert.match(source, /prefer-auto/i);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /Do not call `BashOutput`/);
});

test("matrix-review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/matrix-review.md");

  assert.match(source, /disable-model-invocation:\s*true/);
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /review-only/i);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /matrix-review "\$ARGUMENTS"/);
  assert.match(source, /--engines <codex,gemini,droid>/);
  assert.match(source, /uses the configured `\/cc:policy` matrix-review engines/i);
  assert.match(source, /Recommend background by default because matrix review runs multiple engines/i);
  assert.match(source, /Run in background/);
  assert.match(source, /Wait for results/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /Do not call `BashOutput`/);
});

test("commands keep the unified /cc surface", () => {
  const orchestrate = read("commands/orchestrate.md");
  const policy = read("commands/policy.md");
  const memory = read("commands/memory.md");
  const replay = read("commands/replay.md");
  const rescue = read("commands/rescue.md");
  const setup = read("commands/setup.md");
  const status = read("commands/status.md");
  const pluginManifest = read(".claude-plugin/plugin.json");

  assert.match(orchestrate, /setup --all --json/);
  assert.match(orchestrate, /git status --short --untracked-files=all/);
  assert.match(orchestrate, /Do not execute anything until the user chooses `Execute plan`/);
  assert.match(orchestrate, /Execute plan/);
  assert.match(orchestrate, /Adjust plan/);
  assert.match(orchestrate, /Cancel/);
  assert.match(orchestrate, /assignmentSource:\s*"manual"/);
  assert.match(orchestrate, /engine:\s*"auto"/);
  assert.match(orchestrate, /supported step engines: `codex`, `gemini`, `droid`, `auto`/);
  assert.match(orchestrate, /orchestrate --plan-file/);
  assert.match(rescue, /--engine <codex\|gemini\|droid\|auto>/);
  assert.match(rescue, /--model <id>/);
  assert.match(rescue, /--permission <read-only\|edit\|dev\|full\|unsafe>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /Continue current engine thread/);
  assert.match(rescue, /Start a new engine thread/);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /runtime-selection flags/i);
  assert.match(rescue, /prefer-auto/i);
  assert.match(setup, /setup --json \$ARGUMENTS/);
  assert.match(setup, /--permission <read-only\|edit\|dev\|full\|unsafe>/);
  assert.match(setup, /npm install -g @openai\/codex/);
  assert.match(setup, /!codex login/);
  assert.match(status, /\[--timeout-ms <ms>\]/);
  assert.match(status, /single Markdown table/i);
  assert.match(policy, /cli-companion\.mjs" policy \$ARGUMENTS/);
  assert.match(policy, /disable-model-invocation:\s*true/);
  assert.match(memory, /cli-companion\.mjs" memory \$ARGUMENTS/);
  assert.match(memory, /disable-model-invocation:\s*true/);
  assert.match(replay, /cli-companion\.mjs" replay \$ARGUMENTS/);
  assert.match(replay, /disable-model-invocation:\s*true/);
  assert.match(pluginManifest, /"name": "cc"/);
});

test("hooks wire Claude lifecycle events", () => {
  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.match(hooks, /Stop/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);
  assert.match(hooks, /stop-review-gate-hook\.mjs/);
});

test("rescue agent remains a thin forwarding wrapper with engine-aware routing hints", () => {
  const agent = read("agents/cc-rescue.md");

  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /prefer foreground for a small, clearly bounded rescue request/i);
  assert.match(agent, /prefer background execution/i);
  assert.match(agent, /Do not inspect the repository/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Return the stdout of the `cli-companion` command exactly as-is/i);
});
