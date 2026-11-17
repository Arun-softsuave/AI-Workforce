---
description: Run the QA engineer on a pull request – results and GitHub issue drafts come to Teams first
argument-hint: <PR link | PR number [repo] | ticket key>
allowed-tools: Bash(aiw:*)
---
Run `aiw qa $ARGUMENTS` and tell me which PR is being tested.

Then explain briefly: the QA engineer plans the tests from the PR, the ticket and the PRD, runs the repository's tests for the changed areas and browser checks of the changed pages on this computer, sorts every failure (product bug / test / environment / flaky), and shows the verdict and issue drafts in my Teams chat. Nothing is posted and no issue is created until I reply there ("create 1, 3", "create all" or "report only").
