# AI Workforce – implementation plan

**Goal:** turn today's plugin (0.6.9 installed, 0.7.0 in the code) into the dynamic, event-driven, cost-efficient system described in:
- `DESIGN-ORCHESTRATION.md`, `AIW-System-Design.html` and `ORCHESTRATION-MERMAID.md`;
- with every situation in `SITUATIONS.md` handled;
- with a live local dashboard that shows what every agent is doing (design approved in `AIW-Dashboard-Design.html`, workflow W19).

**How to read this:**
- §1 is where the code is today, checked on 16 Nov 2026.
- §2 lists the rules every change follows.
- §3 lists **every workflow** the finished plugin runs, step by step.
- §4–§6 cover the data, the modules and the phases that get us there.
- §7–§11 cover testing, cost, rollout and risks.
- §12 traces every situation to a phase and a test.

---

## 1. Current status of the code (checked 16 Nov 2026)

| Item | Status |
|---|---|
| Installed plugin | **0.6.9** (`core/runtime.ts` VERSION, `.claude-plugin/plugin.json`) |
| Code on disk | 0.7.0 onboarding work added: compiles cleanly (`npm run build`) |
| Tests | **124 / 124 pass**. Three tests were updated today for the new defaults: ready-for-review PRs, and CI fixes pushed without asking (the "show first" path stays covered by setting `autoFixCi: false` in that one test). |
| Size | ~17,400 lines of TypeScript in 60 modules; 13 playbooks; 18 test files |
| Git | `D:\ai-workforce` is a git repo **with no commits yet** – everything is untracked. **First task: an initial commit** (local only, never pushed), so every phase can be compared and rolled back. |
| Service | Not running at last check (`aiw service start`) |

### What already exists and is reused

| Area | Files | Reused as |
|---|---|---|
| State store | `core/db.ts` (SQLite via `node:sqlite`, versioned migrations 1–3) | Same database; new migrations 4+ |
| Tasks + states | `engine/tasks.ts` (14 states, legal transitions), `tasks` table | Becomes **work items** (columns added, not replaced) |
| Step history | `steps` table (tokens, model, cost, output per step) | Becomes the **durable step checkpoint** |
| Event idempotency | `events` table (`idem_key` UNIQUE) – used by Jira and CI polling (`intake/intake.ts:61, 236`) | Becomes the **event log** for all sources |
| Engine | `engine/engine.ts` – tick loop, scheduler limits, step results (`ok`, `need_info`, `await_approval`, `wait`, `pause`, `fail`, `done`, `retriage`) | Becomes the **kernel**; step results stay the contract |
| Playbooks + steps | `playbooks/*.yaml`, `engine/steps.ts` (29 steps), `prFix.ts`, `prReview.ts`, `qa.ts`, `requests.ts` | Become **recipes** and the **step library** – step code reused unchanged |
| Two-repo lead/parts | `dev-lead` / `dev-part`, `contract`, `run_parts`, `integration_check`, `publish_parts` | Generalised to batch / epic / sprint |
| Agents | `agents/runner.ts` (Claude Agent SDK, tiers, schemas, mock), `agents/catalog.ts` (30 agents), `agents/lookup.ts` (read-only Jira/GitHub/Figma/Notion tools) | Same runner; lookups move behind the **context broker** |
| Approvals | `approvals/approvals.ts` (bound to repo, branch, head SHA, diff hash, 72 h) | Called by the **policy gate** |
| Teams | `intake/teamsCommands.ts` (poller), `teamsIntent.ts` (rules + intent model), `chat/assistant.ts`, `notify/chatLog.ts`, focus | Rules = **fast path**; intent model + assistant → **Conductor** |
| Notifications | `notify/router.ts`, `channels.ts`, `checkup.ts`, `notifications` table | **Messenger** on top |
| Brain | `brain/*` (code map, handbook, FTS index, graph, docs, conventions) + 0.7.0 `standards.ts`, `ciPipeline.ts`, `rulesCard.ts` | **Knowledge service** inputs |
| PR activity | `intake/prActivity.ts`, `prFix.ts: pollCiWatches` (meta key `fix.ciwatch`) | Become **event producers** |
| Local testing | `engine/localStack.ts`, `testProfile.ts`, `qaSession.ts`, `screenshots.ts` | Unchanged (DB rule changes, §5.9) |
| Dashboard | `api/dashboard.ts` (85-line page: Inbox, Tasks, task detail, approve/reject, Brain ask, connect forms), `api/server.ts` routes (`/api/status`, `/api/tasks`, `/api/inbox`, `/api/approve`, `/api/answer`, `/api/pause`, `/api/cost`, `/api/connect/*`), `aiw dashboard` (opens `127.0.0.1:<port>/?t=<token>`) | Same server, token and routes; page **rebuilt** to the approved design with a live stream (W19) |
| 0.7.0 (code, not released) | `core/team.ts`, `engine/ready.ts`, `intake/ticketIndex.ts`, `aiw team / prefs / ready / tickets`, normal PRs, reviewers requested, CI watched from the first PR, CI fixes pushed without asking, Handbook on Sonnet + incremental | Phase 0 finishes it |

### Gaps against the design (what this plan builds)

1. **Parent/child levels:** only `lead → part`. There's no batch, epic or sprint, no dependency edges, and no merge order.
2. **Lifecycle:** a task ends at `DONE` when the PR is raised. Fix, QA and review are separate tasks (`FIX-n`), and there's no `PR_OPEN` state.
3. **Teams:** a fixed list of 16 intents (`agents/catalog.ts:104`). There are no stored instructions (directives), and "approve with a change" and "undo" aren't possible.
4. **Event handling** is spread across modules: `pollCiWatches`, `pollPrActivity`, `pollReviewedPrs`. There's no single event → job table, and no rule that only one job runs per item at a time.
5. **No context broker or knowledge service.** Agent questions go straight to the user, except for two-repo parts.
6. **No connector health loop.** Problems are noticed only when a task fails.
7. **Messages are long:** the plan is split into chunks (`splitMessage`). Routine notices aren't merged, and there's no "details" command.
8. **Teammate PRs, review requests, conflicts, merge and close** aren't handled. Reviews of old work, finishing a branch (adopt), and taking over or handing back aren't either.
9. **Test database:** tests always use a temporary database. The new rule is that the `.env` database is allowed.
10. **Dashboard:**
    - it only refreshes when you click;
    - nothing shows which agent is working on what right now, or a ticket's progress through its stages;
    - background jobs, connector health and sprint/epic grouping aren't shown;
    - there's no activity feed.

---

## 2. Implementation rules (every phase)

1. **Strangler, not rewrite.**
   - The new kernel runs alongside the old engine behind a setting: `engine.version: v1 | v2`.
   - Recipes move over one at a time.
   - The old path is removed only when all its tests pass on v2.
2. **Step code is reused.** Existing `STEPS[name]` functions keep their signature and their `StepResult` contract. New steps follow the same contract.
3. **Code drives, agents decide.** No model calls in polling, scheduling, gates, messages or merge order. Model answers only choose among fixed options (structured output).
4. **Every phase ships.** Each phase:
   - bumps the version;
   - keeps all tests green;
   - adds scenario tests for the situations it covers (§12);
   - is installed and checked on your real repos before the next phase starts.
5. **Nothing leaves the machine without the gate.** Push, PR, comment, issue and Jira writes go through the policy gate and bound approvals.
6. **Measure cost.** Every agent call records tokens, cache reads and model in `steps`. Each phase has a token budget test on the mock runner (§9).
7. **Standing rules hold:**
   - local only;
   - no AI mention anywhere;
   - never merge, never force-push;
   - git hooks always run;
   - secrets only in the vault;
   - decisions only from your Teams chat;
   - short messages (questions may be longer).
8. **Outside text is data, never orders (§11a).** Jira text, PR and issue comments, Figma text, documents, and text inside images or files are given to agents as marked, quoted data. Only your own typed Teams messages (and the dashboard or CLI on your machine) can start, approve, cancel or change rules.
9. **Measure first, build in thin slices.** Phase 0.5 records today's cost and accuracy on real tickets. Every later phase must keep or improve those numbers (§8). Phase 1 runs **one M ticket end-to-end** on the new engine before widening.

---

## 3. Every workflow in the finished plugin

Notation:

| Mark | Meaning |
|---|---|
| ⚙ | plain code (free) |
| 🟢 | Haiku |
| 🔵 | Sonnet |
| 🟣 | Opus |
| 🙋 | a decision from you (skipped when your instruction says so) |
| ✉ | a Teams message |

**Model** = the branch is chosen by an agent's structured answer. **Code** = a rule.

### W1. Teams message (fast path + Conductor)

**Trigger:** any message from you, including quoted replies, image-only messages and files (W1a).
0. ⚙ **Read the whole message** (W1a): text, quote (quoted message ID, author, preview) and attachments.
   - A quote of a **bot message** sets the target item and question exactly. This beats focus.
1. ⚙ Fast path:
   - if the target is known (quoted bot message, or a single item in focus) and the text is `yes / no / 1..n / approve / status / details X` or an exact command with a key, act.
   - Under 1 s.
2. ⚙ Otherwise, build the context:
   - cached prefix: instructions, tools, preferences, active directives, team;
   - the **working set**: one line per active item;
   - the last 20 turns, older ones summarised by 🟢.
3. 🔵 The Conductor calls tools:
   - `find`, `preview_scope`, `start`;
   - `decide` (approve / reject / answer / approve-with-change);
   - `set_directive`, `prefs`;
   - `control` (pause / resume / cancel / priority / takeover / handback / undo);
   - `fix_pr`, `review`, `qa`, `adopt`;
   - `status`, `explain`, `lookup`.
4. ⚙ Destructive or ambiguous? → one short question. Otherwise act.
5. ✉ One reply. A new directive is echoed once.

**Tokens:** 0 on the fast path; 8–12k (mostly cached) on the Conductor path.
**Covers:** J1–J14, B1–B3, B19–B20, D2–D4, D8.

### W1a. Quoted replies, images and files in Teams

**What happens today** (checked in the code):
- **Quotes:** the vendored Teams client (`vendor/teams-personal/core/teams.js`, `parseReply`) already reads the quote, but our poller (`intake/teamsCommands.ts`) uses only `m.text`, so **the quote is lost**.
- **Image-only messages are dropped:** `isUserMessage` skips messages with no text.
- **Files and images that come with text are ignored**, although `core/files.js` can already list them (`attachmentsOf`), download them with a size cap (`readCapped`), and read PDF, Word, Excel and PowerPoint (`fileToText`).

