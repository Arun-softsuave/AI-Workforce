# AI Workforce – local-first AI team member for Claude Code

AI Workforce turns Claude Code into a persistent, role-based AI team member. You install the plugin, choose your
role(s), connect Jira / GitHub / Slack / Teams / Notion / Figma and link your projects. A small **local background
service** then watches for assigned work, understands it using a per-project **Brain**, runs cost-efficient
**playbooks** of specialist agents, and notifies you in Claude Code, desktop alerts, Slack or Teams.
**Nothing is published without your explicit approval, bound to the exact commit. Code is never merged or deployed.**

Everything runs on your machine. There is no cloud server; work happens while your computer is on.

Design documents: `D:\AI_Workforce_PRD_Implementation_Plan.pdf`, `D:\AI_Workforce_Brain_Architecture.pdf`,
`D:\AI_Workforce_Agentic_Architecture.pdf`.

## Install

```powershell
powershell -ExecutionPolicy Bypass -File D:\ai-workforce\scripts\install.ps1   # Windows
sh ./scripts/install.sh                                                          # macOS / Linux
```

The script builds the service, puts `aiw` on your PATH and registers the plugin
(`/plugin marketplace add D:\ai-workforce` → `/plugin install ai-workforce@ai-workforce-local`).
Restart Claude Code and run **`/ai-workforce:aiw-setup`**, or run `aiw setup` in a terminal.

Testers: see **QUICKSTART.md** for install, onboarding, the Teams bot and a test checklist.

### Onboarding (resumable – `aiw setup` shows where you are)

| Step | Command |
|---|---|
| Prerequisites | `aiw doctor` |
| Background service (autostart at login, no admin) | `aiw service install` |
| Model access | `aiw model --provider claude-login` (your Claude Code login) · `--provider claude --key-stdin` (API key) · `--provider mock` (offline dry run) |
| Profile & roles | `aiw profile --name "Asha" --roles backend-developer,qa-engineer --tz Asia/Kolkata` |
| Connectors (browser sign-in, no tokens) | `aiw connect jira` (Atlassian sign-in) · `aiw connect github` (one-time code) · `aiw connect notion` (Notion sign-in) · `aiw connect figma` (Figma desktop app, no sign-in) |
| Connectors that need an app token / URL | `aiw connect slack --browser` · `aiw connect teams --browser` – these services offer no browser sign-in for outside apps |
| Teams (two-way bot) | `aiw connect teams-personal --bot` – sign in with a separate personal Microsoft account that acts as the bot |
| Notifications | `aiw notify --primary teams-personal --fallback desktop,inbox` then `aiw notify test` |
| Project | `aiw project add --id payment-service --path D:/work/payment-service --jira-keys PAY --autonomy prepare` |
| Product documents | `aiw brain add-doc payment-service "D:/docs/PRD.pdf"` (.pdf .docx .md .txt, `--private` keeps it out of the repo) |
| Brain | `aiw brain onboard payment-service` → review `.ai-workforce/knowledge/` → `aiw brain confirm payment-service` |
| Go live | `aiw live` |

`--browser` opens a page served by the local service (127.0.0.1, session token), so secrets go straight to the OS
credential vault and never pass through the chat.

## Daily use

| In Claude Code | CLI | What it does |
|---|---|---|
| `/ai-workforce:aiw-inbox` | `aiw inbox` | Approvals, questions and failures waiting for you |
| `/ai-workforce:aiw-approve PAY-142` | `aiw approve PAY-142` | Approve the pending action (draft PR / Jira comment) |
| `/ai-workforce:aiw-reject PAY-142 "use RefundValidator"` | `aiw reject …` | Re-run with your feedback |
| `/ai-workforce:aiw-run PAY-142` | `aiw run PAY-142` | Start a ticket now |
| `/ai-workforce:aiw-tasks` | `aiw tasks` / `aiw show PAY-142` | Task list / details and report |
| `/ai-workforce:aiw-status` | `aiw status` | Health of service, connectors, projects |
| `/ai-workforce:aiw-dashboard` | `aiw dashboard` | Local web dashboard (inbox, tasks, Brain, connections, cost) |
| `/ai-workforce:aiw-pause` | `aiw pause --until 2026-12-01` | Holiday mode |
| `/ai-workforce:aiw-cost` | `aiw cost` | Tokens and cost by project, day, task |

