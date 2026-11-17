---
description: Fix the review comments and failing CI checks (or QA issues) on my pull request – shown in Teams before anything is pushed
argument-hint: <PR link | PR number [repo] | ticket key> [--ci | --issues]
allowed-tools: Bash(aiw:*)
---
Run `aiw fix $ARGUMENTS` and tell me which PR it is working on.

Then explain briefly: every open comment and every failing CI check (only the checks with --ci, the QA issues with --issues) is decided with the Brain, the ticket, the PRD and the code – fixed, answered, or disagreed with a reason, and product decisions are asked in Teams. The changes and the replies come to my Teams chat first; after I reply "1" they are pushed to the same PR and each comment gets its reply, then QA runs and CI is watched until every check passes – a check that fails again is fixed again (up to 3 rounds, shown first each time). Nothing is merged and threads are left for the reviewer to resolve.
