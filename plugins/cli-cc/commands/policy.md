---
description: Show or change auto-routing policy defaults for this repository.
argument-hint: "[--set <balanced|quality-first|speed-first|cost-first>] [--prefer-auto|--disable-auto] [--matrix-engines <codex,gemini,droid>] [--threshold-files <n>] [--threshold-lines <n>]"
allowed-tools: Bash
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" policy $ARGUMENTS
```

Return stdout verbatim.
