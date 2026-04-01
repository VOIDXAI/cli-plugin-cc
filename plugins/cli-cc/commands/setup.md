---
description: Detect Codex, Gemini, and Droid availability, manage the stop-time review gate, and store per-engine defaults.
argument-hint: "[--engine <codex|gemini|droid>|--all] [--model <id>] [--effort none|minimal|low|medium|high|xhigh] [--permission <read-only|edit|dev|full|unsafe>] [--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash, AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" setup --json $ARGUMENTS
```

If the result says the selected engine is `codex`, Codex is unavailable, npm is available, and the user is not inspecting `--all`:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" setup --json $ARGUMENTS
```

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
