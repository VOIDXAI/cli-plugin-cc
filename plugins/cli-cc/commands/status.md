---
description: Show active and recent `/cc` jobs for this repository, including review-gate status.
argument-hint: '[job-id] [--wait] [--timeout-ms <ms>] [--all]'
allowed-tools: Bash
disable-model-invocation: true
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" status $ARGUMENTS
```

If the user did not pass a job ID:
- Render the command output as a single Markdown table for the current and past runs in this session.
- Keep it compact. Do not add extra prose outside the table unless the command output already includes it.

If the user did pass a job ID:
- Present the full command output to the user.
- Do not summarize or condense it.
