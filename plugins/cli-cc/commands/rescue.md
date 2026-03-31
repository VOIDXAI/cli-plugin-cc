---
description: Delegate a task to Codex, Gemini, or Droid from Claude Code.
argument-hint: "[--engine <codex|gemini|droid>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--resume|--fresh] [--wait|--background]"
allowed-tools: Bash, AskUserQuestion
---

If the user does not specify an engine, default to `codex`.
If the user does not specify `--wait` or `--background`, recommend background execution for longer or open-ended tasks.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" task $ARGUMENTS
```

If background execution is chosen, use `Bash(..., run_in_background: true)`.
Return stdout verbatim.
