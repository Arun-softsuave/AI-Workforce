# AI Workforce – design for a dynamic, conversational plugin

Status: proposal for review, nothing implemented yet. Written 16 Nov 2026 against plugin 0.6.9.
Companion to `ARCHITECTURE.md` (which describes how the plugin works today).

---

## 1. Summary

Today the plugin is a **command router in front of a fixed pipeline**:

- **Teams messages** are matched to one of 16 intents.
- **A ticket** runs through a playbook from start to end.
- **After the PR is raised, the ticket is finished.**

You want it to behave like **a developer colleague who uses Claude Code**:

- It understands any message.
- It keeps track of all its work.
- It reacts to what happens on GitHub (CI failed, a comment was added, a review was asked for).
- It follows your instructions ("no approval needed", "only backend").
- It finds answers itself before asking you.
- It can pick up work you started by hand.

The design keeps the parts of today's engine that work well:

- worktrees;
- the steps that implement, test and review;
- the safety checks;
- local-only operation.

It adds five pieces around that engine:

| # | New piece | What it fixes |
|---|---|---|
| 1 | **Conductor**: one conversational agent with tools, replacing the intent list | Understanding Teams messages (by ticket name, follow-ups, questions, several requests in one message) |
| 2 | **Ticket lifecycle + event loop**: a ticket stays alive until its PR is merged | CI auto-fix, comments, reviews, "recheck and resolve", work stuck in a one-way pipeline |
| 3 | **Directives (your instructions as policy)** | "No need to ask for approval", "only backend", "do KAN-45 first", bulk work |
| 4 | **Knowledge agent ("ask-desk")** | Agents ask you only what the data can't answer |
| 5 | **Standards guard + branch adoption** | Docstrings, coding standards, no stray test or debug files; "finish my branch" |

It also changes messages: **one short plan message per ticket**, and one batch message for bulk work. It fixes the **frontend PR screenshots** and the **"resolve" bug**.

---

## 2. What you expect (requirements)

| ID | Requirement |
|---|---|
| R1 | Teams understands messages like Claude or ChatGPT: by ticket name or description, not only the key. Follow-ups such as "that one" or "the second ticket" work, and so do free questions. |
| R2 | When CI or lint fails on a PR, the plugin **fixes it itself without asking** and tells you the result. "The PR failed, recheck and resolve" also works. |
| R3 | **Bulk:** several tickets in one message are all handled in parallel. You're asked only where there's real doubt. |
| R4 | **One short plan message** per ticket, with a link to the full plan file. |
| R5 | **Dynamic, not a one-way pipeline:** work can be re-checked and resumed at any point. A ticket reacts to new events after its PR is raised. |
| R6 | **Two-developer PR flow.** Both developers use the plugin. When you raise a PR, the other developer is told, with the link, and can ask their plugin to review it. Their review comments reach both of you. You say "resolve the comments": the plugin fixes, pushes and tells both of you. "Run QA" raises the issues in GitHub. |
| R7 | **Many tickets at once,** with several agents in parallel. Whenever you ask, you get a status of all tickets, not only the one in focus. |
| R8 | **Your explicit instructions win.** "No need to ask for approval" means don't ask: build and raise the PR. |
| R9 | **A knowledge agent** answers the other agents' questions from Jira, Figma, Notion, the Brain, the code and past decisions. Only what it can't answer reaches you. |
| R10 | **Frontend PRs have screenshots** in the description. |
| R11 | After you approve "raise PR", it raises a **normal (ready-for-review) PR, not a draft**. |
| R12 | **Branch adoption:** you worked on the ticket yourself and say "I'm on branch X, finish the task". The plugin reads what you did, completes the rest correctly, and raises or updates the PR. |
| R13 | **Follow the repo's docstring style and coding standards.** Never push unwanted files: scratch tests, debug scripts, logs, local config. |
| R14 | **Accurate, fast and low-cost.** |

---

## 3. Where the plugin is today (gap analysis, from the code)

