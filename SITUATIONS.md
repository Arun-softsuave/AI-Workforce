# AI Workforce – every situation the plugin must handle

Purpose: the full list of situations the plugin can face, drawn from your requirements. The orchestration design comes next and must cover every row here.
Status: draft for review, 16 Nov 2026. Nothing here is implemented by this document.

**How to read a row**
- **Trigger:** what starts it, either a Teams message (example wording) or an event.
- **Expected:** what the plugin should do.
- **Today:** how plugin 0.6.9 handles it, based on the code:
  - ✅ handled;
  - 🟡 partly handled, or handled in a rigid way;
  - ❌ not handled.

Shared ideas used below:
- *Work item*: anything the plugin works on (epic, ticket, part per repo, or a PR job).
- *Directive*: an instruction you gave, such as "no approvals" or "backend only".
- *Knowledge agent*: it answers agents' questions from the data before anything is asked of you.

---

## A. Setup and environment

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| A1 | First-time onboarding | `/aiw-setup` | Guided steps: connectors, Teams, projects, team, preferences, Brain, rules card, CI map, ready check | 🟡 (team, preferences and ready check are being added in 0.7.0) |
| A2 | A new repository is added to an existing project | "add the admin-panel repo" | Learn it (conventions, rules card, CI, tests), group it with its siblings, run the ready check | 🟡 manual CLI |
| A3 | Repo conventions change (new lint, new CI job, new CLAUDE.md) | daily refresh | Re-learn only what changed; rebuild the rules card; tell you if CI rules changed | 🟡 conventions re-detected daily; no card or CI yet |
| A4 | Broken local environment (Python venv, node_modules, Docker off) | ready check or mid-task | Use a working alternative if there is one; otherwise continue "not tested locally" and give the exact fix command | 🟡 |
| A5 | Tests need a database | tests need a DB | Use the .env database (your decision, 16 Nov); a temporary database stays available as an option | 🟡 temp DB only today |
| A6 | Jira, GitHub or Figma disconnected or sign-in expired | health check / API 401 | These three must **always** be connected: checked continuously, and a short Teams message with the reconnect command goes out **as soon as** one drops – not only when a task needs it. Work that doesn't need it keeps running. | 🟡 noticed only when a task fails |
| A7 | Background service not running, or the computer slept | service down | On start: resume work where it stopped; process missed events; one catch-up message | 🟡 resumes tasks; no catch-up summary |
| A8 | A second developer starts using the plugin on the same repos | their onboarding | Each plugin works for its own user; GitHub is the shared channel; same rules, learned locally | 🟡 |
| A9 | A teammate joins or leaves | "Eric left the team" | Update the team list and reviewers | ❌ (being added in 0.7.0) |
| A10 | You change preferences | "from now on raise draft PRs" | Store the preference and confirm it once | ❌ (CLI in 0.7.0; Teams later) |
| A11 | Plugin upgraded while work is in progress | new version | Running work continues on the version it started with, or migrates safely | 🟡 |