The plugin also adds an **MCP server** (`aiw_status`, `aiw_inbox`, `aiw_approve`, `aiw_brain_ask`, …) so you can simply
ask Claude "what is waiting for me?", plus a **SessionStart hook** that shows your inbox when a session opens.
Optional status line: `"statusLine": { "type": "command", "command": "aiw statusline" }`.

## Working from Teams (two-way bot chat)

With the personal Teams bot as the primary channel, Teams is where you work. Just write normally:

| You write | What happens |
|---|---|
| `plan for KAN-42` / `can you pick up KAN-42` | Starts the ticket. The **full plan** comes back with numbered choices; nothing is coded before you approve |
| `add a CSV export to the orders page` (no ticket) | Creates `TASK-n` and **interviews you** (questions with options) until the requirements are complete, then asks you to confirm them |
| `1` / `yes` / `looks good` | Approves what is waiting (plan, requirements or "raise the PR?") |
| `2` / `no, use the existing validator` | Asks for / applies your change request – it re-plans or reworks |
| `3` | Cancels (after a confirmation) |
| a number or your own words after a question | Answers it – agents ask (with options, recommended first) whenever they are unsure while analysing, implementing or reviewing |
| `status of KAN-42?` | Where it is now ("implementing and testing, attempt 2 of 3") |
| `KAN-42 1` | When several things wait, start with the ticket |

Every ticket and every size: **plan approval → build & test (questions in Teams) → "raise the PR?" approval → PR link**.
Messages go to Teams only (no desktop copies, no fallback), there are no quiet hours (it runs 24 h while the computer is on),
and a **daily check-up** arrives at 10:00 (`workflow.checkupTime`) – also sent later the same day if the computer was off.
Approvals and answers are accepted **only in Teams** (`workflow.decisionsVia: primary`); Claude Code, the CLI and the
dashboard show status and reports.

**Claude Code:** in a repository that is an AI Workforce project, a prompt hook makes Claude hand ticket work
(`aiw_run_ticket`) and new work without a ticket (`aiw_start_request`) to AI Workforce instead of coding it in your session,
and answer "status of KAN-42?" from the same task data. Other repositories work normally. Say "do it here" to opt out once.

Settings (`~/.ai-workforce/config/settings.yaml`): `workflow.planApproval` (`always` | `autonomy`), `workflow.decisionsVia`
(`primary` | `any`), `workflow.checkupTime` (`"10:00"` | `"off"`), `workflow.questionRounds` (4), `workflow.interviewRounds` (5),
`notifications.exclusive` (true), `notifications.quietHours` (`"off"`).

**Lookups while working:** the analyst, planner, implementer and requirements interviewer get read-only tools for the
connected services – `jira_get_issue` / `jira_search`, `github_get_pr` (files, comments, reviews), `figma_get_design`
(a frame from a Figma link: layers, sizes, texts, colours) and `notion_get_page`. A Figma or Notion link in the ticket is
also loaded into the context up front. Reviewers deliberately get none (fresh eyes on ticket, plan and diff only).

**PR feedback:** comments, review comments, approvals and change requests by other people on PRs that AI Workforce raised
are posted to Teams within a few minutes (watched for 30 days).

**Teams remembers the conversation (0.3.0):** every message in both directions is kept locally (`chat_log`, 30 days). A short
reply ("1", "yes", "no, use X") goes to the item the bot asked about last, even when several things wait. "I don't know – you
check the code and decide" leaves the decision to the agent (it says what it chose in the plan). An unclear message gets
one short question ("Do you mean KAN-52 (…) or KAN-35 (…)?") instead of a list. When you ask about a waiting question, the
assistant answers from the code and offers to send that answer to the task with one "yes".

## Fixing a failed pull request's CI (0.6.7)

