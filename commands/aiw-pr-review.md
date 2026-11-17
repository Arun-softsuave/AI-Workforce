---
description: Review a pull request (yours or a teammate's) against the ticket and the PRD – comments are shown in Teams before posting
argument-hint: <PR link | PR number [repo] | ticket key>
allowed-tools: Bash(aiw:*)
---
Run `aiw review $ARGUMENTS` and tell me which PR is being reviewed.

Then explain briefly: the review reads the PR, the Jira ticket with its comments, the PRD (project documents and linked pages), the team's rules and the related code, and gives a verdict with line comments. The comments come to my Teams chat first; nothing is posted until I reply "post" there (or "post 1, 3", "drop 2", "change 2: …"). It only ever posts a comment review – never an approval or a merge.
