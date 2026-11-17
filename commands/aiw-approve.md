---
description: Approve the pending action (e.g. create the PR) for a ticket
argument-hint: <ticket, e.g. PAY-142>
allowed-tools: Bash(aiw:*)
---
First run `aiw show $ARGUMENTS` and show me a 3-line summary (changes, tests, reviews, commit, any unresolved findings). Then run `aiw approve $ARGUMENTS` – I invoked this command, which is my explicit approval. Report the result. If it says approvals happen in Teams, tell me to reply in the AI Workforce Teams chat (e.g. "KAN-42 1") – do not try another way.