Say it in Teams the way you would to a colleague: "backend PR 134 failed, fix it and make sure CI passes", "fix the CI on KAN-40", "fix PR 134"
(or `aiw fix 134 --ci`). Only your own PRs.

1. **Read the failing checks** – every failed GitHub check of the PR's latest commit with its failing step, the exact command and the end of its log
   (e.g. *Regression replay: ALT-01 FAIL*). A check that also fails on the base branch is marked as possibly older than the PR. Checks still running are listed.
2. **Root cause from the code** – with the ticket, the PRD/Brain and the PR's change. Tests and checks are never weakened just to pass.
3. **Fixed and checked here** – the normal implement → lint/format → targeted tests (temporary database) → review loop, with the CI log given to the implementer.
4. **Shown first** – what failed, what was changed, the files and the local checks. Nothing is pushed before "1".
5. **CI watched** – after the push the plugin waits for every check on the new commit: all green → "✅ CI passes on PR 134";
   a check fails again → the next fix round starts by itself (shown first again), up to 3 rounds; then it asks you to look.

"resolve the comments on PR 134" now also includes the failing checks, so one request leaves the PR with no open comments and green CI.
Before 0.6.7 a "PR failed, fix it" message was read as "fix the review comments" and answered "nothing open".

## Testing on this computer (0.6.1)

**It works for any project.** Every repository gets a **test profile**, detected once from its own files by a
read-only agent and refreshed every 14 days. The agent reads the README, the `.env.example` key names (never the values),
docker-compose, package.json / pyproject / pom / go.mod, CI workflows and the e2e configs. The profile records:
- how to start the app and the path that shows it is up;
- how to build, migrate and test;
- the database engine and the names of the variables that hold its address and the cache's;
- which variable points the frontend at the backend;
- the test-login variables.

Everything below follows the profile, with built-in rules for Django, FastAPI, Express and Next.js/Vite until the
profile exists. Any field can be overridden in `projects.yaml` under `qa.profile`, and the profile is saved in
`~/.ai-workforce/projects/<id>/test-profile.json`.

Local first, Docker only when local is not possible. Ports are always free ones, so your own running servers are never
touched. Supported databases: PostgreSQL, MySQL, SQLite (a temporary file) and MongoDB (Docker).

| What | Where it runs |
|---|---|
| **The running app** (QA's live checks, PR screenshots) | The backend is started from the change on a free port. Database: (1) the **`.env` database, shared or local**, if its login really works (`SELECT 1`); (2) otherwise a **temporary database on your local PostgreSQL** (created, migrated, dropped afterwards); (3) otherwise a temporary **Docker** PostgreSQL (Docker Desktop is started if it's installed). Redis/Valkey: the `.env` one, a local one, or Docker. The frontend is built pointing at that backend (`BACKEND_ORIGIN`) and signs in with the demo account. |
| **Test suites** (pytest…) | **Never the `.env` database**, because test suites drop tables. Always a temporary database: local PostgreSQL first, Docker second. If neither is possible, the tests are **not run**, and the result says "not tested on this computer". The implementer agent no longer runs a backend's tests itself; the plugin runs them with the temporary database. A broken `.venv` is skipped for a working one (e.g. `.venv-local`). |
| **Demo login** | The team's test account (`E2E_EMAIL` / `E2E_PASSWORD` in the environment or an env file), or one saved once with `aiw qa account <project> <email>` (password asked hidden, kept in the OS credential vault). Real people's accounts are never used, and new users are never created in a login service such as Cognito. Without an account, QA asks in Teams once and uses fake API answers meanwhile. Test data is named `qa-demo-…`. |
| **Signing in (MFA apps)** | The live checks and screenshots use a signed-in session, in this order: (1) the saved session while it is valid; (2) renewed with its refresh token, which needs no MFA; (3) the demo account, answering MFA with its saved authenticator secret (`aiw qa account <project> <email> --totp`); (4) otherwise QA **asks once in Teams**. You answer with `aiw qa token <project>` (hidden input), or by replying `qa token <access> [refresh]`, which works but stays in the chat history. Every new session is saved in the OS credential vault and reused. Without a session, the work continues and those checks say **"not tested in the live local app"**. Tokens are blanked in the plugin's chat history. |
| **Secret test settings** | `aiw qa env <project>`: paste `SET NAME=value` lines (hidden input), e.g. fresh cloud credentials the backend needs to log anyone in. They are kept in the OS credential vault and given only to the QA copy of that backend, overriding `.env`. Nothing is written to a file. |
| **Local PostgreSQL login** | When the `.env` login doesn't fit your local server: `aiw qa database <project>` (hidden input, local servers only). It is used only to create and drop temporary `qa_…` databases. |

