---
description: Finish my own branch – AI Workforce reads the ticket and my commits, plans only what is left and continues on top (my commits are never rewritten)
argument-hint: "[branch | PR link | PR number] [ticket, e.g. KAN-45]"
allowed-tools: Bash(aiw:*), Bash(git branch:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git status:*)
---
1. Work out what to adopt:
   - the branch, PR link or PR number in $ARGUMENTS; if none, this repository's current branch (`git branch --show-current`);
   - the ticket key in $ARGUMENTS, or one in the branch name (e.g. `feature/KAN-45-refund`). If there is none, ask me for it.
   Refuse `main`, `master`, `dev` and the repository's base branch: only a feature branch can be adopted.
2. If `git status` shows uncommitted changes, tell me they stay only on my machine – AI Workforce continues from my pushed commits. Ask whether to go on.
3. Run `aiw adopt <branch|PR> --ticket <KEY>`.
   - If the CLI doesn't know `adopt` yet (it prints the help instead), say: "Finishing a branch from Claude Code isn't in this version yet. In Teams write: finish my branch <branch> for <KEY>." Offer `/ai-workforce:aiw-pr-review` as an alternative and do nothing else.
4. Say briefly what happens next: it compares the ticket's acceptance criteria with my diff, plans only what is left and sends that plan to Teams (approval per my preferences and rules). Then it builds, tests and reviews on top of my commits and pushes to the same branch. If I push meanwhile, my commits come in first; on a conflict it stops and tells me.
5. Mention: "stop, I'll do it" in Teams takes it back at any time; "continue KAN-45" hands it over again.

Never force-push, never rewrite my commits, never merge.
