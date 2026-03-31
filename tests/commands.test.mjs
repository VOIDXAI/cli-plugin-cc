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

test("commands expose a unified /cc surface with --engine", () => {
  const review = read("commands/review.md");
  const adversarialReview = read("commands/adversarial-review.md");
  const rescue = read("commands/rescue.md");
  const setup = read("commands/setup.md");
  const pluginManifest = read(".claude-plugin/plugin.json");

  assert.match(review, /--engine <codex\|gemini\|droid>/);
  assert.match(review, /--model <id>/);
  assert.match(review, /--effort none\|minimal\|low\|medium\|high\|xhigh/);
  assert.match(review, /cli-companion\.mjs" review/);
  assert.match(adversarialReview, /--engine <codex\|gemini\|droid>/);
  assert.match(adversarialReview, /--model <id>/);
  assert.match(adversarialReview, /--effort none\|minimal\|low\|medium\|high\|xhigh/);
  assert.match(adversarialReview, /cli-companion\.mjs" adversarial-review/);
  assert.match(rescue, /--engine <codex\|gemini\|droid>/);
  assert.match(rescue, /--model <id>/);
  assert.match(rescue, /cli-companion\.mjs" task/);
  assert.match(setup, /--engine <codex\|gemini\|droid>/);
  assert.match(setup, /--model <id>/);
  assert.match(setup, /--effort none\|minimal\|low\|medium\|high\|xhigh/);
  assert.match(setup, /--all/);
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

test("rescue agent is a thin forwarding wrapper", () => {
  const agent = read("agents/cc-rescue.md");
  assert.match(agent, /thin forwarder/i);
  assert.match(agent, /Do not inspect the repository/i);
  assert.match(agent, /Return the command stdout exactly as-is/i);
  assert.match(agent, /cli-companion\.mjs" task "\$ARGUMENTS"/);
});