| Req | Today | Evidence |
|---|---|---|
| R1 | A message goes through word rules first, then an AI picks **one of 16 fixed intents**, with a `ref` it must already know. There is no search of Jira by title, so "start the invite-email task" can't be resolved. Free questions go to a read-only assistant that can't act. | `intake/teamsIntent.ts`, `agents/catalog.ts:104` (intent enum) |
| R2 | The CI watch only starts **after a fix is pushed** (`prFix.ts:153, 330`), never after the first `publish` (`steps.ts:939`), so a red CI on a new PR goes unnoticed. Each CI fix waits for **your OK** before pushing. The CI rule only matches "fix / solve / repair": **"resolve" or "recheck" is missed** and falls to the AI, which may choose `resolve_comments`. | `engine/prFix.ts:395-446`, `intake/teamsIntent.ts` |
| R3 | With more than 5 new tickets (`burstThreshold`), every one becomes "start this size-L task?" (`engine.ts:125`). Size-L tasks always ask. There is no batch concept. | `engine/engine.ts:125`, `intake/intake.ts:198` |
| R4 | The plan text is long and split into chunks of 3,500 characters (`splitMessage`). "Picked up", context and question notices are separate messages before it. | `notify/channels.ts:37`, `engine/steps.ts:679` |
| R5 | A playbook is a straight list of steps. DONE is final. PR events create separate FIX tasks only when you ask. | `playbooks/*.yaml`, `engine/engine.ts` |
| R6 | The author's plugin is told about comments on **their own** PRs (`prActivity.ts:37`). A reviewer's plugin is told about new commits on PRs **they already reviewed** (`prActivity.ts:64`). Nothing detects "a teammate raised a PR / asked me to review", and no reviewers are requested when a PR is opened. | `intake/prActivity.ts` |
| R7 | `maxParallel: 3`. Status is a one-line list. Messages are only partly tagged by ticket. | `core/config.ts:73` |
| R8 | The `planApproval: "always"` setting, plus a `create_pr` approval on every ticket. The only bypass is the project-level autonomy `publish-drafts`. A message can't change policy. | `core/config.ts:25`, `steps.ts:479, 888` |
| R9 | A coordinator exists **only for multi-repo parts** (`catalog.ts:188`). Every other agent question goes straight to you (`need_info`). | `agents/catalog.ts` |
| R10 | Screenshots are taken with Playwright, pushed to `pr-screenshots/<key>` and embedded as `blob/...?raw=true` images. It fails silently somewhere along that chain; see §11. | `engine/screenshots.ts:274` |
| R11 | `createPr(..., draft: true)` is hard-coded. | `steps.ts:939, 1172` |
| R12 | Only PRs can be fixed (`pr_fix`). A branch without a PR, or "finish my unfinished work", isn't supported. | `engine/prFix.ts` |
| R13 | `prepublish` checks attribution, secrets, protected paths, tests and lint. There is no docstring rule and **no check for unwanted files** (anything the agent created gets committed). | `steps.ts:802-836` |

---

## 4. Design principles

1. **Agent at the edges, workflow in the middle.** Talking to you and deciding *what* to do is open-ended, so it uses an agent (the Conductor). Building, testing and publishing must be predictable, so they stay deterministic steps with hard checks. This is Anthropic's own guidance: use workflows where tasks are well-defined and agents where flexibility is needed ([Building effective agents](https://www.anthropic.com/research/building-effective-agents)).
2. **Events, not a pipeline.** Everything that happens is an event: a Teams message, a Jira change, a CI result, a comment, a push, a merge. A ticket reacts to events until it is closed.
3. **Your word is policy.** Instructions in Teams become stored directives that the gates read. Defaults apply only when you said nothing.
4. **Ask the data before the human.** Every agent question goes to the knowledge agent first.
5. **One decision, one message.** Each thing that needs you is one short message. Details are behind a link or "show more".
6. **Cheap by default, strong where it matters.** Rules, then a mid-tier model, then the large tier only for planning and coding (§9).
7. **Safety rails never bend**, whatever the directive (§10).

---

## 5. Target architecture

