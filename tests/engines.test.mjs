import test from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_ADAPTERS,
  createEngineOwnerState,
  getEngineInfo,
  getEngineRuntimeCapabilities,
  listSupportedEngines,
  normalizeEngine,
  supportsGate
} from "../plugins/cli-cc/scripts/lib/engines.mjs";
import { buildReviewSchema, normalizeReviewPayload } from "../plugins/cli-cc/scripts/lib/engines/shared.mjs";

test("engine registry exposes the expected adapters", () => {
  assert.deepEqual(Object.keys(ENGINE_ADAPTERS).sort(), ["codex", "droid", "gemini"]);
  assert.deepEqual(
    listSupportedEngines()
      .map((engine) => engine.id)
      .sort(),
    ["codex", "droid", "gemini"]
  );
});

test("each engine adapter implements the shared adapter surface", () => {
  for (const adapter of Object.values(ENGINE_ADAPTERS)) {
    assert.equal(typeof adapter.detect, "function");
    assert.equal(typeof adapter.startRun, "function");
    assert.equal(typeof adapter.review, "function");
    assert.equal(typeof adapter.task, "function");
    assert.equal(typeof adapter.resume, "function");
    assert.equal(typeof adapter.interrupt, "function");
    assert.equal(typeof adapter.capabilities, "function");
    assert.equal(adapter.info.id, adapter.id);
  }
});

test("engine facade helpers stay stable", () => {
  assert.equal(normalizeEngine(), "codex");
  assert.equal(getEngineInfo("codex").label, "Codex");
  assert.equal(supportsGate("gemini"), true);
  assert.equal(getEngineRuntimeCapabilities("droid").resumeKind, "session");
  assert.equal(getEngineRuntimeCapabilities("gemini").effortControl, "unsupported");
  assert.equal(getEngineRuntimeCapabilities("codex").permissionControl, "dual-axis");
  assert.equal(createEngineOwnerState("codex", "running").cancelStrategy, "cooperative");
});

test("review schema keeps every declared finding field required for structured Codex output", () => {
  const schema = buildReviewSchema();
  const findingItem = schema.properties.findings.items;

  assert.deepEqual(findingItem.required, [
    "severity",
    "title",
    "body",
    "file",
    "line_start",
    "line_end",
    "confidence",
    "recommendation"
  ]);
  assert.deepEqual(findingItem.properties.line_start.type, ["integer", "null"]);
  assert.deepEqual(findingItem.properties.line_end.type, ["integer", "null"]);
  assert.deepEqual(findingItem.properties.confidence.type, ["number", "null"]);
});

test("review payload normalization accepts findings-only and status-shaped provider responses", () => {
  const findingsOnly = normalizeReviewPayload({
    findings: [
      {
        file: "src/app.js",
        line_start: 2,
        line_end: 3,
        summary: "Silent null behavior can hide broken callers.",
        recommendation: "Preserve the old contract or update all callers.",
        needs_attention: true
      }
    ]
  });
  assert.equal(findingsOnly?.verdict, "needs-attention");
  assert.match(findingsOnly?.summary ?? "", /Silent null behavior/);

  const statusShaped = normalizeReviewPayload({
    status: "approve",
    summary: "No material issues found.",
    findings: []
  });
  assert.equal(statusShaped?.verdict, "approve");
  assert.equal(statusShaped?.summary, "No material issues found.");
});
