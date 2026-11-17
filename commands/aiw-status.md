---
description: Show AI Workforce health – service, connections, the work tree (sprint → ticket → repos → PRs), merge order and what is blocked
allowed-tools: Bash(aiw:*)
---
1. Run `aiw status` and summarise it in a few lines: service, connections, projects, "needs you" count.
   - Service not running → offer `aiw service start`.
   - A connection expired or down → say which one and the fix (`/ai-workforce:aiw-connect <tool>`). Work that needs it waits as *Blocked* and resumes by itself after the reconnect.
2. Run `aiw items` and show the active work as a tree, indented the way it prints: sprint or epic → ticket → one line per repository → PR. Use plain state words ("Waiting for you", "PR open", "Blocked"), not codes.
3. For every item that is blocked, paused, stuck or waiting for me, run `aiw explain <ref>` and add ONE line with the reason and the next action (e.g. "Blocked: environment – run `aiw doctor nue-backend`", "Waiting for your plan approval – reply 1 in Teams").
4. If a ticket has several PRs (two repositories, or stacked PRs), show the merge order when `aiw explain` lists one, e.g. "merge nue-backend #12 first, then nue-frontend #34". Never offer to merge – merging is mine.

Keep the answer short. Do not approve, reject, start or cancel anything unless I explicitly say so.
