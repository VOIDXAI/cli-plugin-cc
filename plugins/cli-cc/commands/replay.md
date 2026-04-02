---
description: Replay the stored timeline and final output for a finished `/cc` job.
argument-hint: "[job-id] [--all]"
allowed-tools: Bash
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" replay $ARGUMENTS
```

Return stdout verbatim.
