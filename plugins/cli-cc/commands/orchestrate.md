---
description: Plan a multi-CLI workflow, let the user adjust it, then execute it only after confirmation.
argument-hint: "[--wait|--background] [task or goal ...]"
allowed-tools: Bash, AskUserQuestion
---

Build a `/cc` workflow plan first, let the user adjust it, and only execute after they explicitly confirm.

Raw user request:
`$ARGUMENTS`

Core rules:
- Do not execute anything until the user chooses `Execute plan`.
- Respect user-specified engine assignments such as "let Codex implement", "have Gemini challenge it", or "use Droid for final review".
- Treat "agent" as the external CLI engine layer for this command: Codex, Gemini, or Droid.
- Keep the first draft to 1-5 linear steps.
- Only use step kinds supported by the runtime: `task`, `review`, `adversarial-review`.

Discovery pass before drafting the plan:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" setup --all --json
```
- Then inspect repo size with:
```bash
git status --short --untracked-files=all
git diff --shortstat --cached
git diff --shortstat
```

Planning defaults:
- Prefer `engine: "auto"` for steps the user did not explicitly pin so the runtime policy can route them at execution time.
- If the user clearly asked for a specific engine, keep it fixed in the plan.
- If you need a concrete fallback mapping while drafting, use:
  - Codex for implementation or rescue work
  - Gemini for adversarial review
  - Droid for final review
- Use `assignmentSource: "manual"` for any step the user explicitly pinned to a specific engine.
- Use `assignmentSource: "auto"` for all other steps.
- Review steps may not carry `input`.
- `adversarial-review` may include focus text in `input`.
- `task` steps should use `input` and may reference:
  - `{{workflow_task}}`
  - `{{step_summary:<step-id>}}`
  - `{{step_output:<step-id>}}`

Confirmation loop:
- Show the full draft plan as a Markdown table with: step id, title, kind, engine, source, and input summary.
- Then use `AskUserQuestion` with exactly these three options:
  - `Execute plan`
  - `Adjust plan`
  - `Cancel`
- If the user chooses `Adjust plan`, revise the existing plan from their natural-language feedback and show the full updated plan again.
- Repeat until they choose `Execute plan` or `Cancel`.
- If they choose `Cancel`, stop without running Bash.

Execution:
- After the user chooses `Execute plan`, create a temporary JSON plan file and invoke:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli-companion.mjs" orchestrate --plan-file "<temp-plan-file>" $ARGUMENTS
```
- Preserve `--wait` or `--background` if the user already supplied one.
- If neither `--wait` nor `--background` was supplied:
  - recommend `Run in background` for multi-step workflows or any workflow containing `task`
  - recommend `Wait for results` only for clearly tiny review-only workflows
  - ask once before execution with these two options:
    - `Run in background (Recommended)` or `Wait for results (Recommended)` depending on the recommendation
    - the other option

Plan file requirements:
- The JSON must match the runtime schema:
  - top-level: `version`, `title`, `task`, `steps`
  - each step: `id`, `title`, `engine`, `assignmentSource`, `kind`, `input`, `options`
  - supported step engines: `codex`, `gemini`, `droid`, `auto`
- Keep step ids stable when revising a plan unless the structure truly changed.

Output rules:
- Before confirmation, present only the plan and the question.
- After foreground execution, return the runtime stdout exactly as-is.
- After background execution, tell the user: "cc orchestrate started in the background. Check `/cc:status` for progress."
