---
description: Run a stricter review through Codex, Gemini, or Droid.
argument-hint: "[--engine <codex|gemini|droid>] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--scope auto|working-tree|branch] [--base <ref>] [focus ...] [--wait|--background]"
allowed-tools: Bash, AskUserQuestion
---

If the user does not specify `--wait` or `--background`, recommend background execution for anything larger than a tiny review.

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" adversarial-review $ARGUMENTS
```

If background execution is chosen, use `Bash(..., run_in_background: true)`.
Return stdout verbatim.
