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
