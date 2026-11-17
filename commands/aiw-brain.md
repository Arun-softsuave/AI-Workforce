---
description: Inspect, query, onboard or confirm a project Brain
argument-hint: show|ask|onboard|confirm|rebuild|add-doc|docs <project> [question|file]
allowed-tools: Bash(aiw:*)
---
Run `aiw brain $ARGUMENTS`. After `onboard`, ask me to review the knowledge files and then run `aiw brain confirm <project>`. For `add-doc`, ask whether the document is confidential (then add `--private`).
