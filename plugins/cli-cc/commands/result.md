---
description: Show the stored result for a finished cli-plugin-cc job.
argument-hint: "[job-id] [--all]"
allowed-tools: Bash
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" result $ARGUMENTS
```

Return stdout verbatim.
