# AI Workforce – Current Architecture (v0.6.9)

How the plugin works today: what runs where, what happens when a Teams message arrives, how a Jira ticket goes
from "assigned" to a draft PR, and how PR review / fixing / CI / QA work. Everything below is taken from the code in
`service/src` and `service/playbooks` (file references in `code font`).

---

## 1. The big picture

```
                    ┌──────────────────────── your computer (nothing runs in the cloud) ─────────────────────────┐
                    │                                                                                             │
  Microsoft Teams ◄─┼──► Teams bot chat poller ──┐                                                                │
  (personal, bot    │    every 10 s (30 s idle)  │                                                                │
   account)         │                            ▼                                                                │
                    │                    ┌──────────────────┐     ┌───────────────────────┐                       │
  Jira Cloud ◄──────┼──► intake poller ──►   SQLite state   ◄────►   Engine (scheduler)   │──► AI agents          │
  GitHub   ◄────────┼──► every 3 min     │   ~/.ai-workforce│     │   tick every 15 s     │    (Claude Agent SDK, │
  Figma / Notion ◄──┼──── read only      │   /aiw.db        │     │   playbooks + steps   │     your Claude login)│
                    │                    └──────────────────┘     └───────────┬───────────┘                       │
                    │                                                         │                                   │
  Claude Code ◄─────┼──► MCP tools, /aiw-* commands, hooks, `aiw` CLI         ▼                                   │
  Dashboard ◄───────┼──► local web page (http://127.0.0.1:47821)       git worktrees (one per task)               │
                    │                                                  ~/.ai-workforce/worktrees/<project>/<task>│
                    │                                                  temp test DBs (local Postgres / Docker)   │
                    └─────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Part | What it is | Code |
|---|---|---|
| **Background service** `aiw-agentd` | One Node process per computer; auto-starts at login. Owns the scheduler, pollers and the local API (port 47821) | `daemon/agentd.ts`, `daemon/service.ts` |
| **State** | SQLite database: tasks, steps, approvals, events, notifications, chat log, meta | `core/db.ts`, `engine/tasks.ts` |
| **Config** | `~/.ai-workforce/config/settings.yaml` (you) and `projects.yaml` (Jira key ↔ repo ↔ local folder) | `core/config.ts` |
| **Secrets** | OS credential vault only (Windows Credential Manager), long values chunked – never in files or `.env` | `core/secrets.ts` |
| **Brain** | Per-project code map, conventions, Handbook (facts/lessons), PRD/BRD documents, past-task diaries | `brain/*` |
| **Engine** | Picks queued tasks, runs their playbook step by step, stops at questions/approvals | `engine/engine.ts`, `engine/steps.ts` |
| **Agents** | 27 role prompts with JSON output schemas, run on 3 model tiers | `agents/catalog.ts`, `agents/runner.ts` |
| **Connectors** | Jira (Atlassian sign-in), GitHub (`gh` login/token), Teams (personal, Graph), Figma (token), Notion (sign-in) | `connectors/*` |
| **Notifications** | One router; "exclusive" mode sends everything to the Teams chat only; inbox always records | `notify/router.ts`, `notify/channels.ts` |
| **Claude Code side** | Plugin: slash commands, MCP server, SessionStart / UserPrompt hooks, status line | `commands/`, `mcp/`, `hooks/` |

**Model tiers** (`settings.yaml → models`, provider `claude-login` = your Claude Code plan):
small = `claude-haiku-5-5` (triage, intent, short reports) · medium = `claude-sonnet-5-5` (implementer, reviewers, planner)
· large = `claude-opus-5-5` (lead, PR reviewer, comment resolver). `mock` runs everything offline for tests.

**Your current settings** (verified): maxParallel 3 tasks, maxPerProject 2 builds, poll every 3 min, ask before
starting size-L, 3 implement attempts, 2 review rounds, plan approval **always**, decisions **only in Teams**,
notifications **exclusive to teams-personal**, question rounds 4, working hours 11:00–22:00 IST.

---

## 2. The two background loops

`daemon/agentd.ts` starts two timers:

| Timer | Interval | Does |
|---|---|---|
| **Main loop** | every 15 s | `pollAll()` when the poll interval (3 min) has passed, then `tick()` |
| **Teams loop** | every 10 s (30 s when you haven't chatted for 10 min) | `pollTeamsCommands()` – read new chat messages and answer |

**`pollAll()`** (`intake/intake.ts`)
1. **Jira** – tickets in the configured projects. A ticket newly assigned to you (not Done) → `assigned` event → a task
   in `DETECTED`. Also: unassigned / closed / status changes, epics for a business-analyst role. Many new tickets at
   once (> `burstThreshold` 5) → "7 new tasks arrived at once", each waits in `AWAITING_START`.
2. **GitHub CI** (`pollCi`) – failed Actions runs on `aiw/*` branches (+ base branch for devops) → `ci_failed` task.
3. **PR activity** (`pollPrActivity`) – new comments/reviews on PRs this plugin raised → told in Teams.
4. **Reviewed PRs** (`pollReviewedPrs`) – a PR you reviewed got new commits → told in Teams.
5. **CI watches** (`pollCiWatches`) – PRs whose fixes were pushed: green → "✅ CI passes"; red → next fix round.
6. Daily digest / 10:00 check-up.

**`tick()`** (`engine/engine.ts`) – the scheduler
1. Expire approvals older than 72 h → `STALE`.
2. Paused (holidays)? stop here.
3. `DETECTED` tasks → **triage**.
4. Wake lead tasks whose parts are ready.
5. Start `QUEUED` tasks, up to **3 at once**; build steps (`implement_test`, `reviews`, `prepublish`, `report`) at
   most **2 per repository**. Planning only reads code, so it never waits for a build slot.

---

## 3. When you send a message in the Teams bot chat

```
 Teams message
      │
      ▼
 pollTeamsCommands  (intake/teamsCommands.ts)
   • only messages from the configured owner; never the bot's own
   • each message handled once (seen-key), max 10 per poll, logged to chat_log (secrets blanked)
   • "qa token …" → saved straight into the OS vault, never shown back
      │
      ▼
 exact command? ("status", "inbox", "help", "approve KAN-42@nue-backend" …) ──yes──► executeCommand
      │ no
      ▼
 handleChatMessage  (intake/teamsIntent.ts)
   1. a follow-up we are waiting for?  ("What should I change?" → your text is the feedback;
      "Here's what I understood… reply yes" → yes runs the actions)
   2. word rules – ONLY short replies (≤ 12 words / 90 chars):
        "1" / "yes" / "go ahead"  → approve the item in focus
        "2" / "no – use X"        → reject with feedback       "3" / "cancel" → cancel
        "start KAN-47", "status of KAN-52", "resume", "review PR 90", "fix PR 134", "PR 134 CI failed, fix it",
        "QA PR 90", "fix the QA issues on PR 90", "post 1, 3", "create 1, 3", "give me the PDF of KAN-52"
   3. otherwise Claude reads it ("intent" agent, medium tier) WITH the last 20 chat messages, the item in focus
      and every waiting question/approval. It may return several actions from one message.
        • approve / reject / cancel, or 2+ actions → repeated back first: "Here's what I understood … reply yes"
        • one safe action (start, status, review, fix, QA, report) → done at once
   4. nothing actionable → the read-only assistant answers the question from the Brain, the code and Jira
      │
      ▼
 reply posted FIRST (holdTicks), then the background work it started may send its own messages
```

**Intents** the chat understands (`IntentName`): `start_ticket` (one or many keys), `start_request` (work without a
ticket), `approve`, `reject`, `answer` (incl. "you decide" = delegated), `cancel`, `status`, `resume`, `review_pr`,
`resolve_comments`, `fix_ci`, `fix_qa`, `qa_pr`, `send_report`, `question`.

**Focus**: the last item the bot asked about (or you named). A bare "1" or "yes" goes to that item.
Approve/reject/cancel never happen when it is unclear which item is meant – the bot asks instead.

**Decisions only in Teams**: `decisionRefused()` refuses approvals/answers from Claude Code, the CLI or the dashboard
when `decisionsVia: primary` and the primary channel is Teams. Status, reports and starting work are allowed anywhere.

**Message format**: sections with bold headings and blank lines; options as spaced keycap numbers 1️⃣ 2️⃣ 3️⃣ with
⭐ on the recommended one (personal Teams has no buttons); long messages split at section boundaries.

---

## 4. Task lifecycle (states)

```
DETECTED ─triage─► TRIAGED ─┬─► NEEDS_INFO ──(you answer)──► DETECTED / QUEUED
                            ├─► AWAITING_START ──("start")──► QUEUED          (size L, or a burst of tickets)
                            └─► QUEUED ─► RUNNING ─┬─► NEEDS_INFO          (a step asked a question)
                                                   ├─► AWAITING_APPROVAL ─┬─ approved ─► QUEUED ─► RUNNING (publish)
                                                   │                      ├─ rejected ─► REJECTED ─► QUEUED (re-run with feedback)
                                                   │                      └─ 72 h / code changed ─► STALE
                                                   ├─► WAITING_PARTS / PART_READY / ASKING_LEAD   (multi-repo)
                                                   ├─► PAUSED  (conflict, budget, broken env with untestedWork=pause)
                                                   ├─► FAILED  (retried a few times first)
                                                   └─► DONE
```
Every step result is one of: `ok` (next step) · `need_info` (ask you) · `await_approval` · `wait` · `pause` · `fail` ·
`done` · `retriage`. A task resumes **at the step that stopped** – an answered question re-runs only that step.

---

## 5. A Jira ticket from start to PR (single repository)

**Trigger**: a ticket assigned to you in Jira (seen within ~3 min), or "work on KAN-42" in Teams, or
`/aiw-run KAN-42` / `aiw_run_ticket` in Claude Code. Several keys in one message start them all in parallel.

**Triage** (`triageTask`, small model): size S/M/L, clear or not, questions. Unclear → questions in Teams first.
Size L → "start this size-L task?" first. Playbook: `dev-small-change` (S) or `dev-feature` (M/L);
with plan approval "always" every ticket gets a plan approval.

**Playbook `dev-feature`** (`playbooks/dev-feature.yaml`):

| # | Step | What happens | You see in Teams |
|---|---|---|---|
| 1 | `prepare_workspace` | Fresh **git worktree** from the latest base branch (`dev`), branch named by the team's convention (e.g. `feat/KAN-42/slug`); test profile detected/refreshed; disk check | – |
| 2 | `context_pack` | Brain context: Handbook facts, PRD sections, past tasks, code map hits; ticket links: **Figma** frame (from the link, or the default file's frame named after the ticket), **Notion** pages | – |
| 3 | `analyse` | **Explorer** finds the relevant code (code graph first); **analyst** turns ticket + code into requirements and acceptance criteria. Only real product decisions become questions | Questions with options, if any |
| 4 | `plan` | **Planner**: steps, files, tests, risks | – |
| 5 | `plan_review` | Independent **plan reviewer**; one re-plan round if it finds gaps | – |
| 6 | `plan_gate` | **Approval 1 – `implement_plan`** | "📋 Plan for KAN-42" → 1️⃣ build 2️⃣ change 3️⃣ cancel |
| 7 | `implement_test` | **Implementer** (only agent that writes code) in the worktree → commit (team format, no AI mention) → project lint/format/type checks → **tests run by the plugin**: targeted test files for the change, on a **temporary database** (never the `.env` DB). Up to 3 attempts, test output fed back. Questions stop and ask | Questions, if any |
| 8 | `reviews` | Code, security and QA reviewers (fresh context, only ticket + plan + diff); up to 2 fix rounds; leftovers flagged | – |
| 9 | `propose_memory` | Facts/lessons proposed to the local Handbook (unverified) | – |
| 10 | `prepublish` | Rebase on latest base; hard rules: no Claude/AI mention in code, commits or authors; secret scan; protected paths (CI/infra) flagged; diff size | – |
| 11 | `report` | Frontend: screenshots (desktop + mobile) of changed pages from the live local stack; **reporter** writes PR title/body from the team's PR template | – |
| 12 | `request_approval` | **Approval 2 – `create_pr`**, bound to repo, branch, base SHA, head SHA and diff hash | "✅ KAN-42 built and tested – raise the PR?" with files, tests, reviews, cost |
| 13 | `publish` | Binding re-checked (any change → STALE); push branch; **draft PR to `dev`**; screenshots on branch `pr-screenshots/<KEY>`; never merged | "🚀 PR #… raised (draft)" + link |
| 14 | `ticket_report` | PDF report (flow, contract, timeline diagrams) built with Edge headless, shared via OneDrive link | PDF link |
| 15 | `record_memory` | Task diary + memory for next time | – |

`dev-small-change` is the same without `analyse` / `plan_review` and with one combined reviewer.

**Rejecting** ("2" + what to change): the feedback is stored and the task re-runs from the plan (or from
implementing for the fast lane); the new plan/result comes back for approval.

---

## 6. A ticket that spans several repositories (frontend + backend)

Projects grouped as one product (`nue-frontend` + `nue-backend`) get **one lead task** (`dev-lead`) and one **part
task** per repository (`dev-part`):

```
lead: understand ─► contract ─► lead_plan ─► plan_review ─► plan_gate (ONE plan approval)
         │  reads ticket + Brain + code of EVERY repo; decides which repos change and the order
         ▼
      run_parts ── starts part tasks (backend-first / frontend-first / parallel) ── WAITING_PARTS
         │           part: prepare_workspace → context_pack → implement_test → reviews → prepublish → report → part_ready
         │           a part's question goes to the lead (ASKING_LEAD); the coordinator answers from code + contract;
         │           only product decisions reach you
         ▼
      integration_check  (both diffs + contract + each repo's tests; mismatches sent back to the parts, ≤ 2 rounds)
         ▼
      request_approval (ONE PR approval for all repos) ─► publish_parts (one draft PR per repo, linked to each other)
         ▼
      ticket_report ─► record_memory
```

---

## 7. Work without a ticket

"add a CSV export to the orders page" → `start_request` → playbook `dev-request`:
`requirements_interview` (questions round by round, up to 5) → `requirements_confirm` (**approval**: "is this what you
want?") → `requirements_handoff` → the task is re-triaged and continues exactly like a Jira ticket (§5/§6).

---

## 8. Pull-request flows (any developer, any project)

PRs are found from a link, "PR 90 [repo]", a ticket key (local tasks → GitHub search → branch names) or a person
("Eric's PR") – `engine/targets.ts`.

### 8a. Review a PR – `pr-review` (yours or a teammate's)
`fetch_pr` (PR, files, CI state, existing comments, the Jira ticket and its comments, PRD/Brain) → `review_pr`
(**PR reviewer**, large model: correctness, requirements check against the ticket/PRD, line comments only on
commentable lines) → `review_gate` (**shown first**: verdict + every comment; "post", "post 1, 3", "drop 2",
"change 2: …") → `post_review` (posted as a plain **COMMENT** review – never approve / request-changes).
Later commits by the author → "X pushed new commits to PR #… you reviewed".

### 8b. Fix your own PR – `pr-fix`
Only the PR's author (or a PR this plugin raised). Modes: **comments** (review threads + general comments +
failing CI checks), **ci** (failing checks only), **issues** (GitHub issues QA created).

| Step | What happens |
|---|---|
| `fix_prepare` | Open review threads not yet answered by you, general comments, **failing CI checks of the PR's head commit with the failing step, its command and the end of its log** (and whether it also fails on the base branch); PR branch checked out in its own worktree. Nothing open and CI still running → watch CI; nothing at all → "👍 Nothing to fix" |
| `fix_plan` | **Comment resolver** (large) decides each item from the code, ticket and PRD: fix / answer / disagree / other repository / your decision / skip. External CI causes (quota, outage) → explained, not "fixed" |
| `fix_apply` | Normal implement + checks + tests loop; the CI log is given to the implementer |
| `fix_review` | Combined reviewer |
| `fix_gate` | **Shown first** – per item what was done and the reply text, changed files, test result. Approval `push_fixes` |
| `fix_publish` | Rebase onto the PR branch if it moved (never force-push), push to the **same PR**, reply under each thread, then **QA starts** (comments mode) and **CI is watched** |

**CI watch** (`pollCiWatches`): all checks on the pushed commit pass → "✅ CI passes on PR #…"; a check fails →
next fix round in `ci` mode (shown first again), at most 3 rounds; still red or running > 3 h → "please take a look".

### 8c. QA a PR – `pr-qa` (also runs automatically after fixes are pushed)
`qa_prepare` → `qa_plan` (**QA planner**: risk, areas, test files, browser checks) → `qa_run` (targeted tests on a
temporary DB; browser checks against the live local app when a session exists) → `qa_triage` (every failure
classified: product bug / test bug / flaky / environment) → `qa_gate` (**shown first** with issue drafts:
"create 1, 3", "create all", "report only") → `qa_publish` (report comment on the PR + GitHub issues you chose).

---

## 9. Testing on this computer (any project)

**Test profile** (`engine/testProfile.ts`, detected by the stack-profiler agent, refreshed every 14 days, override in
`projects.yaml → qa.profile`): how to start, build, migrate and test the repo, which env vars hold the database /
cache, the login endpoints, and settings that must be switched off against a shared DB.

**Databases** (`engine/localStack.ts`):
- **Test suites always get a temporary database**: a local Postgres (saved `qa.<p>.dbUrl` or the `.env` login on a
  local host) → otherwise Docker (pgvector image when needed). Dropped afterwards. **Never the `.env` database.**
- **Running the app** (screenshots / browser QA): the `.env` database first if it accepts `SELECT 1`, with quiet
  settings (background workers off, email stubbed); otherwise a temporary one.
- Cache: `.env` → local 6379/6380 → Docker valkey. Docker Desktop is started when needed. Free ports always.

**Sign-in for live checks** (`engine/qaSession.ts`): saved session → refresh token → demo account + TOTP (RFC 6238) →
ask **once** in Teams ("qa token …"); no session → the check is marked "not tested locally" and the work continues.

**Targeted tests**: test files changed by the task + tests named after changed modules; the whole suite only when none
match. pytest results read from JUnit XML; "only the coverage minimum failed" on a partial run counts as passed.

---

## 10. Safety rules built into the code

- Local only; secrets only in the OS vault; tokens blanked in chat logs and messages.
- Nothing outward without your approval: plan, PR, review comments, pushes, replies, GitHub issues – all **shown first**.
- Approvals bound to the exact commit/diff; any change → STALE. First decision wins.
- Draft PRs to `dev` only; **never merges**; never force-pushes; never resolves review threads.
- No Claude/AI mention in code, commits, authors or PR text (checked in `prepublish` / `fix_publish`).
- Secret scan on every diff; CI/infra/Docker paths flagged for extra attention.
- Each task in its own worktree – your own checkout is never touched.
- Backend tests never run against a shared or `.env` database.

---

## 11. Claude Code integration

- **Slash commands**: `/aiw-setup` (onboarding), `/aiw-status`, `/aiw-inbox`, `/aiw-tasks`, `/aiw-run`, `/aiw-pr-review`,
  `/aiw-fix`, `/aiw-qa`, `/aiw-brain`, `/aiw-connect`, `/aiw-project`, `/aiw-cost`, `/aiw-pause`, `/aiw-dashboard`,
  `/aiw-approve`, `/aiw-reject` (the last two are refused while decisions are Teams-only).
- **MCP tools** (`mcp/tools.ts`): status, inbox, list tasks, task report, run ticket, start request, review PR,
  Brain ask/summary/add-doc, Jira search, cost, pause, task control.
- **Hooks**: SessionStart shows what is waiting; UserPromptSubmit routes "work on KAN-42" in a project folder to the
  workforce instead of coding inline; status line shows counts.
- **CLI** `aiw`: `status`, `inbox`, `tasks`, `show`, `review|fix|qa <PR>`, `qa account|token|env|database`, `service
  start|stop`, `dashboard`, `cost`, `pause`, `doctor`, `uninstall`.

---

## 12. Where things live

```
~/.ai-workforce/
  aiw.db                       tasks, steps, approvals, events, notifications, chat log, meta
  config/settings.yaml         your settings          config/projects.yaml   projects + figma.fileKeys + qa
  projects/<id>/               code-map.json, test-profile.json, task diaries
  worktrees/<project>/<task>/  one git worktree per task (removed when done)
  logs/aiw-agentd.log          service log
<repo>/.ai-workforce/knowledge Handbook facts (local, never committed into PRs)
OS credential vault            GitHub/Jira/Figma/Teams tokens, qa.<project>.* test logins and sessions
```

---

## 13. Known limits (as of 0.6.9)

- **The service must be running** (`aiw service start`); it auto-starts at login. While it is stopped nothing is polled
  and Teams messages wait until it starts.
- Two-way chat needs **personal** Teams (teams.live.com) with a separate bot account; work Teams is one-way webhook.
- Local tests are **targeted**, not the whole suite; CI remains the full check – which is why pushes are followed by
  the CI watch.
- CI checks that need special data or paid model calls (e.g. a regression replay that needs a re-baseline, a live
  model eval with an exhausted quota) can be diagnosed and explained, but the fix flow can't regenerate such artefacts
  by itself; it asks you.
- Screenshots / live browser QA need a saved test session; without one they are marked "not tested locally".
- Figma frame search needs the Figma API token mode.
