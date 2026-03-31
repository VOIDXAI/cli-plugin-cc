# cli-plugin-cc

Run Codex, Gemini, or Droid from inside Claude Code with one shared workflow for review, rescue, and background jobs.

`cli-plugin-cc` gives Claude Code one shared `/cc:*` command surface while letting `codex`, `gemini`, and `droid` act as the execution engines behind the scenes.

This plugin is for Claude Code users who want a multi-engine workflow without leaving the repo they already have open.

## What You Get

- `/cc:review` and `/cc:adversarial-review` for normal and challenge-style reviews
- `/cc:rescue`, `/cc:status`, `/cc:result`, and `/cc:cancel` to delegate work and manage background jobs
- `/cc:setup` to verify engine readiness, set repo-local defaults, and manage the optional stop-time review gate
- one shared control plane for job tracking, result lookup, cancel, resume hints, and session cleanup
- modular engine adapters under `plugins/cli-cc/scripts/lib/engines/`

## Requirements

- Claude Code with plugin support
- Node.js 20 or later
- At least one supported CLI installed: `codex`, `gemini`, or `droid`
- Auth already configured for whichever engine you plan to use

## Install

The commands below assume this repository is published as `VOIDXAI/cli-plugin-cc`. If you fork it or rename it, adjust the marketplace path accordingly.

Add the marketplace in Claude Code:

```text
/plugin marketplace add VOIDXAI/cli-plugin-cc
```

Install the plugin:

```text
/plugin install cc@voidxai-cli-cc
```

Reload plugins:

```text
/reload-plugins
```

Then run:

```text
/cc:setup --all
```

After install, you should see:

- the `/cc:*` slash commands listed below
- the `cc:cc-rescue` subagent in `/agents`

One simple first run is:

```text
/cc:review --engine codex --background
/cc:status
/cc:result
```

## Commands

- `/cc:setup [--engine <engine>|--all] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--enable-review-gate|--disable-review-gate]`
- `/cc:review [--engine <engine>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--scope auto|working-tree|branch] [--base <ref>] [--wait|--background]`
- `/cc:adversarial-review [--engine <engine>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--scope auto|working-tree|branch] [--base <ref>] [focus...] [--wait|--background]`
- `/cc:rescue [--engine <engine>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--resume|--fresh] [--wait|--background]`
- `/cc:status [job-id?] [--wait] [--all]`
- `/cc:result [job-id?] [--all]`
- `/cc:cancel [job-id?]`

Standalone agent surface:

- `cc-rescue` is the only standalone Claude sub-agent.
- Everything else in this plugin is exposed as slash commands and hooks.

## Supported Engines

- `codex`: uses the Codex app-server for native review, task, resume, and interrupt flows.
- `gemini`: uses Gemini headless mode with `--prompt`, `--output-format json`, and native `--resume`.
- `droid`: uses `droid exec` headless mode with `--output-format stream-json` and native `--session-id`.

Model and effort handling:

- `--model` is passed through exactly as written. This plugin does not alias or rewrite model ids.
- `--effort` is forwarded on paths where the underlying CLI exposes a reasoning-effort control today. In this repo that means Codex task/adversarial-review and Droid review/task; Gemini review/task keeps the flag accepted at the plugin layer but does not currently add a native Gemini-specific effort flag.
- `/cc:setup --engine <engine> --model ... --effort ...` stores repo-local defaults for later `/cc:review`, `/cc:adversarial-review`, and `/cc:rescue` runs when those flags are omitted.

## Control Plane Parity

The current implementation includes the main upstream control-plane pieces adapted for a multi-engine host:

- workspace-root scoped state directories and job pruning
- per-job JSON snapshots and log files
- tracked progress updates for phase, thread, and turn ids
- broker-backed Codex app-server reuse inside one Claude session
- session start/end hooks that export session ids and tear down broker state
- richer status snapshots with active jobs, latest finished job, recent jobs, progress preview, and resume hints
- result lookup from stored job snapshots instead of transient stdout only
- cancel flow that combines engine interrupt with process-tree termination
- stop review gate that reads Claude hook JSON, filters jobs by session, and emits `{"decision":"block","reason":...}` when it must block

## Defaults

- Default engine: `codex`
- Review gate engine: `codex`
- Review gate can be enabled for any supported engine via `/cc:setup --engine <engine> --enable-review-gate`

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

## Install Into Claude Code

Recommended marketplace-source install:

```text
/plugin marketplace add https://github.com/VOIDXAI/cli-plugin-cc
/plugin install cc@voidxai-cli-cc
```

Headless smoke check:

```bash
claude -p --plugin-dir ./plugins/cli-cc '/cc:setup --all'
```

Static validation:

```bash
claude plugin validate ./plugins/cli-cc
```

Repository-local marketplace source for local development:

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
- `/cc:status --wait`
- `/cc:status <job-id>`
- `/cc:result <job-id>`

## Validation

Validated locally on March 31, 2026 with:

- `npm test`
- `claude plugin validate ./plugins/cli-cc`
- `claude -p --plugin-dir ./plugins/cli-cc '/cc:setup --all'`
- Real `codex` app-server task + resume
- Real `gemini` headless task + native resume
- Real `droid` headless task + review
- Stop-gate block/allow hook paths covered in automated tests
- Automated coverage for explicit `--model` passthrough, `--effort`, Codex/Gemini/Droid resume, and stored status/result hints

## Development

Engine extension notes live in [docs/EXTENDING.md](docs/EXTENDING.md).

Run tests with:

```bash
npm test
```
