---
description: List AI Workforce work as a tree (epic → ticket → repos → PRs) or show one ticket in detail – state, merge order and why it waits
argument-hint: "[ticket, e.g. KAN-45]"
allowed-tools: Bash(aiw:*)
---
**With a ticket ($ARGUMENTS):**
1. Run `aiw items $ARGUMENTS` for its tree: the ticket, one line per repository, its PRs and the job each one runs.
2. Run `aiw show $ARGUMENTS` and summarise: where it is now, what it waits for, steps done, branch, PR link(s), tokens and cost.
3. If it is blocked, paused, stuck or waiting for me, run `aiw explain $ARGUMENTS` and give the reason in one line plus the next action. Show the merge order when it lists one.
4. Mention `/ai-workforce:aiw-explain $ARGUMENTS` for the full "why" (design document and decisions).

**Without a ticket:** run `aiw items` and show the tree as printed (indentation = sprint/epic → ticket → repository → PR), then one line with counts by state from `aiw tasks`. `aiw items --all` includes finished work – use it only if I ask for history.

Plain words, no state codes. Do not approve, reject, start or cancel anything unless I explicitly say so.
