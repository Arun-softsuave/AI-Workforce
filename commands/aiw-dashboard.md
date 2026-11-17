---
description: Open the live AI Workforce dashboard – what each agent is doing, ticket progress, what needs you, background jobs, connections and cost
allowed-tools: Bash(aiw:*)
---
Run `aiw dashboard`. If it says the service is not running, offer `aiw service start`, then run `aiw dashboard` again.

Then say in a few lines:
- The link only works on this computer (127.0.0.1 with a session token) – don't share it.
- What the page shows, top to bottom: **Needs you** (questions and approvals), **Working now** (one card per running agent with a live activity line and progress), **Ticket progress** (Waiting → Understand & plan → Building → Reviewing → PR open → Done, one bar per repository), **Activity**, **Agents** and the queue (why a job waits), **Background** timers, **Connections** (with Reconnect) and **Cost**.
- Clicking a ticket opens its drawer: where it is now, the timeline, questions and answers, the design document, tokens, PR links and merge order.
- Actions on the page (answer, approve, reject, pause, reconnect) pass the same checks as Teams and are echoed in Teams.

If I only want the link, without a browser opening, use `aiw dashboard --no-open`.
