---
description: List, add or remove your standing rules ("no plan approval for KAN-45", "only backend", "resolve comments without asking")
argument-hint: "[list] | add <rule> <value> [--ref KAN-45 | --scope global] [--until 2026-12-01] | remove <id>"
allowed-tools: Bash(aiw:*)
---
**No argument or `list`:** run `aiw rules` and show each rule in one line: its id, what it covers (one ticket, a batch, an epic, a sprint or everything) and until when. If there are none: "No rules in force – your settings apply."

**Add:** only when I clearly asked for it; if my words are unclear, ask first. Map them to one rule and run
`aiw rules add <rule> <value> [--ref KAN-45 | --scope global|item|batch|epic|sprint] [--until <ISO date>]`:

| I say | rule | value |
|---|---|---|
| "no need to ask for the plan" | `plan_approval` | `skip` (back: `ask`) |
| "raise the PR without asking" | `pr_approval` | `skip` / `ask` |
| "start without asking" | `start_approval` | `skip` / `ask` |
| "create the QA issues directly" / "create the tickets" | `create_issues` / `create_tickets` | `skip` / `ask` |
| "fix CI without asking" | `auto_fix_ci` | `yes` / `no` |
| "resolve the review comments yourself" | `auto_resolve` | `yes` / `no` |
| "post reviews directly" | `post_review` | `yes` / `no` |
| "don't ask me questions, decide" | `no_questions` | `yes` / `no` |
| "only the backend" / "don't touch the tests" | `only` / `dont_touch` | the area, e.g. `backend`, `tests` |
| "stay under 300k tokens" | `budget_tokens` | a number |

Echo the line the command prints ("From now on: …").

**Remove:** `aiw rules remove <id>` (ids come from `aiw rules`). Echo the result.

A rule can never change the hard rules: never merge, never force-push, never push to main/dev, never skip git hooks, no secrets in prompts or chat, protected paths always need my OK. If I ask for one of those, say so in one line.
