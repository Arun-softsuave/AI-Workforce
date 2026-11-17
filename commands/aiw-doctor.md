---
description: Environment doctor – can this computer run AI Workforce, and can a project's tests run here? (versions, packages, .env key names, database, services)
argument-hint: "[project] [--smoke]"
allowed-tools: Bash(aiw:*)
---
**No project:** run `aiw doctor` (Node, git, disk, network, proxy). Show each FAIL / WARN line with its fix. If it lists projects, offer to check one.

**With a project ($ARGUMENTS):** run `aiw doctor $ARGUMENTS`. Without changing anything it checks:
- language versions (Python / Node) against the repository's own files;
- the project environment (virtualenv / node_modules) and that packages import;
- `.env` is there with the keys the tests need – **names only, values are never read**;
- the database is reachable, and services the tests need (database, cache, queue) are running or can be started with the repo's own command;
- with `--smoke`, a one-test smoke run.

Show the result as printed: ready, or a short list "tests can't run because …, fix: …". Offer to run a printed fix only when it is a local install or check command. Never edit `.env` and never ask me to paste secret values in chat – a missing secret is set in my own terminal (`aiw qa env <project>`).

A ticket never starts building on a broken environment: it waits as **Blocked: environment** and resumes by itself once the doctor passes. Re-run `aiw doctor <project>` after a fix.
