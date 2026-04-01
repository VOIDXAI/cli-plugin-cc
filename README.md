# cli-plugin-cc

Use Codex, Gemini, or Droid from inside Claude Code for code reviews or to delegate tasks through one shared `/cc:*` workflow.

This plugin is for Claude Code users who want one command surface for multi-engine review, rescue, and background job handling without leaving the repo they already have open.

## What You Get

- `/cc:review` for a normal read-only review
- `/cc:adversarial-review` for a steerable challenge review
- `/cc:rescue`, `/cc:status`, `/cc:result`, and `/cc:cancel` to delegate work and manage background jobs
- `/cc:setup` to check engine readiness, store repo-local defaults, and manage the optional stop-time review gate
- one shared control plane for job tracking, result lookup, cancel, resume hints, and session cleanup

## Requirements

- Claude Code with plugin support
- Node.js 20 or later
- At least one supported CLI installed: `codex`, `gemini`, or `droid`
- Authentication already configured for whichever engine you want to use

## Install

The commands below assume this repository is published as `VOIDXAI/cli-plugin-cc`. If you fork or rename it, adjust the marketplace path accordingly.

Add the marketplace in Claude Code:

```bash
/plugin marketplace add VOIDXAI/cli-plugin-cc
```

Install the plugin:

```bash
/plugin install cc@voidxai-cli-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/cc:setup --all
```

If you only want to check one engine first, you can also run:

```bash
/cc:setup --engine codex
```

For Codex, `/cc:setup` can point you at `npm install -g @openai/codex` and `!codex login` when needed.

After install, you should see:

- the `/cc:*` slash commands listed below
- the `cc:cc-rescue` subagent in `/agents`

One simple first run is:

```bash
/cc:review --engine codex --background
/cc:status
/cc:result
```

## Usage

### `/cc:review`

Runs a normal review on your current work through the selected engine.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`.
It is not steerable and does not take custom focus text. Use [`/cc:adversarial-review`](#ccadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/cc:review --engine codex
/cc:review --engine gemini --base main
/cc:review --engine droid --background
```