## Many developers: review → fix comments → QA → issues (0.6.0)

Every developer runs their own copy of the plugin (own Teams chat, GitHub and Jira logins). Nothing is tied to a person
or one fixed order: anyone can ask for any of these at any time, about their own work or a teammate's, and everything
that would change GitHub is **shown first** and done only after that developer's OK.

| In Teams | What happens |
|---|---|
| `review PR 90`, a PR link, `add comments on KAN-60`, `review Eric's PR` | The PR is found from a link, number, ticket key (your own tasks, else a GitHub search – e.g. a teammate's ticket) or person. Review comments are shown first; `post` posts them as a comment review. |
| `resolve the comments on PR 90` / `…on KAN-52` (your own PR) | Every open review thread and comment is decided with the Brain, ticket, PRD, contract and code: **fix**, **answer**, **disagree** (with the reason), **other repository** (that repository's PR gets the request), or **ask you** (product decisions only). The changes go through the normal implement + test + review loop in the PR's branch. You see per comment what was done and the reply; `1` pushes to the **same PR** (never forced, never merged), replies under each thread, and leaves threads for the reviewer to resolve. A teammate's PR can be reviewed but not pushed to. |
| *(automatic after the fixes are pushed)* or `QA PR 90` | **QA engineer:** risk-based plan from the PR, ticket, PRD and code. It runs the repository's tests for the changed areas (re-running failures once to spot flaky tests) and browser checks of the changed pages on the built app with fake API answers (keyboard, accessible names, mobile). Every failure is classified as product / test / environment / flaky / inconclusive, and product bugs get a duplicate search. You see the verdict (PASS / PASS WITH WARNINGS / BLOCKED / INCONCLUSIVE) and the issue drafts; `create 1, 3`, `create all` or `report only` creates the GitHub issues and posts one QA report comment on the PR. |
| `fix the QA issues on PR 90` | Same as fixing comments, starting from the issues QA created; each issue gets a note after your OK. |
| *(reviewer's side)* | When the author pushes new commits to a PR you reviewed, you are told once per commit and can say `review PR 90` again. The new review checks whether your earlier comments were addressed. |

QA runs on this computer only, never against a real database. The backend's tests use `qa.testCommand` when
`local.testCommand` can't run here, e.g. against the test containers; otherwise QA reports "environment problem"
instead of a bug. `workflow.qaAfterFix: false` turns off the automatic QA. In Claude Code: `/aiw-pr-review`, `/aiw-fix`,
`/aiw-qa` (or `aiw review|fix|qa <PR>`).

## Several tickets at once, PDF on request (0.5.1)

- **One message, several tickets** – "work on KAN-60, KAN-61 and KAN-62" (any case, any separators). Each ticket
  becomes its own task with its own plan approval, questions, PR approval and PR, exactly as with one ticket. The reply
  lists every ticket: started, already in progress, or why it couldn't start. Reply to one ticket by starting with its
  key ("KAN-61 1", "KAN-62 you decide"); a plain "1" goes to the ticket whose message came last.
- **Worked on side by side** – reading and planning steps never wait for a repository, so several tickets plan at the
  same time. Steps that build and run things on this computer (implement + test, code reviews, rebase + tests,
  screenshots) are limited per repository: `limits.maxPerProject`, default 2. The total is `limits.maxParallel`,
  default 3. A ticket waiting for you never takes a slot.
- **"Give me the PDF of KAN-52"** in Teams sends the report of a finished ticket, or builds it if it doesn't exist yet
  (e.g. tickets finished before 0.5.0). For a ticket without a PR, it says the PDF comes after the PR is raised.
- **Screenshots** are taken in a throw-away copy of the task's latest commit, placed on the repository's drive (Next.js
  can't build across two Windows drives). The app is built once with a production build and then started for each
  capture, like the repository's own browser tests. The task's own folder is never touched.
  `screenshots.buildCommand` / `screenshots.startCommand` override the defaults.

## PR review, screenshots, ticket report, clearer Teams messages (0.5.0)

- **Review any PR from Teams** – "review PR 90", "review PR 90 frontend", a PR link, or "review KAN-52's PR" (also
  `aiw review <link>` / `/aiw-pr-review` in Claude Code). Works for your own PRs and your teammates'. The PR's code is
  checked out read-only (no branch is created). The reviewer reads the Jira ticket with its comments, the PRD (project
  documents in the Brain plus linked Notion / Figma pages), the team's rules and the related code through the code graph.
  It gives a verdict (ready / changes needed / blocking), checks each requirement (met / partial / missing / conflicts with
  the PRD) and writes line comments. **The comments come to Teams first.** Reply `post`, `post 1, 3`, `drop 2`,
  `change 2: <new text>`, `2` (redo it with your feedback) or `3` (cancel). Posting is one GitHub review of type
  *comment* under your account. It never approves, never requests changes and never merges, and nothing mentions AI.
- **Screenshots in every frontend PR** – while writing the PR description, the plugin starts the app from the task's
  folder and opens the changed pages in a hidden browser. Every API call is answered by a fake and the signed-in user is
  faked too, using the same helpers as the repository's own browser tests, so no test account or backend is needed. It
  captures desktop (1440×900) and mobile (390×844) shots and checks each picture before keeping it. When the PR is raised
  the images are pushed to their own branch `pr-screenshots/<ticket>` (never the task branch) and shown in the PR's
  "Screenshots" section. The PR approval message in Teams links to them first. If the app can't be captured, the work
  goes on and the PR says why. Turn it off per project with `screenshots: { enabled: false }`; a custom start command
  goes in `screenshots.startCommand` (`{port}` is replaced).
- **A PDF report per ticket** after the PR is raised (`<KEY> – <title>.pdf`). It covers:
  - what was asked
  - the decisions (yours and the agent's)
  - what changed in each repository and why
  - a flow diagram of the change, and the contract between repositories
  - tests, reviews, the integration check and screenshots
  - PR links, and a timeline of what happened
  - effort

  It is printed locally by Edge or Chrome and kept in `~/.ai-workforce/projects/<project>/reports/<KEY>/`. It is also
  sent to Teams as a view link: the file is uploaded to the OneDrive of the Teams account the plugin signs in with.
  Anyone with that link can open the file. Turn the report off with `workflow.ticketReport: false`.
- **Teams messages** have a bold title, a blank line between sections, short lists, and each option as its own spaced
  line with a keycap number (1️⃣ 2️⃣ 3️⃣) and the recommended one marked ⭐. Long messages are split between sections,
  never in the middle of one. Personal Teams can't show clickable buttons (that needs a registered bot in a work
  tenant), so you reply with the number.

## Fewer tokens, same accuracy (0.4.0)

AI Workforce now works the way Claude Code does when you hand it a ticket:

- **Code graph (Graphify, code only, no AI tokens).** Each repository gets a knowledge graph of files, classes, functions
  and how they connect, built locally with [Graphify](https://github.com/Graphify-Labs/graphify) (`graphifyy`, Apache-2.0/MIT)
  into `~/.ai-workforce/projects/<id>/graph/` – nothing is added to the repository. The service installs Graphify into
  `~/.ai-workforce/tools/graphify` (its own Python venv) and refreshes a graph when the repository moves. Agents get
  `code_query`, `code_explain` and `code_affected` and read only the exact lines they need. `aiw graph status|build|query`.
- **Explore once, then decide.** A medium-model *explorer* finds the relevant code once per ticket and returns compact
  findings with file:line; the lead, contract, plan, implementer and parts all work from those findings. After you answer
  a question (or ask for a re-plan) nothing is read again.
- **Budgets never stop work.** Token budgets are reported, not enforced (`workflow.stopForBudget: false`). Every plan,
  result and PR message shows *Cost so far: $x (N tokens)*; "status of KAN-52" also says how long the next stage usually takes.

## Tickets that span several repositories (0.3.0)

Projects with the same `group` (e.g. `nue-backend` + `nue-frontend`) share one Jira project. A ticket for the group becomes
**one lead task** (`KAN-52`) with **one part task per repository** (`KAN-52@nue-backend`, `KAN-52@nue-frontend`):

```
understand (reads the ticket, links, Brain AND the code of every repository; asks only real product decisions)
  -> decides the repositories and the build order from the code (producer first, or both at once)
  -> contract (endpoints, fields, types, errors both sides build against)  -> one plan with a part per repository
  -> ONE PLAN APPROVAL -> each part: worktree, implement + test, reviews, rebase (in the decided order;
     the frontend sees the backend's finished change; a part's questions go to the lead, which answers from the code
     and asks you only for product decisions; contract changes are sent to the other part)
  -> integration check (both diffs + contract + each repository's tests; up to 2 fix rounds sent to the right part)
  -> ONE PR APPROVAL -> one draft PR per repository, linked to each other, one Teams message with both links
```

Teams and Claude Code show one item per ticket (`status of KAN-52` lists each repository). Cancel / resume / refresh on the
lead apply to its parts. On upgrade, tickets whose per-repository halves had not started yet are merged into one lead task.

## How a Jira ticket flows

```
poll Jira (2-5 min, zero tokens) -> Event Gate (diff vs snapshot, idempotent) -> Triage (small model: type/size/clear?)
  -> playbook (code-controlled):  prepare isolated git worktree -> context pack from Brain -> analyse -> plan (large model)
     -> fresh-eyes plan review -> PLAN APPROVAL (Teams) -> implement + test loop (max 3; may stop and ask in Teams)
     -> code/security/QA reviews in parallel (max 2 fix rounds)
     -> proposed Brain facts -> rebase + secret scan + final tests -> report -> APPROVAL (pause, 0 tokens)
     -> push branch + draft PR (Approval Service only) -> diary + Brain update
```

Notifications: Claude Code inbox (always) · desktop alert · **personal Teams, two-way** (messages from a bot account; reply
`approve …`, `reject …` or ask any question about the project – a read-only Claude assistant answers) · Slack DM thread with
Approve/Reject buttons (Socket Mode, no public URL) · work-Teams Workflows card (links only) · optional Jira comment. Quiet hours, de-duplication, batching for
sprint-start bursts and fallback channels are built in.

## Repository layout

```
.claude-plugin/        plugin.json + local marketplace.json
commands/              /aiw-* slash commands          skills/   aiw-onboarding, aiw-brain
agents/                interactive subagents          hooks/    SessionStart inbox hook
.mcp.json              registers the aiw MCP server   bin/      aiw / aiw.cmd launchers
service/
  playbooks/*.yaml     the fixed recipes (dev-feature, dev-small-change, qa-test-plan, devops-ci-failure, ba-stories, pm-daily-digest, design-review)
  src/core             paths, SQLite + migrations, config, OS credential vault, roles, logging
  src/connectors       Jira, GitHub, Slack (Socket Mode), Teams (Workflows), Notion, Figma
  src/intake           polling, snapshot diffing, idempotent events, burst handling, CI + digest scheduling
  src/engine           task state machine, playbook engine, steps, budget guard
  src/agents           agent catalog (≈10 reusable agents, tiered models) + Claude Agent SDK runner + offline mock runner
  src/brain            code map, Handbook (facts with lifecycle), FTS index, diary, onboarding, context packs
  src/approvals        approval binding (repo/branch/base/head/diff hash), first-decision-wins
  src/notify           channels + router (inbox, desktop, Slack, Teams; exclusive channel, optional quiet hours, dedupe) + daily check-up
  src/intake           … + teamsIntent (plain-language Teams messages)        src/engine/requests  work without a ticket
  src/api              local API + dashboard (127.0.0.1, token, DNS-rebinding guard)
  src/daemon           aiw-agentd main loop + autostart installers
  src/cli, src/mcp, src/hooks
  src/test             unit, end-to-end, role-playbook and service tests
```

State lives in `~/.ai-workforce/` (SQLite `aiw.db`, code maps, diaries, reports, logs, worktrees). The shared
Handbook lives in each repository under `.ai-workforce/knowledge/` and travels through PRs for team review.

## Tests

```
cd service && npm test
```

There are 62 tests. They cover the full Jira → PR flow against a real git remote, rejection with feedback, stale
approvals, unclear tickets, unassignment, sprint-start bursts, crash recovery publishing exactly once, budget pauses,
the QA, BA, DevOps and PM playbooks, notification routing, secret scanning, prompt-injection fencing, and the real
background service with its token checks and single-instance lock.

## Implementation decisions (v1)

| Topic | Decision |
|---|---|
| Runtime | TypeScript on Node ≥ 22.13; built-in `node:sqlite` (WAL) – no native DB dependency |
| Agents | Claude Agent SDK, headless, `permissionMode: dontAsk` with per-step tool allowlists; no `git push` ever allowed to agents |
| Models | small = Haiku, medium = Sonnet, large = Opus (configurable via `aiw model`) |
| Model access | API key (default for shared use), opt-in `claude-login` (Claude Code's signed-in account; counts against the user's plan – check terms), or mock |
| Product documents | PDF/Word/Markdown → sectioned markdown in `.ai-workforce/knowledge/docs/` (or private), indexed; relevant sections injected into every task's context |
| Multi-repo products | projects sharing `--group` and a Jira key; triage routes each ticket to backend / frontend / both (linked tasks) |
| Jira auth | **browser sign-in** via Atlassian's official MCP server (OAuth 2.1 + dynamic client registration + PKCE, no secret, callback on 127.0.0.1) – default; email + API token as fallback |
| Teams | Personal Teams two-way via the vendored msteams-personal-mcp core (`service/vendor/teams-personal`, MIT; token key in the OS vault); work Teams via Workflows webhook (one-way) |
| Chat assistant | Teams questions answered by a read-only Agent SDK session (Read/Grep/Glob + read-only aiw tools incl. Jira search); daily token budget; `aiw ask` from a terminal |
| Code map | language-aware regex extraction behind a replaceable interface (tree-sitter later) |
| Brain search | SQLite FTS5/BM25; an embedding index can be added behind `searchBrain` |
| Autostart | Windows Startup-folder launcher, macOS LaunchAgent, systemd --user |
| Defaults | autonomy `prepare`; ask before starting size L; draft PRs; Jira comments off |
| Team conventions | detected per repo: base branch (GitHub PR history), branch/commit style (git history), CLAUDE.md/AGENTS.md/CONTRIBUTING rules (given to every agent), PR template (filled by the Reporter), runnable lint/format/type checks (part of "done"), Jira ticket style; user overrides win; re-detected daily |
| Project environment | reuses the repo's own virtualenv interpreter and links `node_modules` from the main clone into task workspaces; a broken venv pauses tasks with the repair command |
| No AI attribution (hard rule) | commits use the developer's git identity; commit messages, PR text, Jira comments and the diff are checked and cleaned – nothing mentions Claude/AI; the local `.ai-workforce/` folder is never committed |
| PR activity | comments, review comments, approvals and change requests from other people on AI-prepared PRs are notified (Teams/desktop/inbox) |

## Known limitations

- Work only runs while the computer is on and awake. After sleep the service catches up.
- Microsoft Teams messages contain links only. Approve in Claude Code, the dashboard or Slack.
- Background runs need an API key, an enterprise provider or the opt-in Claude Code login. Check the current
  Anthropic terms before powering the unattended service with a personal subscription.
- Scanned (image-only) PDFs cannot be read; export them as text or .docx.
- Not supported yet: Jira Server/Data Center, GitLab, Bitbucket and Azure DevOps.

## License

Proprietary – internal use. See LICENSE.
