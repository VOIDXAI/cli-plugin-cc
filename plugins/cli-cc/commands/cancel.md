---
description: Cancel a running cli-plugin-cc job.
argument-hint: "[job-id]"
allowed-tools: Bash
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" cancel $ARGUMENTS
```

Return stdout verbatim.
