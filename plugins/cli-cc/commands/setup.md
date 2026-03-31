---
description: Detect Codex, Gemini, and Droid availability, manage the stop-time review gate, and store per-engine defaults.
argument-hint: "[--engine <codex|gemini|droid>|--all] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash, AskUserQuestion
---

Use `AskUserQuestion` only if the user did not specify whether they want to inspect a single engine or all supported engines.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" setup $ARGUMENTS
```

Return stdout verbatim.