**Quoted replies (⚙, 0 tokens):**
1. Every message the plugin sends stores its **Teams message ID** with the item, the question key and the options (`chat_log.msg_id`, `item_id`, `question_key`).
2. Incoming messages keep `replyTo` (quoted message ID, author, preview).
3. **The quote is a bot message:**
   - the reply goes to **that item and that question**, even if newer questions are waiting;
   - an old or already-answered question gets one short reply ("KAN-35 was already answered: Hide. Change it?").
4. **The quote is your own or a teammate's message:** the quoted text goes to the Conductor as context ("fix this in KAN-52" plus the quoted bug report becomes a requirement on KAN-52). It is marked as outside text (rule 8).

**Images and files:**
1. Image-only and file-only messages are kept.
2. ⚙ Download with the existing helpers:
   - size cap, safe types only;
   - risky types (executables, scripts, archives with them) are refused with a short reply;
   - saved to `~/.ai-workforce/items/<item>/inputs/`, never in a repo.
3. ⚙ **Which item:** the quoted bot message, then the focus item, then an item named in the text. Otherwise one question: "Is this for KAN-52 or KAN-35?".
4. Understanding:
   - **Image** (bug screenshot, error, UI, sketch): 🟢 Haiku describes it once (what it shows, any error text). The description is cached by file hash. The **image itself** goes to an agent only when it needs to see it (UI matching, design check). About 1–2k tokens per screenshot.
   - **Document** (PDF, Word, Excel, PowerPoint, text): ⚙ `fileToText`; the broker caches it and gives agents only the part they need.
5. The input is added to the item's design document under "Inputs from you" (W5a), with a link to the file, so every later agent sees it.
6. ✉ One short reply: "Added screenshot to KAN-52 (error: 500 on empty list)."

**Safety:** text read from images and files is data, never orders (rule 8). An image saying "approve KAN-52" approves nothing.

**Covers:** J-group replies, D2–D4 (answering the right question), C-group inputs (screenshots, documents).

### W2. Onboarding and ready check (0.7.0 + Phase 2)

**Trigger:** `/aiw-setup`, adding a repo, a weekly refresh.

Steps:
1. ⚙ Prerequisites, then the service.
2. ⚙ Model.
3. ⚙ Profile.
4. ⚙ Connectors (Jira, GitHub, **Figma token first**, Teams bot).
5. ⚙ Projects and groups.
6. ⚙ **Team:** contributors, CODEOWNERS, then reviewers.
7. ⚙ Documents.
8. ⚙ **Learn each repo:** code map, conventions, docstring style, test layout, CI pipeline map.
9. 🔵 **Rules card:** one model call, only if the instruction files are long.
10. 🔵 Handbook: incremental after the first run.
11. ⚙ **Preferences:** normal PR, auto-fix CI, plan and PR approval, auto review/QA, parallel limit.
12. ⚙🔵 **Ready check:**
    - push access and the base branch;
    - lint tools;
    - the test profile (🔵 once) and the test database;
    - Playwright;
    - CI;
    - **a scan for test fixtures that wipe tables**, which asks once whether `.env` is OK for that repo.
12a. ⚙ **Environment doctor** (also runs before every build, cached for 1 h):
    - language versions (Python/Node) against the repo's files;
    - dependencies installed and importable (a broken Python env that paused KAN-52 is caught here);
    - `.env` present with the needed keys (names only, values never read into prompts);
    - the database reachable;
    - services the tests need (DB, cache, queue) running or startable with the repo's own command;
    - a 1-test smoke run.

    Result: ✅ ready, or a short list "tests can't run because …, fix: …". A build never starts on a broken environment. The item waits as **Blocked: environment** and resumes when the doctor passes.
13. ⚙ Go live.

**Tokens:** ~25–40k per repo, once. **Covers:** A1–A5, A8–A10, F3, F4.

### W3. Connector health

**Trigger:** clock, every 5 min.
1. ⚙ Jira `myself`, GitHub `user` (conditional request), Figma token `me`.
2. ⚙ State changed to down: `connector_down` event.
   - ✉ "⚠️ Jira disconnected – run `aiw connect jira`", sent at once and repeated every 4 h in working hours.
   - Jobs that need it go **BLOCKED**; everything else runs.
3. ⚙ Back up: `connector_up` event.
   - ✉ "✅ Jira reconnected".
   - Blocked jobs resume.

**Tokens:** 0. **Covers:** A6, A7, L4.

### W4. Intake: a new item

**Trigger:**
- `ticket_assigned` (Jira poll);
- `start(...)` from the Conductor;
- a request without a ticket;
- `ticket_changed` / `ticket_reassigned` / `ticket_cancelled`.

1. ⚙ Create a work item: level `ticket`, `request`, `batch`, `epic` or `sprint`. Skip duplicates. B6: if an item for this ticket already exists, say where it is instead of creating another.
2. ⚙ Someone else's ticket? → 🙋 ask once (B5).
3. ⚙ Attach the directives in force.
4. ⚙ Size gate:
   - a sprint or "all my tickets" always gets a **preview** (W8).
   - size L asks "start?" unless a directive says otherwise.
5. ⚙ Queue it with a priority.

**Covers:** B1–B6, B9, B17, B19, B20, C8.

### W5. Build a ticket (the `build` recipe)

**Trigger:** the item is queued, or `start`.

