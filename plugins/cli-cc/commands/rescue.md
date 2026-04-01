---
description: Delegate investigation or implementation work to Codex, Gemini, or Droid from Claude Code.
argument-hint: "[--engine <codex|gemini|droid>] [--background|--wait] [--resume|--fresh] [--model <id>] [--effort <none|minimal|low|medium|high|xhigh>] [what the engine should investigate, solve, or continue]"
allowed-tools: Bash, AskUserQuestion
---

Route this request to the shared `/cc` task runtime.
The final user-visible response must be the engine output verbatim.

Raw user request:
`$ARGUMENTS`

Execution mode:
- If the request includes `--background`, run the task in the background.
- If the request includes `--wait`, run the task in the foreground.
- If neither flag is present, default to foreground.
- `--background` and `--wait` are Claude-side execution controls. Do not treat them as task text.
- `--model` and `--effort` are runtime-selection flags. Preserve them for the forwarded `task` call, but do not treat them as task text.
- If the request includes `--resume`, do not ask whether to continue.
- If the request includes `--fresh`, do not ask whether to continue.
- Otherwise, before starting the engine, check for a resumable task thread from this Claude session by running:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" task-resume-candidate --json $ARGUMENTS
```

- If that helper reports `available: true`, use `AskUserQuestion` exactly once to ask whether to continue the current engine thread or start a new one.
- The two choices must be:
  - `Continue current engine thread`
  - `Start a new engine thread`
- If the user is clearly giving a follow-up instruction such as "continue", "keep going", "resume", "apply the top fix", or "dig deeper", put `Continue current engine thread (Recommended)` first.
- Otherwise put `Start a new engine thread (Recommended)` first.
- If the user chooses continue, add `--resume` before forwarding.
- If the user chooses a new thread, add `--fresh` before forwarding.

Operating rules:
- Return the companion stdout verbatim to the user.
- Do not paraphrase, summarize, rewrite, or add commentary before or after it.
- Leave `--effort` unset unless the user explicitly asks for a specific reasoning effort.
- Leave the model unset unless the user explicitly asks for one.
- If the user did not supply a request, ask what the selected engine should investigate or fix.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" task "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.

Background flow:
- Launch the task with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" task "$ARGUMENTS"`,
  description: "cc rescue",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "cc rescue started in the background. Check `/cc:status` for progress."
