---
description: Pause or resume AI Workforce picking up new work (e.g. holidays)
argument-hint: "[--until 2026-12-01] | resume"
allowed-tools: Bash(aiw:*)
---
If the argument is "resume", run `aiw resume-all`; otherwise run `aiw pause $ARGUMENTS`. Confirm what happens to incoming tickets (they are queued and summarised).