This command is read-only. When run in the background you can use [`/cc:status`](#ccstatus) to check progress and [`/cc:cancel`](#cccancel) to stop the ongoing run.

### `/cc:adversarial-review`

Runs a steerable review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/cc:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/cc:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/cc:adversarial-review --engine codex
/cc:adversarial-review --engine codex --base main challenge whether this was the right caching and retry design
/cc:adversarial-review --engine gemini --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/cc:rescue`

Hands a task to the selected engine through the shared `/cc` task runtime.

Use it when you want the engine to:

- investigate a bug
- try a fix
- continue a previous engine task
- take a faster or cheaper pass with a smaller model

It supports `--background`, `--wait`, `--resume`, and `--fresh`.
If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue thread for the same repo, engine, and Claude session.

Examples:

```bash
/cc:rescue --engine codex investigate why the tests started failing
/cc:rescue --engine codex --resume apply the top fix from the last run
/cc:rescue --engine codex --model gpt-5.4-mini --effort medium investigate the flaky integration test
/cc:rescue --engine gemini --background investigate the regression
/cc:rescue --engine droid --fresh fix the failing test with the smallest safe patch
```

You can also just ask for work to be delegated through `/cc:rescue`:

```text
Ask cc rescue with Codex to redesign the database connection to be more resilient.
```

Notes:

- if you do not pass `--model` or `--effort`, the engine uses its normal defaults unless you stored repo-local defaults with `/cc:setup`
  Gemini is the exception for `--effort`: the current Gemini CLI does not expose a reasoning-effort flag, so the plugin warns on explicit Gemini `--effort`, ignores it, and ignores stale stored Gemini effort defaults
- follow-up rescue requests can continue the latest engine task in the repo
- if you do not specify `--wait` or `--background`, `/cc:rescue` defaults to foreground

### `/cc:status`

Shows running and recent `/cc` jobs for the current repository.

Without a job id, it renders a compact table of current-session jobs.
With a job id, it shows the full stored detail for that specific run.

Examples:

```bash
/cc:status
/cc:status task-abc123
/cc:status task-abc123 --wait
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/cc:result`

Shows the final stored output for a finished job.
When available, it also includes the underlying session id and an engine-appropriate resume hint.

Examples:

```bash
/cc:result
/cc:result task-abc123
```

### `/cc:cancel`

Cancels an active background job.

Examples:

```bash
/cc:cancel
/cc:cancel task-abc123
```

### `/cc:setup`

Checks which engines are installed and authenticated, and lets you store repo-local defaults for later `/cc:review`, `/cc:adversarial-review`, and `/cc:rescue` runs.

Examples:

```bash
/cc:setup --all
/cc:setup --engine codex
/cc:setup --engine codex --model gpt-5.4-mini --effort high
/cc:setup --engine gemini --model gemini-2.5-pro
```

You can also use `/cc:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/cc:setup --engine codex --enable-review-gate
/cc:setup --engine gemini --enable-review-gate
/cc:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted stop-time review through the configured engine. If that review finds issues, the stop is blocked so Claude can address them first.

## Typical Flows

### Review Before Shipping

```bash
/cc:review --engine codex
```

### Hand A Problem To An Engine

```bash
/cc:rescue --engine gemini investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/cc:adversarial-review --engine codex --background
/cc:rescue --engine droid --background investigate the flaky test
```

Then check in with:

```bash
/cc:status
/cc:result
```

## Engine Integration

The plugin wraps local CLI installations and keeps one shared control plane on the Claude side.

### Supported Engines

- `codex`: uses the Codex app-server for native review, task, resume, interrupt, and broker-backed runtime reuse inside one Claude session
- `gemini`: uses Gemini headless mode with `--prompt`, `--output-format json`, a pseudo-terminal wrapper for reliable non-interactive execution, and native `--resume`
- `droid`: uses `droid exec` headless mode with `--output-format stream-json` and native `--session-id`

### Model And Effort Handling

- `--model` is passed through exactly as written for all three engines
- if you omit `--model`, the plugin does not inject an engine-specific model default; it falls through to the underlying CLI unless you stored a repo-local default with `/cc:setup`
- `--effort` is forwarded for Codex and Droid; Droid maps the shared plugin levels onto the smaller set that its CLI accepts
- Gemini currently does not expose a CLI reasoning-effort flag, so `/cc:setup --engine gemini --effort ...` and runtime Gemini `--effort` values warn and continue while ignoring the effort request
- stale Gemini effort defaults from older plugin state are ignored at runtime and shown as ignored in `/cc:setup`
- `/cc:setup --engine <engine> --model ... --effort ...` stores repo-local defaults for later runs when those flags are omitted, for engines that support effort control
- Gemini failures surface the concrete model id plus server error details and exit non-zero so Claude can treat them as real failures

### Control Plane Parity

The current implementation includes the main upstream control-plane pieces adapted for a multi-engine host:

- workspace-root scoped state directories and job pruning
- per-job JSON snapshots and log files
- tracked progress updates for phase, thread, and turn ids
- broker-backed Codex app-server reuse inside one Claude session
- session start/end hooks that export session ids and tear down broker state
- status and result lookup from stored job snapshots instead of transient stdout only
- cancel flow that combines engine interrupt with process-tree termination
- stop review gate that reads Claude hook JSON, filters jobs by session, and emits `{"decision":"block","reason":...}` when it must block

## Environment Overrides

Use these variables if the binaries are not on your `PATH` or if you want to point at wrappers:

- `CLI_PLUGIN_CC_CODEX_BIN`
- `CLI_PLUGIN_CC_GEMINI_BIN`
- `CLI_PLUGIN_CC_DROID_BIN`
- `CLI_PLUGIN_CC_DATA_DIR`
- `CLI_PLUGIN_CC_CODEX_SANDBOX`
- `CLI_PLUGIN_CC_CODEX_REVIEW_SANDBOX`
- `CLI_PLUGIN_CC_CODEX_TASK_SANDBOX`

Best-effort auth detection also checks:

- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `GOOGLE_API_KEY`
- `FACTORY_API_KEY`

## FAQ

### Do I need separate accounts for each engine?

Only for the engines you actually want to use. This plugin uses whatever local authentication each CLI already has access to.

- Codex can use your local Codex CLI sign-in and supports `!codex login`
- Gemini typically uses `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or local Gemini auth files
- Droid uses its normal local Factory auth state or `FACTORY_API_KEY`

### Does the plugin use separate runtimes?

No. The plugin delegates through the local CLIs already installed on your machine.

That means:

- it uses the same local installs you would use directly
- it uses the same authentication state those CLIs already have
- it uses the same repository checkout and machine-local environment

### Will it reuse my existing Codex setup?

Yes. Codex runs go through your local Codex CLI and app-server setup.
Gemini and Droid also use their normal local CLI behavior.

### How do resume hints work?

Finished jobs can store the underlying session identifier and show an engine-appropriate resume hint.

- Codex jobs show `codex resume <thread-id>` when available
- Gemini and Droid jobs point back to `/cc:rescue --engine <engine> --resume`

## Local Development

Headless smoke check:

```bash
claude -p --plugin-dir ./plugins/cli-cc '/cc:setup --all'
```

Static validation:

```bash
claude plugin validate ./plugins/cli-cc
```

Repository-local marketplace source:

1. Keep `.claude-plugin/marketplace.json` at the repo root.
2. Point Claude Code at the local marketplace source.
3. Install the `cc` plugin from that local source.
4. Run `/cc:setup --all`.

Direct development-time loading:

```bash
claude --plugin-dir ./plugins/cli-cc
```

Once loaded, the main commands are:

- `/cc:setup --all`
- `/cc:review --engine codex`
- `/cc:adversarial-review --engine codex`
- `/cc:rescue --engine gemini`
- `/cc:status`
- `/cc:result`
- `/cc:cancel`

Useful status patterns:

- `/cc:status`
- `/cc:status <job-id>`
- `/cc:status <job-id> --wait`
- `/cc:result <job-id>`

## Validation

Validated locally on March 31, 2026 with:

- `npm test`
- `claude plugin validate ./plugins/cli-cc`
- `claude -p --plugin-dir ./plugins/cli-cc '/cc:setup --all'`
- real `codex` app-server review + task + resume
- real `gemini` review + task + resume with the plugin falling through to Gemini CLI defaults unless a model is set
- explicit Gemini `--effort` warning+ignore behavior and backward-compatible ignoring of stale stored Gemini effort defaults
- real `gemini` background task with `status --wait` + `result`
- real `gemini` preview-model failure path with surfaced `model/code/reason`
- real `droid` headless review
- stop-gate block/allow hook paths covered in automated tests
- automated coverage for explicit `--model` passthrough, `--effort`, Codex/Gemini/Droid resume, and stored status/result hints

## Development

Engine extension notes live in [docs/EXTENDING.md](docs/EXTENDING.md).

Run tests with:

```bash
npm test
```

Run live smoke tests against the locally installed/authenticated engines with:

```bash
npm run test:live
```

Useful live-test options:

- `CLI_PLUGIN_CC_LIVE_ENGINES=codex,gemini npm run test:live`
- `CLI_PLUGIN_CC_LIVE_FULL=1 npm run test:live`
- `CLI_PLUGIN_CC_LIVE_CANCEL=1 npm run test:live`
- `CLI_PLUGIN_CC_LIVE_CODEX_MODEL=gpt-5.4 npm run test:live`
- `CLI_PLUGIN_CC_LIVE_DROID_MODEL=gpt-5.4 npm run test:live`
- `CLI_PLUGIN_CC_LIVE_TIMEOUT_MS=900000 npm run test:live`

`npm test` stays deterministic and uses fake engines only. `npm run test:live` uses the real local CLIs, skips engines that are unavailable or not signed in, and by default exercises setup, review, foreground task, resume, and background `status/result`. Gemini live smoke is pinned to `gemini-2.5-flash-lite`, and Gemini live invocations are wrapped with `timeout -k 15s 600s` semantics so a stuck run gets reaped instead of wedging the VM. Add `CLI_PLUGIN_CC_LIVE_FULL=1` to include adversarial review, and `CLI_PLUGIN_CC_LIVE_CANCEL=1` to include live cancel smoke. Transient provider-capacity failures are skipped with a diagnostic so a flaky default model does not make the whole smoke suite unusable.
