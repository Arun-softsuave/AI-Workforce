---
description: Fix the review comments, failing CI checks or QA issues on my pull request – CI and lint fixes are pushed straight away, comment and QA fixes are shown in Teams first
argument-hint: <PR link | PR number [repo] | ticket key> [--ci | --issues]
allowed-tools: Bash(aiw:*)
---
Run `aiw fix $ARGUMENTS` and tell me which PR it is working on.

Then explain briefly: every open comment and every failing CI check (only the checks with --ci, the QA issues with --issues) is decided with the Brain, the ticket, the PRD and the code – fixed, answered, or disagreed with a reason, and product decisions are asked in Teams.

- **Failing CI and lint checks** are fixed and pushed to the same PR without asking (setting `pr.autoFixCi`, on by default; turn it off with `aiw prefs --auto-fix-ci no`). Teams gets a short note of what was fixed. A check that fails again is fixed again, up to 3 rounds. Checks that need a person (a re-recorded baseline, a paid evaluation, a missing secret, a deployment) are reported, never faked.
- **Review-comment fixes and QA issues** come to my Teams chat first; after I reply "1" they are pushed to the same PR and each comment gets its reply, then QA runs and CI is watched until every check passes.

Nothing is merged, and threads are left for the reviewer to resolve.