```
 Teams (you) ─┐                                       ┌─ GitHub (PRs, CI, comments, reviews)
              ▼                                       ▼
        ┌───────────┐   tools   ┌──────────────────────────────┐  events  ┌──────────────┐
        │ CONDUCTOR │──────────▶│ TICKET LIFECYCLE / SCHEDULER │◀─────────│ EVENT POLLERS│◀─ Jira
        │ (chat     │◀──status──│  tickets · jobs · directives │          │ ETag/If-Mod. │
        │  agent)   │           └──────────────┬───────────────┘          └──────────────┘
        └─────┬─────┘                          │ runs jobs (parallel, per-repo limits)
              │ asks                           ▼
              │                ┌─────────────────────────────────────────────┐
              │                │ WORKERS (existing steps, unchanged core)    │
              │                │ understand · plan · implement+test ·        │
              │                │ reviews · STANDARDS GUARD · publish ·       │
              │                │ ci-fix · comment-fix · review · QA · adopt  │
              │                └──────────────────┬──────────────────────────┘
              │                       questions   ▼
              │                ┌─────────────────────────────┐
              └───────────────▶│ KNOWLEDGE AGENT (ask-desk)  │── Jira · Notion · Figma ·
                  escalations  │ answers or escalates        │   Brain · code · decision log
                               └─────────────────────────────┘
```

### 5.1 Conductor (replaces the intent list)

One agent (mid tier) that talks to you and has **tools** instead of intents.

| Tool | Does |
|---|---|
| `find_tickets(text)` | Jira search by key, title words or description (JQL `text ~`), plus the plugin's own tasks. Returns the best matches. |
| `start_work(tickets[], directives)` | Starts one or many tickets, a request without a ticket, or a batch |
| `status(scope)` | All work, one ticket, or one PR: state, waiting on, last event, cost |
| `decide(ref, approve / reject / answer, text)` | Approvals and answers |
| `fix_pr(pr, mode: auto / ci / comments / qa)` | Fix a PR. `auto` looks at what is red or open and fixes all of it. |
| `review_pr(pr)`, `qa_pr(pr)` | Review or QA a PR |
| `adopt_branch(repo, branch, ticket?)` | Finish work you started (§7.6) |
| `set_directive(scope, rule)` | Store an instruction (§5.3) |
| `cancel / pause / resume(ref)` | Control |
| `lookup(...)` | Read-only Jira, GitHub, Brain and code lookups to answer questions |

How a message is handled:

1. **Fast path (no AI, under 1 second):**
   - while a single question is pending: "yes", "1", "approve", "start KAN-47";
   - an exact key plus a clear verb.

   This is today's rules, unchanged.
2. **Otherwise the Conductor runs**, with:
   - a cached system prompt and tool list;
   - a **working-set summary**: every active ticket, its state and what it's waiting on, about 1–2k tokens;
   - the last 20 chat turns (`chat_log`, which already exists);
   - the message.

   It may call several tools in one turn. "Do KAN-45 and the invite-email task, no approval needed, backend first" becomes `find_tickets`, then `start_work` with directives.
3. **Confirm only when it matters:**
   - destructive actions (cancel, reject, reset);
   - an ambiguous match ("did you mean KAN-47 *Invite emails* or KAN-52 *Email templates*?").

   Everything else is done, then reported in one reply.
4. **Free questions** are answered with the lookup tools, like Claude.

Because the Conductor sees the working set, every reply can carry a one-line digest of the other tickets when it's relevant (R7).

### 5.2 Ticket lifecycle and event loop (the ticket stays alive)

New states after publish: `PR_OPEN` (watching) → `MERGED` / `CLOSED` (final). DONE now means "merged or closed", not "PR raised".

**Events.** The pollers write rows to a new `events` table: `{type, ticket, pr, payload, at}`.

