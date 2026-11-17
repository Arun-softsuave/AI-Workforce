---
description: List AI Workforce tasks or show one task in detail
argument-hint: "[ticket]"
allowed-tools: Bash(aiw:*)
---
If a ticket was given ($ARGUMENTS), run `aiw show $ARGUMENTS` and summarise steps, state, PR and report. Otherwise run `aiw tasks` and summarise by state.
