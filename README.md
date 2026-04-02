# cli-plugin-cc

Use Codex, Gemini, or Droid from inside Claude Code for code reviews or to delegate tasks through one shared `/cc:*` workflow.

This plugin is for Claude Code users who want one command surface for multi-engine review, rescue, and background job handling without leaving the repo they already have open.

## What You Get

- `/cc:review` for a normal read-only review
- `/cc:adversarial-review` for a steerable challenge review
- `/cc:orchestrate` to plan a multi-engine workflow, let the user adjust it, then execute after confirmation
- `/cc:rescue`, `/cc:status`, `/cc:result`, and `/cc:cancel` to delegate work and manage background jobs
- `/cc:setup` to check engine readiness, save defaults for this repo, and manage the optional review gate
- one place to track jobs, view results, cancel runs, and continue earlier work

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

### `/cc:orchestrate`

Builds a linear multi-step workflow across Codex, Gemini, and Droid, shows the draft plan, lets the user adjust it, and only executes after explicit confirmation.

Use it when you want:

- one engine to implement, another to challenge, and another to do a final review
- a user-adjustable plan before any CLI starts running
- a backgroundable workflow that still shows up in `/cc:status`, `/cc:result`, and `/cc:cancel`

Default role mapping:

- Codex for implementation or rescue work
- Gemini for adversarial review
- Droid for final review

The user can override any step in natural language, for example:

```text
/cc:orchestrate let Codex implement the fix, Gemini challenge it, and Droid do the final review
```

The runtime supports up to 5 linear steps and uses these step kinds:

- `task`
- `review`
- `adversarial-review`

Examples:

```bash
/cc:orchestrate redesign the flaky test fix flow and make sure another engine challenges the approach
/cc:orchestrate --background let Codex implement the bug fix, Gemini question the tradeoffs, and Droid do the final review
```

### `/cc:rescue`

Hands a task to the selected engine.

Use it when you want the engine to:

- investigate a bug
- try a fix
- continue a previous engine task
- take a faster or cheaper pass with a smaller model

It supports `--background`, `--wait`, `--resume`, and `--fresh`.
If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue run in the same repo for the same engine.

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

- if you do not pass `--model` or `--effort`, the engine uses its normal defaults unless you saved defaults with `/cc:setup`
  Gemini is the exception for `--effort`: the plugin warns, ignores it, and also ignores any older saved Gemini effort value
- follow-up rescue requests can continue the latest engine task in the repo
- if you do not specify `--wait` or `--background`, `/cc:rescue` defaults to foreground

### `/cc:status`

Shows running and recent `/cc` jobs for the current repository.

Without a job id, it renders a compact table of recent jobs in the current repository.
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
When available, it also includes a resume hint.

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

Checks which engines are installed and authenticated, and lets you save defaults for later `/cc:review`, `/cc:adversarial-review`, and `/cc:rescue` runs in this repo.

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

When the review gate is enabled, Claude can run a targeted review before stopping. If that review finds issues, the stop is blocked so Claude can address them first.

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

## FAQ

### Do I need separate accounts for each engine?

Only for the engines you actually want to use. This plugin uses whatever local authentication each CLI already has access to.

- Codex can use your local Codex sign-in and supports `!codex login`
- Gemini uses whatever local sign-in or API key you already use with the Gemini CLI
- Droid uses whatever local sign-in or API key you already use with Droid

### Will it reuse my existing Codex setup?

Yes. The plugin uses your existing local Codex, Gemini, and Droid CLI setup.

### How do resume hints work?

Finished jobs can show a resume hint.

- Codex jobs show `codex resume <thread-id>` when available
- Gemini and Droid jobs point back to `/cc:rescue --engine <engine> --resume`