| Event | Source | Reaction (default) |
|---|---|---|
| `ci_failed` | check runs on the PR head | **Auto CI-fix job** (no asking, §7.4) |
| `ci_passed` | check runs | Tell the author "✅ CI green on PR #N". Stop watching CI. |
| `comment_added` / `review_submitted` | PR comments and reviews by other people | Tell the author, with a summary and "say *resolve the comments*". If directive `auto_resolve`, run the comment-fix job. |
| `review_requested` (me) | GitHub search `is:pr is:open review-requested:@me` | Tell the reviewer, with the link and "say *review PR N*". If directive `auto_review`, run it. |
| `teammate_pr_opened` | open PRs in the project repos by others | Optional notice to the reviewer (configurable) |
| `new_commits` on a PR I reviewed | exists today | Tell the reviewer "author pushed fixes, re-review?" |
| `branch_pushed` by me on a ticket branch | local and remote refs | Update the ticket's base. Never overwrite your commits. |
| `pr_merged` / `pr_closed` | PR state | Close the ticket, record memory, clean up the worktree |
| `jira_changed` | exists today | Tell you. Re-plan only if work hasn't started. |
| `user_message` | Teams | Conductor |

**Jobs.** Reactions start **jobs** on the ticket: `ci_fix`, `comment_fix`, `review`, `qa`, `adopt`, `replan`. A job is a small playbook made of today's steps, run in the ticket's worktree. There is one active job per ticket at a time; new events queue behind it, and duplicates are merged. This replaces separate FIX-n tasks: everything about KAN-45 lives on KAN-45, so status and history are in one place.

**Polling.** Polling stays local, with no webhooks and no server:

- GitHub is polled with **conditional requests**, using `ETag` / `If-Modified-Since`. A 304 response costs no rate limit when the request is authenticated ([GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)).
- Intervals:
  - 60 s for PRs with CI running or a job pending;
  - 3 min for open PRs;
  - 10 min for review requests.
- Requests are sequential (no bursts), to stay clear of secondary rate limits.

### 5.3 Directives: your instructions as policy

A directive is `{scope, rule, value, from, at, until?}`:
- **scope:** global, a project, a batch, or a ticket;
- **from:** always the owner's own Teams chat.

The Conductor creates directives from plain language. **Each one is echoed back once** ("Got it – for KAN-45 and KAN-47: no plan or PR approval; backend only"), so you always know what is in force. `status` lists the active ones, and "ask me again" or "back to normal" removes them.

| Rule | Effect on the engine |
|---|---|
| `skip_plan_approval` | `plan_gate` passes, but the short plan is still sent as information |
| `skip_pr_approval` | `request_approval{create_pr}` passes; the PR is raised and you're told |
| `auto_fix_ci` (**default on**, as you asked) | CI fixes are pushed without showing first |
| `auto_resolve_comments` | Comment fixes are pushed without showing first |
| `auto_review` / `auto_post_review` | Review PRs where I'm the reviewer, and optionally post without showing |
| `auto_qa_issues` | QA findings become GitHub issues without the draft step |
| `repos: [...]` / `order` / `priority` | Limit or order the work |
| `no_questions` | Make reasonable assumptions, list them in the PR and plan, and don't ask |

The gates read `effectivePolicy(ticket)` = ticket directives, over batch, over project, over global, over defaults. The **safety rails in §10 are not directives and can't be switched off.**

### 5.4 Knowledge agent ("ask-desk")

Every agent question goes to `askDesk(question, ticket)` instead of `need_info`. That covers triage, understand, the planner, the implementer, reviewers, the CI fixer and the comment resolver.