| # | Step | Who | Branch |
|---|---|---|---|
| 1 | `triage` | 🟢 | **model:** size S → W5-S (Sonnet throughout); M/L → continue; unclear → W11 ask-desk / 🙋 |
| 2 | `prepare_workspace` | ⚙ | worktree from the base branch |
| 3 | `context_pack` | ⚙🟢 | fetch Jira / PRD / Figma frames / Notion **once**, distil and cache |
| 4 | `understand` | 🟣 | writes the **item code note** (files, entry points, flow, SHA-stamped), requirements, criteria, Figma frame pointers. **Model:** repos = 1 → continue; 2 → W6 lead |
| 5 | questions | 🔵 W11 | **model:** fact → answered and logged; product decision → 🙋 (one message, all questions) |
| 6 | `plan` | 🟣 | writes the item's **design document** `design.md` (W5a): steps, files and why, tests, areas (for area locks) |
| 6a | `doc_readiness` | 🔵 goldfish | **M/L/two-repo only (W5a).** A fresh session reads only `design.md` and the files it names. **Model:** ready → continue; questions → W11 answers them **into the doc** (product decisions → 🙋), then a new goldfish, at most 2 rounds |
| 7 | `plan_review` | 🔵 goldfish | critic from the doc only (never the planner's conversation). **Model:** pass → continue; issues → the doc is fixed at step 6 (once) |
| 8 | `plan_gate` | ⚙ | **code:** approval on → ✉🙋 one short plan message; off → ✉ plan as information |
| 9 | `implement_test` | 🟣 (S: 🔵) + ⚙ | lint and targeted tests. **Code:** fail → retry (≤ 3, failure only). Mid-turn needs go through the **broker** (Figma, code, `ask`); `contract_change` → W6 |
| 10 | `reviews` | 🔵×3 (+ 🔵 design check) | **model:** blocker → step 9 with findings only (≤ 2 rounds). **Frontend with a Figma frame:** the **design check** compares the app screenshot with the Figma frame image and the exact values (spacing, colours, tokens, states), and lists differences as findings |
| 11 | `standards` | ⚙🟢 | docstrings in the repo's style (one short 🔵 pass if missing); **stray files removed and listed** |
| 12 | `prepublish` | ⚙ | rebase, tests, secrets, no AI mention, protected paths |
| 13 | `report` | 🔵 | PR text from the template; frontend: 🔵 screenshots (a warning if they fail) |
| 14 | `request_approval` | ⚙ | **code:** PR approval on → ✉🙋; off → continue |
| 15 | `publish` | ⚙ gate | normal PR to dev, reviewers, **merge order** line, Jira link → state **PR_OPEN** |

After step 15, the events in W9–W14 take over.

**Messages:** plan, built (if PR approval is on), PR raised. **Tokens:** ~0.2–0.4M for an M ticket.
**Covers:** B1–B4, B13–B14, C1–C11, D1–D6, E1–E13, F1–F7, F9.

### W5a. Design document and goldfish checks (elephant–goldfish method)

**Idea** (from the elephant–goldfish method):
- The **elephant** sessions write one design document per item: `understand` and `plan`, using the ticket, Figma, Brain, Graphify and the code.
- **Goldfish** checks are fresh sessions with **no conversation history**. They see only the document and the files it names, and they test it **before** any code is written.
- **The document is the source of truth.** Every correction goes into the document, never only into a chat.

**The document:** `~/.ai-workforce/items/<item>/design.md`. It is versioned in the `docs` table, kept outside the repo, and never pushed.

| Section | Filled by |
|---|---|
| Problem and goal | understand |
| Acceptance criteria | understand (from the ticket) |
| How the system works today (entry points, flow, file:line) | understand (code note) |
| Approach | plan |
| Alternatives rejected and why | plan |
| Files to create or change, and why | plan |
| Contract (two repos) | contract step |
| Decisions (question → answer → who decided) | ask-desk, your answers, your feedback |
| Tests to add or run | plan |
| Open questions | goldfish checks (emptied before build) |

**Goldfish checks, scaled by size, so cost stays low:**

| Size | Checks | Max rounds | Approx. extra tokens |
|---|---|---|---|
| S | none: the plan review is enough | – | 0 |
| M | **readiness** (comprehension + "can I build this first time? list your questions") | 2 | ~10–20k |
| L / two-repo | readiness + **critic** (wrong assumptions, missed edge cases) | 2 each | ~25–40k |
| Batch / epic / sprint | readiness + critic on the **scope document**; each child ticket then follows its own row | 2 each | ~30–50k per scope |

**Rules:**
1. A goldfish gets only the document and the files it names: no planner conversation, no chat history. It runs at `medium` effort, mostly on cached file reads.
2. A goldfish question goes to the knowledge service (W11):
   - a fact is written into the document with its evidence;
   - a product decision is one question to you (🙋), and the answer is written into the document.
   It is never answered only in the chat.
3. After each change, a **new** goldfish checks again. The check stops when it has no questions left or only nitpicks, or after the round limit. Anything still open is listed in the plan message.
4. Your plan feedback ("approve with a change", reject with a reason) updates the document first, then re-plans from it.
5. `implement_test`, `reviews` and the integration check start from the document plus their own step input. A restart, a takeover by your teammate's plugin, or an audit months later also starts from the document.
6. Contract changes in W6 update the document's contract section and bump its version. Parts that depend on it are re-queued (as today).
7. The Teams plan message is a ≤ 10-line **summary of the document**, with a `details` link. The dashboard drawer shows the current document and its version history.

**Covers:** C1–C11 (understanding before building), D4 (approve with a change), E-group mid-build questions (fewer), K1–K7 (handover between two plugins), H4–H7 (audit reads the document).

### W6. Two repos (lead + parts)

**Today's flow:** `understand → contract → lead_plan → plan_review → plan_gate → run_parts → integration_check → lead_report → request_approval → publish_parts`.

**Changes in the new kernel:**
- Parts are **child items**: `depends_on` edges when the order is sequential, area locks always.
- A `contract_change` from a part is an **event to the lead's mailbox**:
  1. 🟣 the lead decides;
  2. the contract becomes v2;
  3. only the affected parts re-run their build step.
- `publish_parts` writes the **merge order** (producer first) into both PRs.

**Covers:** B16, F7, C2.

### W7. Batch ("do KAN-45, KAN-47 and the templates task")

1. ⚙🔵 `find` each target; store the directives (for example "no approvals") on the batch; ✉ one acknowledgement.
2. 🟢⚙ **Overlap check:** titles, planned areas and contracts give `depends_on` and `same_area` edges.
3. ⚙ Waves:
   - independent items run in parallel (slots ≤ 5, ≤ 2 builds per repo);
   - a dependent item whose parent PR is unmerged is **stacked** on the parent's branch.
4. Each child runs W5.
5. ⚙ **Merge order:** a topological sort of the edges, written to each PR body ("merge 2 of 3, after #140"), to ✉ and to status.

**Covers:** B7, B8, B19, F8, L1, L2.

### W8. Epic / feature / sprint (the `plan_scope` recipe)

1. ⚙ `preview_scope`: count, sizes, repos, overlaps, rough tokens and time. ✉🙋 **always for a sprint or "all my tickets"**, once.
2. ⚙🟢🟣 Understand the whole scope **once**:
   - the epic and its child tickets, the PRD, both Brains;
   - the result is cached and shared down.
3. 🟣 **Scope planner:**
   - map tickets to repos;
   - dependencies and shared **contracts**;
   - waves and merge order;
   - **gaps** (missing stories → proposed Jira tickets, created only after 🙋 or a directive).
4. 🔵 Plan review, then ✉🙋 one approval for the scope (about 15 lines). Child plans are then sent as information unless you asked to see each one.
5. ⚙ Waves of W5 children. 🟣 contract changes are routed to the planner.
6. ⚙ Daily ✉ digest: done / in progress / waiting on you / blocked / **merge next**.
7. 🔵 **Epic check:** acceptance criteria × merged code. ✉ one summary (shipped, follow-ups, cost).

**Tokens:** planner ~30–60k once; children as W5, minus the shared context.
**Covers:** B10–B12, B15, B18, D7, O2.

### W9. CI watch and auto-fix (the `ci_fix` recipe)

**Trigger:** `ci_failed` on a PR the plugin raised or adopted (polled every 60 s while checks run), or "recheck / resolve / fix PR 140".
1. ⚙ Wait until every check has finished.
2. ⚙ Collect the failed step, the command and the first error only (`describeFailure`).
3. ⚙🟢 **Classify** using the CI map from onboarding:
   - **caused by this PR** → fix;
   - **also fails on dev** → leave it, ✉ tell you;
   - **flaky or runner problem** → re-run the job once;
   - **needs a person** (baseline, paid eval, secret, workflow) → ✉ exactly what's needed, never faked.
4. ⚙ Reuse the **code note** (W12 drift check).
5. 🔵 Fix (🟣 only on round 3). Run the same command locally. ⚙ Standards guard.
6. ⚙ Gate: `autoFixCi` on → push without asking (your rule). Off → ✉🙋 preview first.
7. ⚙ Watch the new head; up to 3 rounds.
8. ✉ **One result message:** "CI green, fixed lint in 2 files", or the reason it stopped.

**Tokens:** 10–60k per round. **Covers:** G1–G8.

### W10. Comments, reviews and two developers

**Your PR gets comments** (`comment_added`, `changes_requested`):
- ⚙ ✉ a summary.
- "resolve the comments" (or the `auto_resolve` directive) → `comment_fix`:
  1. 🔵 for each comment: fix / answer / disagree with a reason / other repo / needs a decision;
  2. 🟣🔵 build and test;
  3. ⚙ standards guard;
  4. gate: show first (default) or push;
  5. push, reply on each thread, re-request review;
  6. ✉ the result.
- QA follows if `qaAfterFix` is on.

**A teammate opens a PR** (`teammate_pr_opened`, **every PR**) or **asks you to review** (`review_requested`):
- ⚙ ✉ "Sneha raised PR #140 · KAN-45 – say *review PR 140*".
- `autoReview` → 🔵 review straight away.

**Review:**
1. 🔵 against the ticket and PRD sections;
2. ✉ shown first (or posted if `autoPostReview`);
3. posted as comments only, never approve or reject.

**`new_commits` on a PR you reviewed:**
- ⚙ ✉ "resolved 4 of 4 – re-review?";
- 🔵 the re-review covers only the change.

**Ownership:** only the author's plugin pushes; only reviewers' plugins post reviews.

**Covers:** G9–G12, G16, G19, H1–H3, H8, K1–K7.

### W11. Knowledge service (ask-desk) – used by every agent

**Trigger:** a `ask(question)` tool call during a step, or questions in a step result.
1. ⚙ **Decision log:** the same question in the same or a parent scope.
2. ⚙ Cached context: ticket, PRD, Figma notes.
3. ⚙ Brain: rules card, handbook, code map.
4. 🔵 Knowledge agent: code search and live lookups, ≤ 6 turns.

**The answer** is `{answer, confidence, evidence, kind}`:

| Confidence / kind | What happens |
|---|---|
| High, a fact | used and logged |
| Medium | used, and listed as an **assumption** in the plan and PR |
| Low, or a product decision | ✉🙋 all of the item's questions together (or assumed, if the `no_questions` directive is set) |

**Covers:** C2–C5, O4.

### W12. Context broker – Figma again, code again, any lookup

**Trigger:** a tool call during a step: `figma(frame, need)`, `code.search / read / map`, `ticket()`, `prd(query)`, `contract()`, `history()`.
1. ⚙ Check policy and budget.
2. ⚙ Look in the cache. The key is the source plus its version:
   - Figma: file version;
   - Jira: `updated`;
   - PRD: content hash;
   - code: SHA + file hash.
3. On a miss:
   - ⚙ fetch **only the part needed** (one Figma node, one section, line ranges);
   - 🟢 distil it if it's large;
   - ⚙ store it.
4. Return 1–3k tokens with the source, in the same turn.

**Figma again:**
- **Exact values are never condensed.** Sizes, spacing, colours, typography, design tokens (variables) and component states come from Figma's variables and styles **as-is**. Only long descriptive text is condensed by 🟢.
- `figma(frame, need: "visual")` also returns the **frame image** (rendered once per file version and cached), for UI matching and the design check.
- The design document keeps **frame pointers** (name → node ID) so a later agent asks for exactly that frame.
- A design change while building is caught by the Figma watch (W13).

**Code again:** the item code note is checked with a ⚙ git diff:
- unchanged → reuse (0 tokens);
- some files changed → 🔵 re-read only those;
- more than 30 % changed → 🟣 full re-understand.

**Covers:** the "Inside a job" cases, C6, E-steps.

### W13. Keeping the PR healthy

| Event | Response |
|---|---|
| `pr_conflict` (not mergeable) | ⚙ `rebase` recipe: rebase onto dev the team's way; 🔵 resolve simple conflicts; on a real conflict ✉ stop and tell you. Never force-push: a merge commit if the team merges dev in. |
| `new_commits` by someone else on your branch | ⚙ rebase local work on top; never overwrite |
| `ticket_changed` | 🟢 summarise the change. Before building → 🔵 delta re-plan; after building → ✉ "adapt?" (or adapt under "no approvals") |
| `pr_approved` | ✉ "ready to merge", with the merge order |
| `design_changed` (⚙ Figma watch: the file version of a frame used by an active item changed; checked with the Jira poll, 1 cheap call per file) | ⚙ diff the frame's exact values. Before building → update the design document, then 🔵 delta re-plan. While building → a note to the implementer + design document updated. After the plan was approved or the PR raised → ✉ "Design of 'Chat / Reply chips' changed: padding 12→16, new hover state. Adapt?" (adapted directly under "no approvals") |

**Covers:** G13, G14, G16, C7, I2, E8, and a design changed during the work.

### W14. Close-out

| Event | Response |
|---|---|
| `pr_merged` | ⚙ close the item; unblock dependents; **rebase and re-target stacked PRs to dev**; tell you the next PR in the merge order; 🟢 learning (repeated review comments become rules-card lines; decisions go to the Brain); clean the worktree; Jira status/comment if allowed |
| Merged out of order | ✉ a warning; rebase or re-target the rest |
| `pr_closed` (not merged) | ✉ "drop or reopen?" |

**Covers:** G17, G18, O1–O3.

### W15. Review old work (the `audit` recipe)

**Trigger:** "review KAN-12" for a merged ticket, "check the onboarding epic is complete", or "review branch X".
1. ⚙ Find the PRs and commits:
   - Jira development links;
   - GitHub PR search by key;
   - `git log --all --grep`.
2. ⚙ Take the merged range, plus any **later commits to the same files**.
3. 🔵 Auditor: each criterion × the merged diff × today's code → met / partial / missing / regressed.
4. ✉ A short verdict (details on request). 🙋 offer a follow-up ticket or issues. Never comment on a closed PR unless asked.

Branch review (no PR): diff against its base, then the W10 review.

**Covers:** H4–H7.

### W16. Finish my branch (the `adopt` recipe), take over, hand back, undo

**Adopt:**
1. ⚙ Fetch the branch and create a worktree on it. Your commits are never rewritten.
2. 🔵 Gap analysis: ticket and criteria vs your diff.
3. 🔵 Plan the rest only; ✉ the plan (approval per your preferences).
4. W5 steps 9–15 on top of your commits.
5. If you push meanwhile → ⚙ rebase local work first. On a conflict, stop and tell you.

**Takeover ("stop, I'll do it"):** stop; leave the worktree and branch ready; ✉ a summary of where things stand.

**Handback ("continue KAN-45"):** read your new commits, then resume.

**Undo:** only when it's safe:
- cancel a just-started item;
- delete an unpushed branch;
- revert a directive.

Pushed history is never rewritten.

**Covers:** I1–I6, J5, J14.

### W17. Daily and scheduled

| Trigger | What runs |
|---|---|
| ⚙ Morning digest | ≤ 10 lines: done / in progress / waiting on you / blocked / merge next / connector state |
| ⚙ Approvals | expire after 72 h → ✉ refresh |
| ⚙ Quiet hours | hold non-urgent messages; one catch-up message after |
| ⚙ Budgets | 80 % warning; stop only if you chose budget stops |
| ⚙ Worktrees | cleanup |

**Covers:** J10, L5–L7.

### W18. Other roles (existing playbooks become recipes, unchanged inside)

- QA test plan (N1)
- BA stories (N2)
- Design review (N3)
- PM digest (N4)
- DevOps CI failure on a branch (N5)

### W19. Local dashboard (live view of agents, tickets, jobs and connections)

**Purpose:** you can see at any moment, without asking in Teams:
- what each agent is doing;
- where every ticket is;
- what waits for you;
- what runs in the background;
- whether every tool is connected.

**Approved look:** `AIW-Dashboard-Design.html`.

**Opened with:** `aiw dashboard`. The address is `127.0.0.1` only, with a session token.

**How it stays live (all ⚙, no AI, no cost):**

1. **Producers.** Every change that matters already goes through one place. It calls `live.publish(kind, payload)`:

   | Source | Live event |
   |---|---|
   | kernel runner: job start, step start, step end, job end | `job` |
   | agent runner: each tool call (`Bash`, `Read`, `Edit`, lookups) | `activity` (throttled to one every 2 s per job) |
   | item state changes (`engine/tasks.ts` transitions) | `item` |
   | approvals, questions, answers (policy gate, `askUser`, `answerTask`) | `needs` |
   | health loop | `connector` |
   | scheduler: slot taken or freed, queue order, area lock | `slots` |
   | background timers: poll start and end, next run | `timer` |
   | messenger: every Teams message sent or received | `feed` |

2. **Plain-English activity line (⚙).** `live/activity.ts` turns a tool call into a sentence with fixed rules. No model call is made. For example:
   - `Bash npm test` → "Running npm test";
   - `Read auth/middleware.py` → "Reading auth/middleware.py";
   - the test runner's output gives "41 of 58 passed";
   - a broker fetch of a Figma node → "Reading Figma frame 'Chat / Reply chips'".

   **Progress** = finished steps ÷ steps in the recipe for this job. Test progress replaces it while tests run.

3. **Stream.** `GET /api/stream` (Server-Sent Events, plain Node, no library):
   - it sends a full snapshot on connect, then small deltas;
   - a 20 s heartbeat keeps it open;
   - the browser reconnects by itself and receives a fresh snapshot.
   - **Stored, so it survives a restart:** the last activity line and progress are written to `jobs` at most every 5 s. The feed reads `notifications` and `chat_log`.

4. **Page** (served from `service/web/`; plain JS, no build step, fonts shipped inside the plugin, works offline). Sections, in this order:

   | Section | Shows | Read from |
   |---|---|---|
   | Top line | service running/paused and uptime, version, "needs you" count, agents busy of slots, tickets in progress / waiting, connections | `/api/status` + stream |
   | **Needs you** | questions (options; the recommended one highlighted), "start?" for L tasks, plan / PR / QA approvals | approvals, open questions |
   | **Working now** | one card per running job: agent, model tier, ticket + repo, activity line, progress bar, minutes, tokens | `jobs` + `steps` + stream |
   | **Ticket progress** | board: Waiting → Understand & plan → Building → Reviewing → PR open → Done. One bar per repo for two-repo tickets; colour edge = state; sprint bar with waves | `tasks` (items) + `edges` |
   | Ticket drawer (click) | "Now: …", stage bar, timeline (what happened, which agent, when), questions asked and answered, tokens, cost, PR links, merge order; Pause / Open in Jira / Open PR | item + `steps` + `decisions` + `notifications` |
   | Activity | live feed in plain English, newest first; answers the knowledge agent gave without asking you are marked | `notifications`, `chat_log`, `events` |
   | Agents | busy agents, idle agents with what they do, the queue and why each waits (needs your start / area lock / repo limit) | scheduler state |
   | Background | every timer: what it checks, how often, last run, next run, healthy / running / failed | timers + `connector_health` |
   | Connections | Jira, GitHub, Figma, Teams, model access, Notion: state, account, last check; Reconnect / Renew button opens the existing connect flow | `connector_health`, `/connect/*` |
   | Cost (Phase 8) | tokens and $ by day, ticket and agent; cache-hit rate | `/api/cost` |

5. **Actions** (all go through the same code as Teams; the policy gate and hard rails still apply):
   - answer a question;
   - start or put off a task;
   - approve or reject;
   - pause or resume new work, or a single ticket;
   - reconnect a tool.

   Every action is echoed in the activity feed and in Teams, with the channel `dashboard`.

**Words, not codes:**
- states are shown as plain labels (`AWAITING_APPROVAL` → "Waiting for you", `PR_OPEN` → "PR open");
- one colour per meaning: amber = needs you, blue = working, green = done or healthy, red = failed, grey = waiting;
- light and dark theme; works at phone width;
- a "How to use" tour is built in.

**Covers:** your dashboard request (agents, waiting tasks, ticket progress, background tasks, connections), L5 (visibility at scale) and J-group status questions that can be answered by looking.

---

## 4. Data model changes (migrations 4–6)

The `tasks` table is **extended, not replaced**, so running work and all existing code keep working.

```sql
-- migration 4: work items, edges, jobs (Phase 1)
ALTER TABLE tasks ADD COLUMN level TEXT NOT NULL DEFAULT 'ticket';   -- sprint|epic|batch|ticket|part|request|pr|branch|audit
ALTER TABLE tasks ADD COLUMN parent_id TEXT;                          -- replaces data.leadId
ALTER TABLE tasks ADD COLUMN root_id TEXT;
ALTER TABLE tasks ADD COLUMN areas TEXT;                              -- JSON path globs it will change (area locks)
ALTER TABLE tasks ADD COLUMN owner TEXT NOT NULL DEFAULT 'me';        -- me | teammate login (reviews of others' PRs)
CREATE INDEX tasks_parent ON tasks(parent_id);
CREATE TABLE edges (from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL,   -- depends_on|stacks_on|same_area|duplicates
  created_at TEXT NOT NULL, PRIMARY KEY (from_id, to_id, type));
CREATE TABLE jobs (id TEXT PRIMARY KEY, item_id TEXT NOT NULL, type TEXT NOT NULL,     -- build|ci_fix|comment_fix|review|qa|audit|adopt|rebase|replan|close|plan_scope
  recipe TEXT NOT NULL, state TEXT NOT NULL, step_index INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  trigger_event TEXT, data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX jobs_item ON jobs(item_id, state);
ALTER TABLE events ADD COLUMN item_id TEXT;
ALTER TABLE events ADD COLUMN handled_by TEXT;                        -- job id
ALTER TABLE steps ADD COLUMN job_id TEXT;
ALTER TABLE steps ADD COLUMN input_hash TEXT;
ALTER TABLE steps ADD COLUMN cache_read INTEGER DEFAULT 0;            -- tokens read from prompt cache

-- migration 5: knowledge, policy, caches, health (Phases 2, 3, 5)
CREATE TABLE docs (item_id TEXT NOT NULL, version INTEGER NOT NULL, path TEXT NOT NULL, sha TEXT NOT NULL,   -- design.md versions (W5a)
  reason TEXT, open_questions INTEGER NOT NULL DEFAULT 0, readiness TEXT, created_at TEXT NOT NULL, PRIMARY KEY (item_id, version));
CREATE TABLE decisions (id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, question_key TEXT NOT NULL, question TEXT NOT NULL,
  answer TEXT NOT NULL, source TEXT NOT NULL, confidence TEXT, evidence TEXT, created_at TEXT NOT NULL);
CREATE INDEX decisions_key ON decisions(question_key);
CREATE TABLE directives (id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, rule TEXT NOT NULL, value TEXT,
  from_msg INTEGER, active INTEGER NOT NULL DEFAULT 1, until_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE contracts (root_id TEXT NOT NULL, version INTEGER NOT NULL, items TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (root_id, version));
CREATE TABLE context_cache (key TEXT PRIMARY KEY, source TEXT NOT NULL, version TEXT NOT NULL, text TEXT NOT NULL,
  tokens INTEGER, created_at TEXT NOT NULL, last_used TEXT NOT NULL);
CREATE TABLE agent_cache (key TEXT PRIMARY KEY, agent TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE connector_health (provider TEXT PRIMARY KEY, state TEXT NOT NULL, since TEXT NOT NULL, last_ok TEXT, last_alert TEXT, detail TEXT);

-- migration 6: messenger (Phase 2)
ALTER TABLE notifications ADD COLUMN item_id TEXT;
ALTER TABLE notifications ADD COLUMN merge_key TEXT;                  -- routine notices merged within 60 s
ALTER TABLE notifications ADD COLUMN details_ref TEXT;                -- "details KAN-45"
ALTER TABLE jobs ADD COLUMN agent TEXT;                               -- dashboard: agent now running this job
ALTER TABLE jobs ADD COLUMN activity TEXT;                            -- dashboard: last plain-English activity line
ALTER TABLE jobs ADD COLUMN progress INTEGER;                         -- dashboard: 0–100
ALTER TABLE jobs ADD COLUMN activity_at TEXT;
ALTER TABLE chat_log ADD COLUMN msg_id TEXT;                          -- Teams message ID (W1a quoted replies)
ALTER TABLE chat_log ADD COLUMN reply_to TEXT;                        -- quoted message ID on incoming messages
ALTER TABLE chat_log ADD COLUMN item_id TEXT;
ALTER TABLE chat_log ADD COLUMN question_key TEXT;
CREATE INDEX chat_log_msg ON chat_log(msg_id);
CREATE TABLE inputs (id TEXT PRIMARY KEY, item_id TEXT, msg_id TEXT, kind TEXT NOT NULL,   -- image|document|other (W1a)
  name TEXT, path TEXT NOT NULL, sha TEXT NOT NULL, summary TEXT, created_at TEXT NOT NULL);
CREATE TABLE env_checks (repo TEXT PRIMARY KEY, ok INTEGER NOT NULL, report TEXT NOT NULL, checked_at TEXT NOT NULL);   -- environment doctor
CREATE TABLE benchmarks (run_id TEXT NOT NULL, ticket TEXT NOT NULL, version TEXT NOT NULL, fresh_in INTEGER, cache_read INTEGER,   -- Phase 0.5
  tokens_out INTEGER, cost_usd REAL, questions INTEGER, review_rounds INTEGER, ci_first_green INTEGER, pr_accepted_unchanged INTEGER,
  created_at TEXT NOT NULL, PRIMARY KEY (run_id, ticket));
CREATE TABLE timers (name TEXT PRIMARY KEY, every TEXT NOT NULL, last_run TEXT, last_ok INTEGER, next_run TEXT, detail TEXT);  -- Background view
```

**States:** today's 14 states are kept. Added: `PR_OPEN`, `BLOCKED`, `MERGED`, `CLOSED`, plus `PLANNING` and `WAITING_CHILDREN` for containers. `engine/tasks.ts` gains the legal transitions, and today's `DONE after publish` becomes `PR_OPEN`.

**Data migration** (runs once at service start):
- `data.leadId` → `parent_id`;
- open `FIX-n`, `QA-n` and `REVIEW-n` tasks → `jobs` on the matching ticket item (or on a light `pr` item when there is no ticket);
- `meta fix.ciwatch` → `jobs` of type `ci_watch`.

---

## 5. Module plan

New folder `service/src/kernel/` plus targeted changes. Existing files keep their names.

| # | Module (new / changed) | Responsibility | Built from |
|---|---|---|---|
| 5.1 | `kernel/items.ts` (new) | create/get/tree/levels, edges, area claims, merge order (topological sort) | `engine/tasks.ts`, `routing.ts` |
| 5.2 | `kernel/events.ts` (new) | `emit(type, key, item, payload)` with dedupe; `pending()`; `markHandled()` | `events` table, `intake.ts` inserts |
| 5.3 | `kernel/reactions.ts` (new) | **the event → job table** (§3 W3, W9–W14) – data, not code paths | `prActivity.ts`, `pollCiWatches` logic |
| 5.4 | `kernel/mailbox.ts` (new) | one active job per item; queue/merge new events; priority | – |
| 5.5 | `kernel/scheduler.ts` (new) | waves by edges, slots (default 5), 2 builds per repo, area locks, priority, budgets, BLOCKED by connector | `engine.ts` limits |
| 5.6 | `kernel/recipes.ts` + `recipes/*.yaml` (new) | recipes = step lists with branches (`goto`, `spawn_children`, `skip_to`); loads today's playbooks as recipes | `engine/playbooks.ts` |
| 5.7 | `kernel/runner.ts` (new) | run a job's next step, checkpoint before effectors, apply `StepResult`, resume only the in-flight step | `engine.ts runTask` |
| 5.8 | `agents/runner.ts` (changed) | `agent_cache` (prompt hash → result) on resume; record `cache_read` tokens; session resume for retries; stable-prefix ordering; per-step `effort`, `taskBudget`, `fallbackModel`, `settingSources: []`, a stable system prompt, sorted tools (§9.1) | today's runner |
| 5.8a | `agents/tools/` (new MCP tools) | `run_tests`, `run_lint`, `ci_log`, `git_diff_stat`: compact results (failures, counts, first error) instead of raw output (§9.1.2) | `engine/localStack.ts`, `testProfile.ts`, `brain/ciPipeline.ts` |
| 5.8b | `agents/batch.ts` (new) | queue non-urgent single calls into the Message Batches API, poll, store results; a fallback to normal calls if a batch has not ended in time (§9.1.6) | `@anthropic-ai/sdk` |
| 5.9 | `engine/localStack.ts` (changed) | `.env` database allowed for tests per repo setting; wipe-fixture scan used by the ready check | today's `testEnvironment` |
| 5.10 | `policy/gate.ts` + `policy/directives.ts` (new) | `effective(item, rule)` precedence; gates; hard rails; directive store and echo | `approvals.ts`, settings |
| 5.11 | `knowledge/broker.ts` (new) | broker tools for agents (`figma`, `code.*`, `ticket`, `prd`, `contract`, `history`, `ask`), cache by source version, distil | `agents/lookup.ts`, `brain/*` |
| 5.12 | `knowledge/askDesk.ts` + `decisions.ts` (new) | the ladder; decision log scopes; confidence routing | `chat/assistant.ts` lookups |
| 5.12a | `knowledge/designDoc.ts` (new) | create and update `design.md` by section, version it in `docs`, render the ≤ 10-line plan summary, give each agent only the sections it needs (W5a) | `steps.ts` `planMessage`, the contract step |
| 5.12b | `knowledge/goldfish.ts` + agents `goldfish-readiness`, `goldfish-critic` (new) | run a check on a fresh session from the document only; questions → ask-desk → answers written into the document; round limit and size table | `agents/runner.ts`, `askDesk.ts` |
| 5.13 | `knowledge/codeNote.ts` (new) | per-item code note, SHA/file-hash stamps, drift check, delta re-read | `steps.ts understand` |
| 5.14 | `conductor/conductor.ts` + `conductor/tools.ts` (new) | Conductor agent, working set, history summary, tools → kernel calls | `teamsIntent.ts`, `assistant.ts` |
| 5.15 | `conductor/find.ts` (new) | resolve keys, links, names (ticket index), epics, sprints (Jira agile), PRs, branches, history | `ticketIndex.ts`, `targets.ts` |
| 5.16 | `intake/teamsIntent.ts` (changed) | keep only the **fast path** rules; everything else → Conductor | today's rules |
| 5.17 | `messenger/messenger.ts` + `templates.ts` (new) | short templates, 60 s merging, focus, `details`, digest, quiet hours | `notify/router.ts`, `channels.ts`, `checkup.ts` |
| 5.18 | `intake/health.ts` (new) | connector health loop + events | `connectors/registry.ts markConnection` |
| 5.19 | `intake/github.ts` (new, splits `prActivity.ts`) | producers: ci, comments, reviews, review requests, **every teammate PR**, new commits, conflicts, merged/closed – ETag/304 | `prActivity.ts`, `github.ts` |
| 5.20 | `engine/steps.ts` (changed) | new steps: `standards`, `merge_order`, `audit_*`, `adopt_*`, `rebase`, `close_out`, `scope_*`, `preview_scope`, `epic_check`; `publish` → `PR_OPEN` | today's steps |
| 5.21 | `connectors/github.ts` (changed) | `rerunJob`, `mergeable`, `searchByKey` (PRs + commits), `retargetPr`, ETag cache | today's client |
| 5.22 | `connectors/jira.ts` (changed) | epic children, sprint issues (agile API), development links, create issue (after OK) | today's client |
| 5.23 | `api/ops.ts`, `mcp/tools.ts`, `cli/main.ts` (changed) | status by tree, `aiw explain`, `aiw items`, directives, kernel switch | today's ops |
| 5.16a | `intake/teamsMessage.ts` (new) + `connectors/teamsPersonal.ts` (changed) | full message model: text, `replyTo`, attachments; image-only and file-only messages kept; quoted bot message → item + question; message IDs stored on send (W1a) | vendored `parseReply`, `attachmentsOf`, `readCapped`, `fileToText` |
| 5.16b | `knowledge/inputs.ts` (new) | download with size cap and type allow-list, store under the item, 🟢 image description cached by hash, document text through the broker, add to the design document (W1a) | `core/files.js`, broker |
| 5.18a | `engine/envDoctor.ts` (new) | environment doctor (W2 12a): versions, dependencies, `.env` keys by name, DB, services, smoke test; Blocked: environment and auto-resume | `engine/ready.ts`, `localStack.ts`, `testProfile.ts` |
| 5.10a | `policy/untrusted.ts` (new) | wrap outside text as marked data in prompts; strip hidden instructions from HTML and comments; the rule that only owner channels give orders; a test set of injection samples (§11a) | `policy/gate.ts` |
| 5.11a | `knowledge/figma.ts` (new, used by the broker) | exact values from variables and styles (never condensed), frame image render cache, frame pointers, the Figma version watch → `design_changed` events, the design check input | `connectors/figmaDesktop.ts`, `agents/lookup.ts` |
| 5.30 | `bench/benchmark.ts` + `aiw bench` (new) | Phase 0.5: re-run chosen past tickets on throwaway branches (never pushed), record cost and accuracy in `benchmarks`, compare runs and versions | runner, `steps` table |
| 5.24 | `live/bus.ts` (new) | in-process publish/subscribe for live events; throttling; the last snapshot kept in memory; writes `jobs.activity/progress` at most every 5 s | – |
| 5.25 | `live/activity.ts` (new) | tool call → plain-English line; test-output parsers (pytest, jest/vitest, npm) for "41 of 58 passed"; progress from the recipe step count | `agents/runner.ts` message stream |
| 5.26 | `api/stream.ts` + `api/dashboardData.ts` (new) | `GET /api/stream` (SSE: snapshot + deltas, heartbeat, max 5 clients); `GET /api/overview`, `/api/items/:id/timeline`, `/api/agents`, `/api/timers`, `/api/connections` | `api/ops.ts` (`statusSnapshot`, `taskDetail`, `inboxView`) |
| 5.27 | `service/web/` (new) + `api/dashboard.ts` (changed) | the approved page (`index.html`, `app.js`, `app.css`, fonts) served as static files; `dashboard.ts` keeps the token check and the connect forms; CSP stays `'self'` | `AIW-Dashboard-Design.html` |
| 5.28 | `core/timers.ts` (new) | one registry for every background timer (Jira, Teams, PR watcher, CI watch, health, ticket index, Brain refresh, digest): last run, next run, result → `timers` table | today's `setInterval`s in `daemon` / `intake` |

---

## 6. Phases

Estimates are working days for one developer working with Claude Code, including tests. Each phase ends with an install, a check on your repos, and a short report.

### Phase 0 – Finish onboarding 0.7.0 (≈ 2 days)

- [ ] Initial **local git commit** of `D:\ai-workforce` (nothing pushed).
- [ ] Unit tests for the 0.7.0 parts:
  - docstring and test-layout detection;
  - `classifyFile`;
  - CI workflow parsing and `jobForCheck`;
  - CODEOWNERS matching and `reviewersFor`;
  - `findTickets`;
  - the rules card;
  - preferences (`aiw prefs`);
  - the **auto CI-fix path** (no preview).
- [ ] Update `skills/aiw-onboarding/SKILL.md`: the Team, Preferences and Ready steps; Figma token first.
- [ ] Update the README.
- [ ] One-off prompt audit of all agent prompts and tool descriptions (§9.1.10). Changes are shown to you before they are kept.
- [ ] Bump to 0.7.0; marketplace update; restart the service.
- [ ] Run `aiw brain onboard`, `aiw ready` and `aiw team detect` on nue-backend and nue-frontend, and show you the results.

**Done when:** all tests pass and the ready report on your two repos is shown to you.

### Phase 0.5 – Measure first (≈ 2 days)

**Why:** your recorded runs show today's real cost is far above the plan's targets. All of it is in `aiw.db`:

| Ticket | Input tokens | Cost |
|---|---|---|
| KAN-40 (two repos) | ≈ 25 M | ≈ $20 |
| KAN-52 | ≈ 8 M | ≈ $8 |
| FIX-131 | ≈ 4–8 M | ≈ $4–8 |

By step:
- `implement_test` ≈ 1.8 M per run;
- `understand` ≈ 1.25 M per run;
- `report` (PR text) ≈ 0.5 M per run.

Without a baseline we can't prove any saving.

- [ ] Split recorded tokens into **fresh input / cache write / cache read / output** per step (runner change; today `tokens_in` mixes them).
- [ ] Baseline report by step and agent from the existing `steps` rows: the top 10 costly steps and why (turns, tool calls, file reads).
- [ ] `aiw bench` (5.30): re-run 8–10 past tickets (e.g. KAN-40, KAN-52, FIX-131, plus small S tickets):
  - on throwaway local branches, never pushed, no Teams or Jira writes;
  - record **cost** (fresh, cache read, output, $) and **accuracy**: questions asked, review rounds, CI-style checks green first time, and "would the PR be accepted unchanged" (you mark it once per ticket; a 🔵 judge compares later runs against your mark).
- [ ] **Quick wins** that need no kernel, applied and re-measured:
  - the reporter, reviewers and integration check get the diff, plan and design text directly, with few or no tools;
  - `maxTurns` per step from the baseline;
  - compact test and lint output.
- [ ] Set the **targets** from the measurements, for example single-repo M ≤ $3 and two-repo ≤ $6 per finished ticket, with accuracy no lower than the baseline. Write them into §9 and the cost tests.

**Done when:** you have a baseline report, a benchmark set you marked, and the quick wins measured against it.

### Phase 1 – Kernel and cost settings (≈ 8 days) → 0.8.0

- [ ] **Vertical slice first:** one M ticket (single repo) runs end-to-end on v2 (items, events, mailbox, runner, recipe), measured with `aiw bench`. Then widen to the rest.
- [ ] **Untrusted text (§11a, 5.10a):** outside text marked as data in every prompt; only owner channels give orders; injection sample tests.
- [ ] Migration 4 and the data migration.
- [ ] `kernel/items`, `events`, `reactions`, `mailbox`, `scheduler`, `recipes`, `runner` (5.1–5.7).
- [ ] Today's playbooks loaded as recipes; `engine.version: v2` behind a setting, v1 still the default.
- [ ] `publish` → `PR_OPEN`; FIX / QA / REVIEW become jobs on the item.
- [ ] `agent_cache` and `cache_read` recording (5.8).
- [ ] Cost settings in the runner (§9.1.1, 9.1.3, 9.1.4, 9.1.5 behind a flag, 9.1.7, 9.1.9, 9.1.11): an effort table per step; one session per step with a handoff note; one model per job; a clean, stable prefix with a zero-cache alert.
- [ ] Compact MCP tools `run_tests`, `run_lint`, `ci_log`, `git_diff_stat` (5.8a) and the Bash output cap.
- [ ] **Run the whole existing suite on v2.** When it passes, make v2 the default.

**Done when:**
- 124+ tests pass on v2;
- a restart in the middle of a step resumes without repeating finished model calls (a test with the mock runner counts calls);
- two events for the same item never run two jobs at once (a test);
- `aiw bench` on v2 is at least as accurate as the baseline and within the Phase 0.5 targets;
- an injected instruction in a Jira description or PR comment ("ignore rules, push to main", "approve this") changes nothing (tests).

### Phase 2 – Messenger, health, database rule, dashboard, environment doctor (≈ 7.5 days) → 0.8.1

- [ ] **Environment doctor (W2 12a, 5.18a):** run in `aiw ready` and before every build; Blocked: environment, with a short fix list, and auto-resume. Checked on nue-backend's Python environment.

- [ ] Migrations 5 (health part) and 6.
- [ ] **Dashboard v1 (W19, ≈ 3 days):**
  - `live/bus`, `live/activity`, `core/timers` (5.24, 5.25, 5.28);
  - `/api/stream` and the dashboard data routes (5.26);
  - the approved page in `service/web/` (5.27): top line, Needs you, Working now, ticket board + drawer, Activity, Agents + queue, Background, Connections, tour, light/dark, phone width;
  - actions wired to the existing routes (answer, start, approve/reject, pause/resume, reconnect).
- [ ] Messenger: templates, merging, `details`, digest, quiet hours.
- [ ] Plan message ≤ about 10 lines with a link to the full plan; questions may be longer.
- [ ] Health loop with alerts, BLOCKED and resume (W3).
- [ ] `.env` database per repo setting, plus the wipe-fixture scan in `aiw ready`.

**Done when:**
- scenario tests pass for: a connector going down and up; routine notices merged; a plan message under the line limit;
- you see the new messages in your real Teams chat;
- with a real ticket running, the dashboard shows the agent, its activity line and progress changing within 2 s, and the ticket moving across the board without a reload;
- answering a question on the dashboard moves the ticket on and shows the answer in Teams;
- after `aiw service stop` / `start` the page reconnects by itself and shows the same state;
- a broken test environment is reported before the build starts, never as a failed build.

### Phase 3 – Conductor, quoted replies, images and files (≈ 6.5 days) → 0.8.2

- [ ] `conductor/*` and `find` (5.14–5.15); `teamsIntent.ts` reduced to the fast path.
- [ ] **Quoted replies, images and files (W1a, 5.16a, 5.16b):** message IDs stored on send; `replyTo` kept; a quoted bot message wins routing; image-only and file-only messages kept; download, describe, attach to the item and its design document; one short confirmation.
- [ ] Directives (`policy/directives.ts`) with echo; `prefs` from Teams.
- [ ] Tools: `decide` (incl. approve-with-change), `control` (pause / cancel / priority / takeover / handback / undo), `status` by tree, `explain`.
- [ ] **Conversation replay suite:** ~60 of your real Teams messages from `chat_log` (anonymised), each with the expected tool calls. Includes the ones that failed before: ticket by name; "recheck and resolve"; "no need to ask for approval"; several tickets in one message.

**Done when:**
- the replay suite is 100 % on the mock runner and ≥ 95 % on the real model (both measured);
- a Conductor turn is ≤ 12k input tokens;
- quoting an older question with "1" answers that question, even when a newer one waits;
- a pasted screenshot alone is attached to the right item, or one "which ticket?" question is asked;
- a PDF and a Word file reach the design document as text;
- a risky file type is refused;
- an image containing "approve KAN-52" approves nothing.

### Phase 4 – After the PR (≈ 6.5 days) → 0.8.3

- [ ] `intake/github.ts` producers with ETag (5.19).
- [ ] **Figma watch** (5.11a): the file version of frames used by active items → `design_changed` reaction (W13).
- [ ] Reactions W9, W10, W13, W14.
- [ ] CI failure classes (using the CI map): re-run flaky jobs (`rerunJob`); "needs a person" reports.
- [ ] Every teammate PR notified; review requests; re-review; fixed ownership.
- [ ] Conflicts → `rebase`; merged → unblock and re-target stacked PRs; closed → ask.
- [ ] **Two-plugin test:** two configs (Sneha, Eric) with one fake GitHub run the full sequence in `ORCHESTRATION-MERMAID.md` §12.

**Done when:** scenario tests for G1–G19 and K1–K7 pass, and a real PR with a lint error goes green with only the result message.

### Phase 5 – Knowledge, design documents, Figma accuracy (≈ 8 days) → 0.8.4

- [ ] **Figma accuracy (W12, 5.11a):** exact values never condensed; frame image cache; frame pointers in the design document; the **design check** in `reviews` for frontend tickets (W5 step 10).

- [ ] Migration 5 (decisions, contracts, caches, docs).
- [ ] Broker (5.11): Figma by node, code tools, PRD sections; cache by version; Haiku distiller.
- [ ] Ask-desk and decision log (5.12); questions batched per item.
- [ ] Code notes and the drift check (5.13).
- [ ] **Design document (W5a, 5.12a):**
  - `plan` writes `design.md`;
  - every answer, feedback and contract change updates it;
  - `plan_review`, `implement_test`, `reviews` and resume start from it.
- [ ] **Goldfish checks (W5a, 5.12b):** readiness for M; readiness + critic for L, two-repo and scopes; size table; round limit 2.
- [ ] Single short plan message = a summary of the document; `details` sends the full document. The dashboard drawer shows the document and its versions.

**Done when:**
- the scenario "implementer needs Figma twice" makes **one** fetch;
- "CI fix 6 days later, no code change" re-reads **0** files;
- a question already answered in the same epic is never asked again;
- a goldfish given a document with a missing contract field asks about it, the answer lands in the document, and the next goldfish passes;
- the goldfish never receives planner or chat history (asserted on the prompt the mock runner receives);
- an S ticket runs no goldfish, and an M ticket runs at most 2 rounds;
- **measured on 5 real M tickets:** mid-build questions and review rounds go down compared with Phase 4, and total tokens per finished ticket do not go up. If they do, the size table is tightened;
- the implementer gets the exact padding and colour values of a frame (no rounding or paraphrase);
- the design check finds a deliberately wrong spacing in a test screen.

### Phase 6 – Batches, epics, sprints (≈ 7 days) → 0.9.0

- [ ] `preview_scope`, the scope planner, plan review and one scope approval (W8).
- [ ] Overlap check; waves; area locks; stacking; merge order in PRs, Teams and status; out-of-order warning (W7).
- [ ] Contract changes routed to the planner; contract versions.
- [ ] Epic check and summary; daily digest by scope.
- [ ] Jira epic children and sprint issues (5.22); proposed missing stories created only after an OK.
- [ ] **Dashboard v2 (≈ 1 day):** sprint / epic / batch tree with waves, dependency arrows in the drawer, merge order, stacked PRs; filter by sprint, epic or repo.

**Done when:** a 4-ticket batch with one dependency produces correct waves, a stacked PR and the merge order; a sprint preview is shown once even under "no approvals"; the epic check finds a missing criterion.

### Phase 7 – Old work, branches, takeover (≈ 4 days) → 0.9.1

- [ ] `audit` recipe (W15) with PR and commit discovery and later-change detection.
- [ ] Branch review.
- [ ] `adopt` recipe (W16).
- [ ] Takeover, handback, undo rules.

**Done when:** "review KAN-12" on a merged fake ticket gives the right verdict, and "finish my branch" builds on top of the user's commits without rewriting them.

### Phase 8 – Learning, dashboards, batch savings (≈ 3 days) → 1.0.0

- [ ] Close-out learning: repeated review comments → rules-card lines (shown to you before they're added).
- [ ] Batch API for non-urgent calls (5.8b, §9.1.6); `taskBudget` on by default if the measurements are good; test the advisor pattern on 5 real tickets and keep it only if the review pass rate holds.
- [ ] Move more calls to Haiku (§9.1.8) only where the replay or eval accuracy is unchanged.
- [ ] Cost, cache-hit and speed views in `aiw cost` and the dashboard (**Cost** section of W19: by day, ticket and agent).
- [ ] Docs: README, ARCHITECTURE.md rewritten for 1.0, onboarding guide.

**Total: ≈ 55 working days (≈ 435 hours)**: 39 + 4 dashboard + 2 cost techniques (§9.1) + 2 design documents and goldfish + 2 measure first (0.5) + 1 security + 1.5 environment doctor + 1.5 quoted replies, images and files + 1 Figma accuracy. The order can change after Phase 1, which every later phase depends on.

---

## 7. Dynamic behaviour – how each requirement is met

| Your requirement | Where it is built |
|---|---|
| Understand Teams like Claude, tickets by name | Phase 3 – Conductor + `find` + ticket index (0.7.0) |
| Any scope: one / many / sprint / epic / old ticket / branch | Phase 1 levels, Phase 6 scopes, Phase 7 audit + adopt |
| Not a one-way pipeline; recheck any time | Phase 1 kernel + Phase 4 events; items live until merged |
| CI fixed without asking | 0.7.0 gate + Phase 4 classes |
| "No need for approval" respected | Phase 3 directives + gate |
| Knowledge agent before asking | Phase 5 |
| One short plan message; short messages | Phase 2 messenger, Phase 5 plan message |
| Teammate told of every PR; comments to both; resolve; QA → issues | Phase 4 |
| Merge order always given | Phase 6 (Phase 1 builds the edges) |
| Screenshots in frontend PRs | 0.7.0 ready check + warning in the approval message; Phase 4 rechecks |
| Docstrings / standards / no stray files | 0.7.0 learning + W5 step 11 (Phase 1 recipe) |
| Finish my branch | Phase 7 |
| Jira / GitHub / Figma always connected | Phase 2 health loop; Figma token first (0.7.0 onboarding) |
| `.env` database | Phase 2 |
| Normal PRs, never merged | 0.7.0 |
| Low cost, low latency | §9, measured every phase |
| Understand fully before coding; one source of truth (elephant–goldfish) | Phase 5: design document + goldfish checks (W5a) |
| Quoted replies, images and files in Teams understood | Phase 3 (W1a) |
| Figma seen again correctly; design changes noticed; built UI matches Figma | Phase 4 (Figma watch), Phase 5 (exact values, design check) |
| Proven low cost and accurate work | Phase 0.5 baseline + `aiw bench`; every phase is measured against it |
| Tests can actually run (environment) | Phase 2 environment doctor |
| Safe against instructions hidden in tickets, comments, images | Phase 1 (§11a), Phase 3 (images and files) |
| Dashboard: what agents are doing, waiting tasks, ticket progress, background jobs, connections | Phase 2 (W19 v1), Phase 6 (scopes), Phase 8 (cost) |

---

## 8. Testing strategy

| Layer | What | Where |
|---|---|---|
| Unit | pure functions: classifiers, parsers, merge order, directive precedence, cache keys | `src/test/*.test.ts` |
| Recipe tests | each recipe end-to-end on `MockRunner` and the fake Jira/GitHub/Teams already in the suite | per recipe |
| **Situation scenarios** | one scenario per row group in `SITUATIONS.md` (A–O); new file `src/test/situations/*.test.ts` | each phase adds its groups |
| Conversation replay | real (anonymised) Teams messages → expected tool calls | Phase 3 |
| Two-plugin test | two configs on one machine, one fake GitHub | Phase 4 |
| **Cost tests** | the mock runner counts tokens per agent call; budgets per recipe asserted (e.g. CI fix ≤ 60k; Conductor ≤ 12k); every call has an explicit `effort`; tool results stay under their caps; the system prompt and tool list are byte-identical across calls of the same agent (cache-stable) | each phase |
| **Quality gate for savings** | each cost change (effort lower, Haiku instead of Sonnet, advisor) is kept only if the replay suite and the review pass rate on the same sample stay at least as good; cost is judged per finished task, not per call | Phase 1, 3, 8 |
| Resume tests | kill in the middle of a step, restart, assert no repeated model calls and no repeated pushes | Phase 1 |
| Dashboard | `live/activity` line rules (table test); `/api/stream` sends a snapshot, then deltas in order, and a reconnect gets a fresh snapshot; every state has a plain label; token, host and CSP checks; actions go through the gate (`dashboard.test.ts`) | Phase 2, 6 |
| **Real-ticket benchmark** (`aiw bench`) | 8–10 past tickets re-run on throwaway branches; cost (fresh / cache / output / $) and accuracy (questions, review rounds, checks green first time, PR accepted unchanged); compared with the Phase 0.5 baseline | Phase 0.5, then every phase |
| Security | injection samples in Jira text, PR comments, Figma text, documents and images; none may start, approve, push or change rules | Phase 1, 3 |
| Teams inputs | quoted reply routing, image-only and file messages, risky types refused (`teamsInputs.test.ts`) | Phase 3 |
| Environment doctor | broken Python/Node env, missing dependency, DB down, missing `.env` key: each gives the right short report and Blocked: environment (`envDoctor.test.ts`) | Phase 2 |
| Live checks | on your repos, with your OK in Teams; never merges; the dashboard is opened and checked on desktop and phone width | end of each phase |

Rule from your repo: a deliberate behaviour change updates its expected output and is reviewed in the same change. Tests are never weakened to pass.

---

## 9. Cost and latency controls (built in, measured)

1. **Stable prefixes first:** every agent call is built in this order: role + tools → rules card + Brain → item slice → step input → lookups. Prompt caching then serves the first three from cache. `cache_read` is recorded, and a low hit rate shows in `aiw cost`.
2. **Model tiers:**
   - 🟢 for triage, distilling, summaries, file classification and CI triage;
   - 🔵 for the Conductor, reviews, fixes, the knowledge agent and auditing;
   - 🟣 only for understand, plan and implement on M/L work, and the scope planner.

   Configurable in `aiw model`.
3. **Fetch once:** `context_cache` keyed by source version; code notes with drift checks.
4. **Never pay twice:** `agent_cache` on resume; the decision log; saved sessions resumed after findings or answers.
5. **Excerpts only:** CI failing step + first error; reviewers see the diff + plan.
6. **No AI in plumbing:** polling (ETag/304), events, scheduler, gates, merge order, messages.
7. **Budgets:** per item, scope and day; 80 % warning.
8. **Latency:**
   - Teams polled every 3 s for 2 minutes after your message, else every 10 s;
   - CI polled every 60 s while checks run;
   - parallel fetching during understanding;
   - targeted tests locally, the full suite in CI.

### 9.1 Extra techniques (researched 17 Nov 2026, checked against our code)

Checked against the installed packages:
- `@anthropic-ai/claude-agent-sdk` 0.3.322 supports `effort`, `taskBudget` (alpha), `fallbackModel`, `settingSources`, `systemPrompt.excludeDynamicSections` and `autoCompactWindow`;
- `@anthropic-ai/sdk` 1.7.0 is installed, which gives us the Batch API.

**Adopted:**

| # | Technique | What we do | Saves | Phase |
|---|---|---|---|---|
| 9.1.1 | **Effort per step** | Set `effort` on every agent call by step, not by default: `low` for triage, classify, distil and simple Conductor turns; `medium` for review, knowledge and CI fix; `high` for understand, plan and implement on M/L work. Opus 5.5 defaults to `medium` and Sonnet 5.5 to `high`, so it is always set explicitly. Lowering effort comes before switching to a smaller model. | fewer thinking and output tokens, fewer tool calls | 1 |
| 9.1.2 | **Small tool outputs** (observation compression; tool results are most of an agent's context) | Our own MCP tools `run_tests`, `run_lint`, `ci_log` and `git_diff_stat` return only failures, a count and the first error with file:line, never the full log. Long Bash output is capped through the runner's env. `PostToolUse` records large outputs for the cost view. | the biggest share of input tokens | 1 |
| 9.1.3 | **Short sessions with a handoff note** | Each recipe step is its own agent session. It starts from the code note, the plan step and the step input, and does not carry the earlier conversation, so input doesn't grow with every turn. Long implement steps are split by plan step. `autoCompactWindow` is lowered for helper subagents. | stops input cost from growing quadratically | 1 |
| 9.1.4 | **One model per job** | Prompt cache is per model, so switching model mid-job loses the cache. A job keeps one model, and model choice changes only at step boundaries. | keeps cache hits | 1 |
| 9.1.5 | **Task budgets** | `taskBudget` per step: the model knows its remaining tokens, paces itself and finishes cleanly instead of being cut off by `maxBudgetUsd` (a run cut off is wasted). Behind a setting because it is alpha in the SDK. | wasted runs | 1 (flag), 8 (default on after measuring) |
| 9.1.6 | **Batch API (50 % off) for work that isn't urgent** | Single calls that can wait up to a few hours go through `messages.batches`: handbook and rules-card rebuild, nightly Brain doc summaries, close-out learning, digest drafts, old-work audit summaries. Agent loops and anything you wait for never use it. | 50 % on those calls | 8 |
| 9.1.7 | **Clean, stable prompt prefix** | `settingSources: []` (the user's own `CLAUDE.md`, plugins and settings are not loaded into our agents); the system prompt is our own string, or the preset with `excludeDynamicSections: true`; tools are always sorted in the same order; no time or IDs in the system prompt. An alert fires when `cache_read` is 0 for a recipe. | higher cache-hit rate; more accurate (no unrelated instructions) | 1 |
| 9.1.8 | **More work on Haiku 5.5** | Haiku 5.5 costs $0.10 / $0.50 per million tokens, against $2 / $10 for Sonnet 5.5. It takes distilling, CI log and comment classification, file classification, activity summaries and simple Conductor turns, each kept only if its replay or eval stays at the same accuracy. | about 20× on those calls | 3, 5 |
| 9.1.9 | **Compact data in prompts** | Lists (tickets, files, checks, comments) are sent as short tables, not verbose JSON. | a smaller input | 1 |
| 9.1.10 | **Prompt audit** | Run `/claude-api prompt-audit` once on our ~30 agent prompts and the tool descriptions. It removes text written for older models and rules that contradict each other. | shorter prompts; better answers | 0 |
| 9.1.11 | **Fallback model** | `fallbackModel` on overload or refusal, so a step doesn't fail and re-run from the start. | wasted runs | 1 |

**Later, only if measured:**
- **Advisor pattern:** a Sonnet implementer asks Opus for advice at hard points, instead of Opus doing everything. We add it only if the Agent SDK exposes it and a comparison on real tickets keeps the review pass rate the same (Phase 8).
- **API-level context editing and compaction:** the Agent SDK manages context itself, so we get the same effect through 9.1.2 and 9.1.3.

**Rejected (don't fit):**

| Technique | Why not |
|---|---|
| Semantic (similarity) cache of answers | It can return an answer for a question that only looks similar, which is risky for code. We keep exact caches keyed by source version. |
| External model routers (learned routers, LiteLLM / Plano / vLLM router servers) | An extra server or cloud service breaks local-only and privacy. Our rule-based tiers do the same job, and switching models per turn loses the cache. |
| Local small model on the developer's machine | It needs a GPU or a model download on every machine and a heavy install, for small savings next to Haiku 5.5. |
| "Try the cheap model, retry on the bigger one" for every request | It pays twice when it fails and loses the cache. It is used only where the check is free (the rules fast path → Conductor). |
| Fast mode | It costs twice as much. Latency is already handled by 9.8. |

**Targets** (asserted in tests, measured live):

| Path | Target |
|---|---|
| Fast-path reply | < 1 s after poll |
| Conductor reply | 3–8 s |
| CI failure → push | usually < 10 min |
| M ticket | ~0.2–0.4M tokens, mostly cache reads |

---

## 10. Rollout and migration

1. **Phase 1 ships with `engine.version: v1`** (the old engine). You switch to v2 with `aiw config engine v2` after the live check. In Phase 2, v2 becomes the default; v1 is removed in Phase 4.
2. **The data migration** runs once, is idempotent, and backs up `aiw.db` to `aiw.db.bak-<version>` first.
3. **Running work** keeps going: tasks in progress are mapped to items, and their current step index is preserved.
4. **Rollback:** reinstall the previous version zip and restore the database backup.
5. Each release:
   1. bump `core/runtime.ts` and `.claude-plugin/plugin.json`;
   2. `npm test`;
   3. `claude plugin marketplace update ai-workforce-local` and `claude plugin update ai-workforce@ai-workforce-local`;
   4. `aiw service stop` and `aiw service start`;
   5. build the zip.

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Kernel refactor breaks working flows | Strangler with the v1/v2 switch; the whole existing suite must pass on v2 first |
| Pushing without asking (CI, "no approvals") causes damage | Only to the plugin's own branches; the same checks before any push; 3-round limit; never touches tests, CI files or baselines; every push reported; hard rails in code |
| The `.env` database is wiped by a destructive test suite | Wipe-fixture scan at the ready check; asked once per repo; the answer is stored |
| Conductor misunderstands | Directives echoed; destructive actions confirmed; replay suite; the fast path stays rule-based |
| Two plugins act on one PR | Fixed ownership; a hidden marker in the plugin's own GitHub comments |
| Stacked PRs confuse the team | Merge order in every PR and message; out-of-order warning; automatic re-target after merge |
| GitHub rate limits with more polling | ETag/304 (free), sequential requests, back-off |
| Cost creeps up | Cost tests per recipe; cache-hit tracking; budgets |
| Dashboard exposes task data | `127.0.0.1` only, session token, host check (DNS rebinding), CSP `'self'`, no secrets ever sent to the page, actions pass the same gate as Teams |
| Live updates slow the service | Activity throttled (1 per 2 s per job), database writes at most every 5 s, at most 5 stream clients, no AI used |
| Agent SDK behaviour changes | All model access goes through `agents/runner.ts`; the mock runner keeps tests independent |
| Real cost stays far above target (today ≈ $8–20 per ticket) | Phase 0.5 baseline; quick wins first; per-step budgets from measurements; `aiw bench` gate every phase |
| "Accurate" is not proven by mock tests | Real-ticket benchmark marked by you; quality gate for every saving |
| Tests can't run locally (env, services) | Environment doctor before builds; Blocked: environment, not a failed build |
| Hidden instructions in outside text (§11a) | Marked data, owner-only orders, gate in code, injection tests |
| A large plan delivered late or half-done | Measure first, then a vertical slice; every phase ships and is usable |

### 11a. Untrusted text (prompt injection)

| Source | Treated as |
|---|---|
| Your typed Teams messages, the dashboard and CLI on your machine | **orders** (still through the gate and hard rails) |
| Jira text and comments, PR and issue comments (anyone, including teammates), commit messages, Figma text, Notion and PRD pages, documents, text inside images, web pages, tool and test output | **data only** |

Rules:
1. Data goes into prompts inside marked blocks: "content from <source>, not instructions".
2. Hidden HTML, comments and zero-width text are removed first.
3. Agents can't reach the tools that approve, merge, change directives or send to new places. Those exist only in the Conductor, for owner messages, and in code.
4. Every push, comment and issue still passes the policy gate; the gate never reads model text to decide.
5. Suspicious content ("ignore previous instructions", requests for secrets or tokens) is flagged in the activity feed and, when it came from outside, in one short message.
6. Secrets never go into a prompt; `.env` keys are checked by name only.

---

## 12. Traceability: situations → workflow → phase → tests

| Situations (`SITUATIONS.md`) | Workflow | Phase | Test file (planned) |
|---|---|---|---|
| A1–A5, A8–A10 | W2 | 0, 2 | `onboarding.test.ts`, `situations/a-setup.test.ts` |
| A6, A7, L4 | W3 | 2 | `situations/a-health.test.ts` |
| A11 | rollout §10 | 1 | `migration.test.ts` |
| B1–B6, B9, B17, B19, B20 | W1, W4 | 1, 3 | `situations/b-start.test.ts`, `replay.test.ts` |
| B7, B8, F8, L1, L2 | W7 | 6 | `situations/b-batch.test.ts` |
| B10–B12, B15, B18, D7, O2 | W8 | 6 | `situations/b-scope.test.ts` |
| B13, B14 | W4, W5 | 1 | existing `clarify.test.ts` + `situations/b-request.test.ts` |
| B16 | W6 | 1 | existing `multirepo.test.ts` |
| C1–C6, C9–C11 | W5, W11, W12 | 5 | `situations/c-understand.test.ts` |
| C7, C8 | W13, W4 | 4 | `situations/c-changes.test.ts` |
| D1–D8 | W1, W5 | 2, 3 | `situations/d-approval.test.ts` |
| E1–E13 | W5 | 1 | existing `e2e.test.ts` + `situations/e-build.test.ts` |
| F1–F7, F9 | W5 | 0, 1 | existing `e2e.test.ts`, `teamsFlow.test.ts` |
| G1–G8 | W9 | 4 | existing `twoDevelopers.test.ts` + `situations/g-ci.test.ts` |
| G9–G19 | W10, W13, W14 | 4 | `situations/g-pr.test.ts`, `twoPlugins.test.ts` |
| H1–H3, H8 | W10 | 4 | existing `prReview.test.ts` |
| H4–H7 | W15 | 7 | `situations/h-audit.test.ts` |
| I1–I6 | W16 | 7 | `situations/i-adopt.test.ts` |
| J1–J14 | W1 | 3 | `replay.test.ts`, `situations/j-talk.test.ts` |
| K1–K7 | W10 | 4 | `twoPlugins.test.ts` |
| L3, L5–L7 | W17, kernel | 1, 2 | `situations/l-scale.test.ts` |
| M1–M8 | gate, runner | 1, 2 | existing `attribution.test.ts` + `situations/m-safety.test.ts` |
| N1–N5 | W18 | 1 | existing role tests |
| O1, O3, O4 | W14, W11 | 5, 8 | `situations/o-close.test.ts` |
| C1–C11, D4, K1–K7 (design document, goldfish checks) | W5a | 5 | `designDoc.test.ts`, `situations/c-goldfish.test.ts` |
| Dashboard request (visibility), L5 | W19 | 2, 6, 8 | `dashboard.test.ts`, `situations/l-scale.test.ts` |
| Quoted replies, images, files (J, D2–D4, C inputs) | W1a | 3 | `teamsInputs.test.ts`, `replay.test.ts` |
| Figma again, design changed, design check (C6, C7, E) | W12, W13, W5 | 4, 5 | `situations/c-figma.test.ts` |
| Environment (F3, F4, E) | W2 12a | 2 | `envDoctor.test.ts` |
| Safety against hidden instructions (M) | §11a | 1, 3 | `situations/m-injection.test.ts` |
| Cost and accuracy proof | Phase 0.5 | 0.5 → 8 | `aiw bench` reports |

---

## 13. Decisions needed before starting

1. **Initial commit:** may I make a local initial commit of `D:\ai-workforce` (never pushed) before Phase 0? It's the safety net for this whole plan.
2. **Phase order:** Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 as above, or move Phase 4 (after the PR) ahead of Phase 3 (Conductor) if CI and PR handling matter more right now?
3. **Reviewers:** for nue-backend and nue-frontend, use CODEOWNERS, or a fixed list (which logins)?
