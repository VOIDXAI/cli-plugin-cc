# Extending `cli-plugin-cc` With Another CLI

The engine layer is now modular. Adding another CLI should normally require:

1. One new adapter file under `plugins/cli-cc/scripts/lib/engines/`
2. One registry entry in `plugins/cli-cc/scripts/lib/engines/index.mjs`
3. A few tests in `tests/`
4. Small README / command docs updates if the public surface changes

The Claude command layer, job control, rendering, hooks, and repo state should not need structural changes for a normal engine addition.

## Current Layout

- `plugins/cli-cc/scripts/lib/engines/index.mjs`
  - Registry and compatibility facade
- `plugins/cli-cc/scripts/lib/engines/shared.mjs`
  - Shared helpers for prompt building, auth detection, process spawning, JSON parsing, and review normalization
- `plugins/cli-cc/scripts/lib/engines/codex.mjs`
  - Codex adapter
- `plugins/cli-cc/scripts/lib/engines/gemini.mjs`
  - Gemini adapter
- `plugins/cli-cc/scripts/lib/engines/droid.mjs`
  - Droid adapter
- `plugins/cli-cc/scripts/lib/engines.mjs`
  - Backward-compatible re-export so existing imports do not move

## Adapter Contract

Each adapter exports one object with this shape:

```js
{
  id: "my-cli",
  info: {
    id: "my-cli",
    label: "My CLI",
    supportsGate: true,
    resume: "native",
    authEnvVars: [],
    authFiles: []
  },
  detect(cwd),
  review({ kind, cwd, scope, baseRef, focusText, model, effort, onProgress }),
  task({ cwd, prompt, model, effort, readOnly, onProgress }),
  resume({ cwd, prompt, resumeSessionRef, model, effort, readOnly, onProgress }),
  interrupt(cwd, job),
  capabilities(),
  findResumeCandidate?(cwd)
}
```

Expected behavior:

- `detect()` returns the same shape consumed by `/cc:setup`
- `review()` returns the normalized review payload consumed by the existing renderer
- `task()` and `resume()` return the normalized task payload consumed by the existing result/status control plane
- `interrupt()` is best-effort; return a descriptive no-op result if the CLI has no native interrupt API
- `capabilities()` should at least return `{ gate, resume }`
- `findResumeCandidate()` is optional and only needed when the CLI can discover resumable sessions on its own

## Minimal Add Workflow

### 1. Create the adapter

Create `plugins/cli-cc/scripts/lib/engines/<engine>.mjs`.

Start from the closest existing adapter:

- Codex-like app server / thread runtime: copy `codex.mjs`
- JSON headless CLI: copy `gemini.mjs`
- JSONL / stream-json CLI: copy `droid.mjs`

Prefer using helpers from `shared.mjs` instead of duplicating:

- `engineBin()`
- `commandExists()`
- `envAuthStatus()`
- `runProcess()`
- `resolveReviewRequest()`
- `normalizeReviewPayload()`
- `parseGeminiJsonOutput()` / `parseDroidStreamJson()`
- `mapReasoningEffortForDroid()` if the new CLI uses the same effort mapping semantics

### 2. Register it

Update `plugins/cli-cc/scripts/lib/engines/index.mjs`:

```js
import { myCliAdapter } from "./my-cli.mjs";

export const ENGINE_ADAPTERS = {
  codex: codexAdapter,
  gemini: geminiAdapter,
  droid: droidAdapter,
  "my-cli": myCliAdapter
};
```

That is the only required change to the registry.

### 3. Add tests

At minimum add:

- One registry-level assertion in `tests/engines.test.mjs`
- One fake runtime fixture or log assertion in `tests/runtime.test.mjs`
- One `setup` / model / effort / resume assertion if the engine supports those flags

Good minimum coverage:

- `setup --engine <engine>`
- `review --engine <engine>`
- `task --engine <engine>`
- `task --engine <engine> --resume` if supported
- `--model` passthrough
- `--effort` passthrough or explicit non-support behavior

### 4. Update docs

If the engine is public-facing, update:

- `README.md`
- command argument hints if the public contract changes

If the engine does not support a capability that other engines do, document the limitation instead of hiding it behind silent behavior changes.

## Design Rules

- Keep engine-specific process flags inside the adapter, not in `cli-companion.mjs`
- Keep job state, result rendering, background execution, and cancel/status logic in the shared control plane
- Prefer adapter-local parsing over adding engine-specific conditionals to renderers
- If a CLI lacks native review, emulate review inside the adapter and still return the normalized review shape
- If a CLI lacks native resume, implement `resume()` as a documented degraded path rather than changing command semantics globally

## Goal

The ideal future engine addition changes only:

- `plugins/cli-cc/scripts/lib/engines/<new-engine>.mjs`
- `plugins/cli-cc/scripts/lib/engines/index.mjs`
- `tests/engines.test.mjs`
- a small number of runtime tests
- docs

That keeps the existing Claude command layer and control plane stable.