1. **Look up, cheapest first:**
   1. the **decision log** (answers already given for this ticket, project or batch);
   2. the ticket, its comments and linked tickets;
   3. the PRD and Notion;
   4. Figma (only for UI questions);
   5. the Brain handbook;
   6. **the code** (grep and read in all of the project's repos);
   7. previous chat turns about this ticket.
2. **It returns** `{answer, confidence: high|medium|low, evidence[], kind: fact|product_decision}`.
3. **High confidence and a fact:** the answer goes back to the asking agent, is written to the decision log, and is shown in the plan as "Found: …, from <source>".
4. **Medium confidence:** the agent proceeds with the answer, and it's listed as an **assumption** in the plan and PR, so you can correct it.
5. **Low confidence, or a product decision** (pricing, copy, behaviour the ticket doesn't define): it's escalated to you, **batched**. All open questions for one ticket go in one message; with directive `no_questions`, the agent assumes and records the assumption.

The decision log means the same question is never asked twice, in this ticket or a related one.

### 5.5 Standards guard (R13)

**Learned once per repo** (extends `brain/conventions.ts`):
- docstring style, detected from existing code: Google, NumPy or reST for Python; JSDoc or TSDoc for TS/JS;
- whether public functions carry them;
- naming, import order, file layout;
- test location and naming (`tests/...`, `*.test.ts`);
- the repo's own lint, format and type-check commands.

These go into the implementer's prompt as a short, concrete rules block with one real example from the repo.

**Enforced before every commit and push** (new checks in `prepublish` and in every job that pushes):

1. **Pushable-files filter.** Each changed or new file is classified:
   - **source** – keep;
   - **test** – keep only if it's in the repo's test layout *and* covers this change;
   - **scratch / debug** (`tmp_*`, `debug_*`, `scratch*`, `*.log`, `*.orig`, notebooks, ad-hoc `test_*.py` in the repo root, coverage output, `.env*`, local config, screenshots) – **removed from the commit and reported**.

   Anything else not matched by a rule is decided by a cheap model call ("is this file part of the deliverable?").
2. **Docstring check.** New or changed public functions without a docstring in the repo's style go back to the implementer for one short pass. Python uses `ruff` pydocstyle rules when the repo enables them; otherwise there is a small AST check.
3. **Format and lint** with the repo's own tools on the changed files (exists today), then **type-check** if the repo has one.
4. **Git hooks run as normal** (never `--no-verify`).

### 5.6 Scheduler (many tickets at once)

- `maxParallel` becomes 5 by default (configurable). Build jobs are still limited to 2 per repo, because of disk and CPU.
- **Priority queue:**
  1. jobs where you're actively waiting (you just asked);
  2. CI fixes on open PRs;
  3. comment fixes;
  4. new tickets;
  5. background review and QA.
- Long agent steps don't block the Conductor: chat is served by its own loop, so you can talk to it while 5 tickets build.

---

## 6. Messages in Teams

**Rules for every message:**
- Every message starts with the ticket ref and title.
- One decision per message.
- Long detail goes behind a link (the plan file, PR or report) or "say *details KAN-45*".

**The one plan message (R4):**

```
📋 KAN-45 · Invite members by email — plan
Backend only · size M · ~6 files
1. Add POST /invites (validate email, 7-day token)
2. Send the invite email via the existing mailer
3. Tests: invite created, duplicate email, expired token
Found: token expiry 7 days (PRD §3.2) · Assumed: resend allowed after 24 h
Risk: none notable
Full plan: <link>        Reply "approve", or tell me what to change.
```

- "Picked up" and context notices are **not** sent separately. They're folded into this message.
- With `skip_plan_approval`, the last line becomes "Starting now."

**The bulk message (R3):**

```
👍 Starting 4 tickets (no approvals, as you asked)
• KAN-45 Invite emails — backend
• KAN-47 Seller dashboard filters — frontend
• KAN-166 Rate limits — backend
• KAN-52 Chat chips — both repos (backend first)
Questions only if something can't be found. Say "status" anytime.
```

- **Questions** are batched: one message per ticket per round.
- **Progress:** no per-step chatter. You get one message per milestone: plan, PR raised, CI green or fixed, comments received or resolved, merged.
- **Status** ("status", "how are the others?"): one line per active ticket, for example "KAN-47 – implementing (3/6 steps) · KAN-45 – PR #140 CI fixing (round 1)".

---

## 7. End-to-end flows

### 7.1 A message in Teams
1. The fast path handles it if it can.
2. Otherwise the Conductor runs, with the working set and history. It calls tools, confirms only destructive or ambiguous actions, and sends one reply.

### 7.2 One ticket, default policy
These steps are today's, kept:
1. Triage.
2. Understand (code, Jira, Figma, Notion), with the ask-desk answering what it can.
3. Plan, then plan review.
4. **One plan message**, then approval.
5. Implement and test.
6. Reviews.
7. **Standards guard.**
8. Pre-publish.
9. Report (with screenshots for frontend changes).
10. PR approval.
11. **Ready-for-review PR** to `dev`, with reviewers requested.
12. State `PR_OPEN`: CI is watched immediately, and events drive everything after that.

### 7.3 Bulk with "no approval"
1. "Do KAN-45, KAN-47, KAN-166 and the invite task, no approval needed."
2. The Conductor runs `find_tickets`, then `start_work` with a batch and the directives `skip_plan_approval` and `skip_pr_approval`.
3. One bulk message is sent.
4. The tickets run in parallel under the scheduler limits.
5. Questions go to the ask-desk first. Only product decisions reach you, batched.
6. Each ticket ends with "PR #N raised", and later "CI green".

### 7.4 CI fails after the PR (R2)
1. A `ci_failed` event starts a `ci_fix` job on the ticket, in its worktree. No message is sent yet.
2. The job collects each failed check's step, command and first error. This works today via `describeFailure`, and only an excerpt of the log is sent to the model.
3. **The failure is classified:**

   | Class | Action |
   |---|---|
   | Code, lint, format, type or test failure caused by the change | Fix, run the same command locally, standards guard, commit `fix(scope): …`, **push**. No approval (`auto_fix_ci`). |
   | Also fails on `dev` (not caused by this PR) | Don't touch it. Tell you "CI check X is red on dev too". |
   | Flaky or infrastructure (timeout, runner, network) | Re-run that job once via the API, then treat it as a real failure |
   | Needs a human artefact (baseline re-record, paid eval, secret, CI config change) | Don't fake it. Tell you exactly what's needed. Never weaken tests or edit workflows to go green. |
4. Watch the new head. Up to 3 rounds; then one message: "CI still red after 3 fixes: <reason>".
5. **One message at the end:** "✅ PR #140: fixed lint (ruff format in 2 files), CI green."

"Recheck and resolve PR 140" (or "the PR failed, fix it", "resolve the CI") runs the same job immediately, through `fix_pr(mode: auto)`. The rule regex gains `resolve`, `recheck` and `rerun`. Ambiguous wording ("resolve PR 140") means **fix everything that is open**: CI first, then comments.

### 7.5 Two developers (R6)

Both of you run the plugin, each on your own computer. **GitHub is the shared channel.** No server is needed, so everything stays local.

```
 Sneha's plugin (author)                  GitHub                       Eric's plugin (reviewer)
 raise PR #140, request reviewer ──────▶ review_requested:eric ──────▶ "🔔 Sneha raised PR #140 (KAN-45). Say 'review PR 140'
                                                                          or open it and comment."
                                                                       Eric: "review PR 140" → review job →
                                         review comments ◀──────────── shown to Eric → he says "post" (or auto_post)
 comment_added → "💬 Eric left 4 comments ◀─ comments
   on PR #140. Say 'resolve the comments'."                            "📝 Posted 4 comments on PR #140" (to Eric)
 Sneha: "resolve the comments" → comment_fix job → push,
   reply on each thread, re-request review ──────▶ new commits + replies ─▶ "🔁 Sneha resolved 4/4 comments on PR #140 –
 "✅ Resolved 4 comments on PR #140, pushed abc123" (to Sneha)              re-review?"
 Either: "QA PR 140" → QA job → GitHub issues created, linked in the PR → both plugins see the issues/comments → both told
```

- **Each plugin speaks only to its own user,** so "both users get the message" happens naturally: each plugin reacts to the GitHub event that concerns its user.
- **Clear ownership,** so two plugins never fight over a PR:
  - only the **author's** plugin pushes to the PR branch;
  - only a **reviewer's** plugin posts reviews;
  - either can run QA, which only creates issues.
- **Reviewers** come from CODEOWNERS, then project settings (`reviewers: [...]`), then "ask me once per project".

### 7.6 Branch adoption (R12)
1. "I worked on KAN-45 on branch `feat/KAN-45/invites`, finish it."
2. The Conductor runs `adopt_branch`.
3. The plugin fetches the branch, creates a worktree **on that branch** (your commits are kept and never rewritten), and finds its base.
4. **Gap analysis** (understand agent): the ticket and acceptance criteria against your diff. The result is "done", "partly done" or "missing", plus your uncommitted intent if you describe it.
5. Short plan of the **remaining** work, then one message. Approval follows the policy.
6. Implement, test, standards guard. New commits go on top, with a normal (never forced) push to your branch.
7. If the branch has a PR, the ticket continues in `PR_OPEN`. If not, the PR is raised (after approval, or directly under `skip_pr_approval`).
8. If you push again in the meantime, the next job rebases its local work onto your new head first. On a conflict it stops and tells you; it never forces.

### 7.7 "What's going on?"
The Conductor answers from the working set: every ticket, its state, what's being waited on and the last event. It can drill into one ticket ("why is KAN-47 slow?") using the event and job history.

---

## 8. Accuracy

- **Ground every answer in data.** The Conductor and ask-desk use tools to read Jira, GitHub and code before answering. They're never asked to recall.
- **Structured outputs** for every decision-making call, as today, validated against the schema.
- **Verify by running:** local tests and lint, then CI. The plugin's work counts as done when CI is green, not when it says so.
- **Evaluator loops:** the plan reviewer, code, security and QA reviewers, and the integration check stay. The standards guard is added.
- **A conversation test set.** Real Teams messages from your history (anonymised) go into a replay suite: about 60 messages with the expected tool calls, including the cases that failed:
  - a ticket given by name;
  - "recheck and resolve";
  - "no need for approval";
  - several tickets in one message.

  Every change to the Conductor prompt must pass the suite.
- **Echo directives back** so a misunderstanding shows up straight away, not after a wrong PR.

## 9. Latency and cost

| Lever | How |
|---|---|
| **Fast path** | Rules answer simple replies in under 1 s, with no AI call (kept). |
| **Model tiers** | Rules → **Haiku** for classification, file triage and summaries → **Sonnet** for the Conductor, ask-desk, reviews and CI or comment fixes → **Opus** only for understand, plan and implement on M/L tickets. S tickets use Sonnet throughout. |
| **Prompt caching** | Each agent has a stable prefix: system prompt, tools, repo rules, Brain summary. Variable content goes last. The cache hit rate is logged per agent. Reports say Agent SDK subagents may not cache by default ([issue report](https://claudeissues.com/issue/29966-agent-sdk-subagents-have-prompt-caching-disabled-by-default-enablepromptcaching)), so this must be verified in our runner's request logs. |
| **Small handoffs** | Workers return distilled results (a decision plus a short summary), not their whole context. Multi-agent runs cost several times more tokens when context is duplicated ([overview](https://callsphere.ai/blog/cutting-token-cost-in-claude-multi-agent-systems)). |
| **Context cache per ticket** | Jira, Figma, Notion and context-pack results are cached and keyed by the ticket's `updated` time. A re-plan or job reuses them. |
| **Parallel fetching** | Jira, Figma, Notion and Brain lookups run at the same time during understand. |
| **Log excerpts** | CI fixes get the failed step and the first error (about 3k characters), not whole logs. |
| **Targeted tests locally, full suite in CI** | Kept |
| **Conditional GitHub polling** | 304s are free (§5.2) |
| **Budgets** | Per ticket and per day, with a Teams warning at 80%. `aiw cost` shows the cost per job. |

## 10. Safety rails (never switched off by any directive)
- Never merge. Never push to `dev` or `main` directly. Never force-push. Never rewrite your commits.
- PRs target `dev`. Since R11, they are ready for review rather than drafts.
- No Claude or AI mention in code, commits or PRs. Secrets scan. Git hooks always run.
- Tests only on temporary databases, never the `.env` database.
- Never weaken or delete tests, edit CI workflows, or re-record baselines to make CI pass. Those cases are reported to you.
- Decisions and directives are accepted only from the owner's own Teams chat. Text from GitHub, Jira or Figma is data, never instructions.
- Only the author's plugin pushes to a PR branch.
- Secrets live only in the OS vault.

## 11. Frontend PR screenshots (R10): diagnose, then fix

The chain is:
1. `webApp()` detects the app (needs `@playwright/test` or `screenshots.startCommand`).
2. Build.
3. The screenshotter agent writes a spec.
4. Capture.
5. Push to `pr-screenshots/<key>`.
6. Embed with `blob/...?raw=true` in the PR body.

The first job is to read `data.screenshots` (`taken`, `reason`, `problems`) on the last frontend tasks to find which link breaks. The likely candidates are:
- Playwright isn't detected or the build fails, so `taken: false` and only a fallback sentence is added;
- the step runs only in `report`, which some flows skip (fix, adopt, lead parts);
- `blob?raw=true` links to a private repo branch don't display for some viewers.

Fixes:
- Run capture in every flow that ends in a frontend PR.
- Upload the images through GitHub's own attachment route, if it's available to our token. Otherwise keep the screenshots branch you allowed, but embed with the `raw.githubusercontent` path, which renders for repo members.
- **Treat "no screenshots" as a warning shown in the PR approval message, never silent.**

## 12. Data model and settings changes

- New tables:
  - `events`;
  - `jobs` (ticket, type, state, attempts);
  - `directives`;
  - `decision_log` (question, answer, source, scope, confidence);
  - `batches`.
- Task states: add `PR_OPEN`. DONE means merged or closed. FIX-n tasks become jobs on the parent ticket; a PR without a ticket gets a light "PR ticket".
- Settings:
  - `pr.draft: false`;
  - `pr.reviewers`;
  - `workflow.autoFixCi: true`;
  - `limits.maxParallel: 5`;
  - `burstThreshold` removed (bulk is a batch);
  - `planApproval` stays as the default, overridable by directive.
- `chat_log` (exists) feeds the Conductor. The working-set summary is computed, not stored.

## 13. Delivery plan (in the order agreed)

| Phase | Scope | Done when |
|---|---|---|
| **1. Conductor** | Tool-based Conductor, `find_tickets` by name, directives with echo, multi-request messages, status of everything, the "resolve/recheck" fix | The replay suite passes, including the ticket-by-name, "no approval" and multi-ticket cases |
| **2. Lifecycle** | `PR_OPEN`, event table and pollers, CI watched from the first publish, **auto CI-fix without asking** with failure classes, jobs replace FIX-n, ready (not draft) PRs, one message per milestone | A broken-lint PR goes green with no human message except the result |
| **3. Ask-desk + messages** | Knowledge agent and decision log, one short plan message, batched questions, bulk batches | A 4-ticket batch runs with 0 questions when the data has the answers |
| **4. Two developers** | Reviewers requested on PR, `review_requested` detection, review → comments → resolve → re-review notices, QA → issues | A two-plugin test (two configs on one machine) passes the whole §7.5 sequence |
| **5. Standards + adoption** | Docstring and style rules, pushable-files filter, `adopt_branch` with gap analysis | A branch with half the work and a stray `debug_x.py` is finished, and the stray file isn't pushed |
| **6. Screenshots** | Diagnose (§11), then fix | The next frontend PR shows desktop and mobile images |

Each phase ships as its own version, with tests, and is verified on a real ticket before the next phase starts.

## 14. Risks and open questions

- **Pushing without review (CI auto-fix, "no approval").** Mitigations:
  - it only ever pushes to its own ticket branches;
  - the same checks run as before any push;
  - a 3-round limit;
  - never touches tests, CI config or baselines to go green;
  - every push is reported with what changed.
- **Two plugins on one PR.** Fixed ownership (§7.5) prevents conflicts. A hidden marker in the plugin's own GitHub comments lets each plugin recognise the other's activity.
- **Cost of the Conductor on every message.** The fast path, Sonnet with caching and a working set capped at about 2k tokens keep a typical turn small. This is measured in phase 1.
- **Questions for you before phase 4:**
  1. Who reviews: CODEOWNERS, a fixed list per project, or ask each time?
  2. When review is requested from you, should your plugin review automatically, or only when you say so? Post automatically, or show first?
  3. Should QA create GitHub issues directly, or keep the "show first" step unless you say otherwise?