## B. Starting work: what you hand over

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| B1 | One ticket by key | "start KAN-45" | Understand, plan, build, PR | ✅ |
| B2 | One ticket by name or description | "do the invite email task" | Find it in Jira by title or description; confirm only if two match | ❌ (index in 0.7.0) |
| B3 | One ticket by Jira link | `https://…/browse/KAN-45` | Same as B1 | 🟡 |
| B4 | A ticket assigned to you in Jira | Jira event | Picked up automatically, or "start?" depending on size and preference | ✅ |
| B5 | A ticket assigned to someone else | "do KAN-60" (Eric's) | Ask once whether to take it over; never silently work on someone else's ticket | ❌ |
| B6 | Ticket already in progress, done, or with an open PR | "start KAN-45" | Say where it stands; offer to continue, fix the PR or review it, never duplicate | 🟡 |
| B7 | Several tickets in one message | "do KAN-45, KAN-47 and KAN-166" | One batch: parallel where independent, one acknowledgement, questions only on real doubt | 🟡 rigid; burst asks per ticket |
| B8 | Several tickets with dependencies or overlapping files | KAN-47 uses KAN-45's API | Order them, or stack the second PR on the first; never build two changes to the same files at once | ❌ |
| B9 | "Do all my tickets" or "everything in To Do" | message | List what that means (count, sizes, estimate) and confirm once, then run as a batch | ❌ |
| B10 | An epic or feature | "build the seller onboarding epic" | Read the epic and its child tickets; one breakdown plan with dependencies, waves and shared contracts; run in waves; epic check at the end | ❌ |
| B11 | An epic with missing tickets | epic has gaps | Propose the missing stories; create them in Jira only after an OK, or follow the directive | ❌ |
| B12 | A whole sprint | "build sprint 14" | Take the sprint's tickets in priority order, fit them to capacity and budget, run in waves, daily progress | ❌ |
| B13 | Work with no ticket | "add CSV export to orders" | Short interview until the requirement is clear, then normal flow (no Jira writes unless asked) | ✅ (request flow) |
| B14 | A bug from a description, log or screenshot | "login fails with 500 since today" | Reproduce, find the cause, fix with a test; offer to create a Jira bug | 🟡 |
| B15 | From a PRD, Figma frame or Notion page | link plus "build this" | Treat it as a feature: break it down, then same as B10 | ❌ |
| B16 | A ticket spanning two repos | backend + frontend | One lead, one shared contract, parts per repo, linked PRs | ✅ |
| B17 | A ticket in a project that isn't configured | "do OPS-12" | Say it isn't set up and offer the command to add it | 🟡 |
| B18 | Very large or vague request | "rebuild the dashboard" | Break it down first; ask one round of scoping questions; never start a huge blind change | 🟡 |
| B19 | A priority or deadline is given | "KAN-47 first, it's urgent" | Move it ahead in the queue; tell you what it delays | ❌ |
| B20 | An instruction comes with the work | "no need to ask for approval", "only backend", "don't touch tests" | Store it as a directive, echo it once, apply it to this work only (or globally if said) | ❌ |

## C. Understanding and clarity

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| C1 | Ticket is clear | – | No questions | ✅ |
| C2 | The ticket's answer is in the code, PRD or Figma | agent has a question | The knowledge agent answers it and records where it found it | 🟡 two-repo only |
| C3 | Real product decision needed | pricing, copy, behaviour | One message with all questions for this item, options, and a recommendation | ✅ (sometimes several messages) |
| C4 | You say "you decide" or "I don't know, check the code" | reply | The agent decides, states its choice in the plan, doesn't ask again | ✅ |
| C5 | Ticket, PRD and Figma disagree | conflict | Point out the conflict; recommend which source wins; ask once | 🟡 |
| C6 | Design missing for a UI ticket | no Figma | Follow existing UI patterns; say so in the plan; screenshots in the PR | 🟡 |
| C7 | Ticket changes in Jira during work | Jira update | Before build: re-plan. During or after build: tell you what changed and offer to adapt | 🟡 notifies only |
| C8 | Ticket reassigned, cancelled or moved to Done by someone | Jira update | Pause, tell you, offer to stop and clean up | 🟡 |
| C9 | Needs a database migration | plan | Include the migration in the plan; flag it as a risk; never run it on a shared DB | 🟡 |
| C10 | Needs a secret or config value you must provide | plan | Ask for it the safe way (vault command), never in chat | 🟡 |
| C11 | Needs work outside the repos (infra, other team's service) | plan | Do the code part; list the outside work in the PR and in Teams | 🟡 |

## D. Planning and approval

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| D1 | Plan ready, approval wanted | – | **One** short plan message (about 10 lines) with a link to the full plan | 🟡 long plan, several messages |
| D2 | You approve | "yes", "approve", "1" | Start building | ✅ |
| D3 | You reject with changes | "use the existing validator" | Re-plan with the feedback, using cached context (no re-fetch) | ✅ |
| D4 | You approve with a small change | "yes but skip the email part" | Treat as approve + change: adjust the plan and start without another round | ❌ |
| D5 | "No approval needed" | directive | Plan is sent as information; work starts | ❌ (preference in 0.7.0) |
| D6 | Approval goes stale (code changed or 72 h passed) | binding check | Tell you; refresh and ask again | ✅ |
| D7 | One approval for an epic or batch | epic plan | Approve the breakdown once; child plans run as information unless you asked to see each | ❌ |
| D8 | Several approvals waiting at once | 3 plans ready | Each message names its ticket; "approve all" works; "1" goes to the item in focus | 🟡 |

## E. Building and testing

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| E1 | Build and targeted tests pass | – | Continue | ✅ |
| E2 | Tests fail | – | Up to 3 fix rounds with the failing output | ✅ |
| E3 | A flaky test | passes on retry | Retry once; note it in the PR; don't "fix" unrelated tests | 🟡 |
| E4 | Tests can't run here | env or DB | Continue as "not tested locally", clearly marked in Teams and the PR | ✅ |
| E5 | Lint, format or type errors | checks | Fix with the repo's own tools | ✅ |
| E6 | Docstrings missing or in the wrong style | standards guard | One short pass to add them in the repo's style | ❌ (learned in 0.7.0; enforced later) |
| E7 | Stray files (debug scripts, scratch tests, logs, .env) | file filter | Removed from the commit and listed | ❌ |
| E8 | Base branch moved; rebase conflict | prepublish | Rebase; on conflict try to resolve; else pause and tell you | 🟡 pauses |
| E9 | Change is very large or touches protected paths (CI, infra) | prepublish | Warn in the approval message; suggest splitting | ✅ warns |
| E10 | A new dependency is needed | plan or build | Add it the repo's way (lockfile updated); mention it in the PR | 🟡 |
| E11 | A git hook rejects the commit | hook | Fix what the hook reports; never `--no-verify` | ✅ |
| E12 | Budget for the item runs out | tokens | Warn at 80%; stop only if you chose budget stops | ✅ |
| E13 | An agent is stuck (no progress after its rounds) | fail | One message: what failed, what it tried, options (retry, take over, cancel) | 🟡 |

## F. Raising the PR

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| F1 | PR approval wanted | – | One message: files, tests, reviews, standards, screenshots | ✅ |
| F2 | "No approval" for the PR | directive or preference | Raise it straight away | ❌ (0.7.0) |
| F3 | A normal PR, not a draft | preference | Ready-for-review PR to dev; never merged | ❌ (0.7.0) |
| F4 | Reviewers should be asked | team settings or CODEOWNERS | Request them on the PR; never the author | ❌ (0.7.0) |
| F5 | Frontend PR | – | Desktop and mobile screenshots in the description; a warning if they can't be taken | 🟡 fails silently |
| F6 | A PR already exists for the branch | – | Update it, don't open a second one | ✅ |
| F7 | Two repos | lead | Two PRs linked to each other, one message | ✅ |
| F8 | Depends on an unmerged PR | B8, B10 | Stacked PR on the parent branch; re-targeted to dev after the parent merges | ❌ |
| F9 | Push not allowed (permissions, branch protection) | push fails | Clear message with what access is needed | 🟡 |

## G. After the PR (until it is merged)

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| G1 | CI passes | checks green | One message "CI green on PR #N" | 🟡 only after a fix |
| G2 | CI fails: lint, format or types | check failed | Fix, push without asking, then "fixed lint, CI green" | ❌ watched only after a fix; asks first (0.7.0 changes both) |
| G3 | CI fails: tests | check failed | Fix the code, never weaken tests; push; report | 🟡 asks first |
| G4 | CI fails on a check that needs a person (baseline, paid eval, secret, deploy) | check failed | Don't fake it; say exactly what is needed | 🟡 |
| G5 | CI fails on dev too (not this PR's fault) | check failed on base | Don't touch it; tell you | ✅ marks "also fails on base" |
| G6 | CI flaky or a runner problem | infra error | Re-run the job once, then treat as real | ❌ |
| G7 | CI still running for a long time | pending | Keep watching; tell you after 3 h | ✅ |
| G8 | You say "the PR failed, recheck and resolve" | message | Fix everything that is red or open: CI first, then comments | 🟡 "resolve" wording missed |
| G9 | A reviewer comments | GitHub event | Tell the author (both people know); offer "resolve the comments" | ✅ author side |
| G10 | Changes requested | review | Same as G9, marked as blocking | ✅ |
| G11 | You say "resolve the comments" | message | Fix, push, reply on each thread, re-request review, tell both | ✅ (asks before push) |
| G12 | A comment needs a product decision or is wrong | comment | Answer or disagree politely with a reason; ask you only for product decisions | ✅ |
| G13 | Someone else pushes to the PR branch | new commits | Rebase local work on top; never overwrite | 🟡 |
| G14 | The PR conflicts with dev | mergeable = false | Rebase or merge dev in, the team's way; resolve or ask | ❌ |
| G15 | QA requested | "QA PR 140" | Test it; product bugs become GitHub issues (directly, or after a quick OK) | ✅ (after OK) |
| G16 | The PR is approved by reviewers | review approved | Tell you it's ready to merge; never merge | 🟡 |
| G17 | The PR is merged | merged | Close the item, unblock dependents, clean up, learn; update Jira if allowed | 🟡 |
| G18 | The PR is closed without merge | closed | Ask whether to drop the work or reopen | ❌ |
| G19 | The reviewer asks for something the ticket doesn't cover | comment | Point it out; do it if small and you agree; else suggest a new ticket | 🟡 |

## H. Reviewing work: yours, a teammate's, old or new

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| H1 | Review a teammate's open PR by number or link | "review PR 140" | Review against the ticket and PRD; show the comments first; post on OK | ✅ |
| H2 | You are asked to review (review requested) | GitHub event | Tell you with the link; review straight away if you prefer | ❌ |
| H3 | Re-review after the author's fixes | new commits on a PR you reviewed | "Author pushed fixes; re-review?"; check only what changed | ✅ notice; 🟡 re-review |
| H4 | **Review a ticket that was done long ago** | "review KAN-12" (merged last month) | Find its PR(s) and commits (Jira links, branch name, PR search by key, commit messages). Review the merged change against the ticket's acceptance criteria and today's code (was it changed since?). Give a report in Teams; offer GitHub issues or a follow-up ticket for gaps. Never comment on a closed PR unless asked. | 🟡 PR search by key exists; no merged-work audit |
| H5 | Review a branch with no PR, or a commit range | "review branch feat/x" | Diff against its base; same review | ❌ |
| H6 | Review a whole epic or feature that is done | "check the onboarding epic is complete" | Each ticket's acceptance criteria against the merged code; missing pieces listed | ❌ |
| H7 | QA an old feature | "QA the refunds feature" | Test plan from the tickets; run what can run locally; issues for bugs | 🟡 PR-only |
| H8 | Review your own PR before others see it | "review my PR 140" | Same as H1, but issues are offered as fixes, not comments | 🟡 |

## I. Taking over and handing back

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| I1 | You started the work; the plugin finishes it | "I'm on branch feat/KAN-45/x, finish it" | Gap analysis of your diff against the ticket; plan the rest; build on top of your commits; push; PR | ❌ |
| I2 | You edit the plugin's branch while it works | your commits appear | Rebase onto your commits; never overwrite | 🟡 |
| I3 | You want to take over | "stop, I'll do it" | Stop, leave the branch and worktree ready for you, summarise the state | 🟡 cancel |
| I4 | You hand back after your own changes | "continue KAN-45" | Read your new commits, continue from there | 🟡 |
| I5 | Fix your own PR that the plugin didn't raise | "fix PR 150" | Same fix flow on your PR (CI, comments, QA issues) | ✅ |
| I6 | Continue work that stopped (crash, restart, failure) | "resume KAN-45" | Continue from the last completed step | ✅ |

## J. Talking to the plugin

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| J1 | Question about the code or product | "how do refunds work?" | Answer from the Brain, code and Jira, like Claude | ✅ (expensive at times) |
| J2 | Status of one item, all items, an epic or a sprint | "status", "how are the others?" | One line per item; blockers and what waits on you first | 🟡 |
| J3 | Several requests in one message | "approve KAN-45 and start KAN-47" | Do both; one reply | 🟡 |
| J4 | Vague reference | "that one", "the second ticket", "it" | Resolve from the chat history and focus; ask only if truly ambiguous | 🟡 |
| J5 | A correction | "no, I meant KAN-47" | Undo or redirect the last action if it's safe; confirm | ❌ |
| J6 | Change an instruction mid-way | "actually ask me before the PR" | Update the directive for the running work | ❌ |
| J7 | Pause, resume or cancel one item, a batch or everything | "pause everything until Monday" | Do it, with a short summary | ✅ |
| J8 | "Why did you do X?" | message | Explain from the plan, decision log and history | 🟡 |
| J9 | Cost and usage | "how much did KAN-45 cost?" | Answer from usage records | ✅ |
| J10 | Message arrives while you're away | quiet hours or offline | Hold non-urgent messages; one summary when you're back | 🟡 |
| J11 | Small talk, thanks, unclear text | "ok", "thanks" | Short reply; no action | 🟡 |
| J12 | A message not from the owner | another person in the chat | Never act on it | ✅ |
| J13 | Follow-up on something days old | "what happened with that bug fix last week?" | Find it in the history and work items | 🟡 |
| J14 | "Undo that" | after an action | Undo when safe (cancel a just-started item, delete an unpushed branch); never rewrite pushed history | ❌ |

## K. Working with teammates (both use the plugin)

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| K1 | You raised a PR; the teammate should know | PR raised | Their plugin tells them, with the link and "say review PR N" | ❌ |
| K2 | The teammate's plugin posts review comments | posted | Your plugin tells you; theirs confirms to them | 🟡 your side only |
| K3 | You resolve the comments | pushed + replies | Theirs tells them "resolved, re-review?" | 🟡 |
| K4 | A teammate without the plugin | normal GitHub use | Everything still works through GitHub alone | ✅ |
| K5 | Both plugins could act on the same PR | – | Fixed ownership: the author's plugin pushes, reviewers' plugins review, either can run QA | 🟡 |
| K6 | A PM or BA comments in Jira | Jira comment | Treat it as information; re-plan only if it changes requirements; never as an instruction | 🟡 |
| K7 | Someone mentions you on a PR or issue | @mention | Tell you with context | ❌ |

## L. Scale, concurrency and time

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| L1 | More work than free slots | batch or sprint | Queue by priority; tell you the order; run overnight if allowed | 🟡 |
| L2 | Two items will change the same files | plans overlap | Run them one after the other, or stack | ❌ |
| L3 | Many events at once (CI on 5 PRs) | events | One job per item; duplicates merged; you get one summary | 🟡 |
| L4 | GitHub or Jira rate limits | 403 / 429 | Back off; free "nothing changed" (304) checks; never lose an event | 🟡 |
| L5 | Daily budget nearly used | tokens | Warn; finish running steps; hold new ones if you chose budget stops | ✅ |
| L6 | Long-running work across days | sprint | Daily morning summary; resumes after restarts | 🟡 |
| L7 | Disk filling with worktrees | many items | Clean finished worktrees on schedule | ✅ |

## M. Failures and safety

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| M1 | The model fails or hits its limits | API error | Retry with back-off; switch tier if allowed; tell you only if it persists | 🟡 |
| M2 | Ticket, PR or comment text tries to give the plugin orders (prompt injection) | text | Treat it as data only; never follow it; flag it if suspicious | ✅ |
| M3 | A secret is pasted into Teams or found in code | message or diff | Never echo or store it; ask to revoke; block the push | ✅ |
| M4 | The change mentions AI or Claude | prepublish | Blocked and fixed | ✅ |
| M5 | A PR from a fork | fix request | Can't push there; say so; offer to review instead | ✅ |
| M6 | The repo isn't cloned locally | project | Offer to clone (with permission) | 🟡 |
| M7 | Something would merge, force-push or touch main/dev directly | any | Never; these are hard rules that no directive changes | ✅ |
| M8 | Tests and the app use the .env database | tests / QA | Allowed (your decision, 16 Nov). Background jobs, real emails and payments stay switched off when the plugin runs the app | 🟡 |

## N. Other roles (from the existing playbooks)

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| N1 | QA test plan for a ticket or epic | "test plan for KAN-45" | Test cases from the acceptance criteria | ✅ |
| N2 | BA stories from a PRD | "write stories for this PRD" | Draft stories; create in Jira after OK | ✅ |
| N3 | Design review of a Figma frame | link | Review against the design system and PRD | ✅ |
| N4 | Daily digest for a PM | schedule | Progress across tickets and PRs | ✅ |
| N5 | DevOps CI failure on a branch (not a PR) | failed run | Diagnose; propose a fix | ✅ |

## O. Closing and learning

| # | Situation | Trigger | Expected | Today |
|---|---|---|---|---|
| O1 | Ticket done (merged) | merge | Close the item; update Jira status/comment if allowed; report | 🟡 |
| O2 | Epic or sprint done | last item merged | One summary: what shipped, open follow-ups, cost | ❌ |
| O3 | The same review comment keeps coming back | pattern | Add it to the rules card so it stops happening | ❌ |
| O4 | Answers given once | decisions | Saved in the decision log; never asked again for the same scope | 🟡 |

---

## Standing requirements (apply to every situation)

| # | Requirement |
|---|---|
| R-DB | The `.env` database may be used, including by tests. Temporary databases are optional, not required. |
| R-CONN | Jira, GitHub and Figma must always be connected. They are health-checked continuously; when one drops, you get a short message with the reconnect command at once. |
| R-MSG | Teams messages are **short and neatly formatted**: a title line, at most about 6 lines, one decision per message, details behind a link or "details KAN-45". No long reports in chat. Exception: a message that has to ask questions may be longer when the questions need it. |
| R-PR | Normal (ready-for-review) PRs to dev; never merged by the plugin. |
| R-CI | CI failures on the plugin's PRs are fixed and pushed without asking; you get the result. |
| R-DIR | Your explicit instructions ("no approval needed") override the default approvals. |
| R-STD | Follow the repo's docstrings and coding standards; never push stray test or debug files. |
| R-LOCAL | Everything runs on your computer; secrets only in the OS vault; nothing mentions AI in code, commits or PRs. |

## What this tells us for the design

1. **The scope varies:** one ticket, a batch, an epic, a sprint, or work with no ticket. So the core must be a **tree of work items with dependencies**, not one fixed pipeline (B7–B12, F8, L2).
2. **Most situations are events, not requests:** G, H2, K. So the core must be **event-driven**, and a ticket stays alive until its PR is merged.
3. **The same work item gets many jobs over time:** build, fix CI, resolve comments, QA, review, take over. So jobs attach to the item; they aren't separate tasks (G, I).
4. **Your words change behaviour:** B20, D5, J5, J6. So instructions must be **stored policy** that every gate reads, with the hard safety rules outside their reach (M7).
5. **Finding the right thing is half the problem:** B2, H4, J4, J13. So the plugin needs **lookup tools**: ticket by name; PRs and commits by ticket; history.
6. **Asking you is expensive:** C2, C3, D1, D7. So there is a knowledge agent first, one message per decision, and batched questions.
7. **Old and merged work is in scope** (H4, H6, H7). Review must handle **merged changes and current code**, not only open PRs.

Next step: the orchestration design. For each row, which component handles it, at what cost, and with what messages.
