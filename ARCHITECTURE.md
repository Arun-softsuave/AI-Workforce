# AI Workforce – Architecture (1.0)

How the plugin is built: what runs where, how work moves, what keeps it safe and what keeps it cheap.
Code references are under `service/src`. The full design is in `IMPLEMENTATION-PLAN.md`; the behaviour for 150 real
situations is in `SITUATIONS.md`.

---

## 1. The big picture

```
          ┌──────────────────────────── your computer (no cloud server) ────────────────────────────┐
          │                                                                                         │
 Teams ◄──┼─► Messenger ◄── fast path (rules) ◄── Conductor (one model call) ◄── your message        │
          │        ▲                                   │ tools                                      │
 Jira  ◄──┼─► intake ─► events ─► reactions ─► jobs (mailbox) ─► scheduler ─► runner ─► steps       │
 GitHub◄──┼─► (ETag / 304)          (data)        one per item     (code)       recipes   agents    │
 Figma ◄──┼─► knowledge: context cache · design document · Brain · Graphify graph · ask-desk         │
          │                                                                                         │
          │   policy gate (every push, PR, comment, issue, Jira write)  ·  SQLite ~/.ai-workforce/aiw.db │
 Claude ◄─┼─► /aiw-* commands · MCP tools · hooks · `aiw` CLI · dashboard http://127.0.0.1 (token)  │
 Code     └─────────────────────────────────────────────────────────────────────────────────────────┘
```

Three rules shape everything:
1. **Code drives, agents decide.** Polling, events, scheduling, gates, merge order and messages are plain code with
   no model calls. Agents only read, write code and choose among fixed options (structured output).
2. **Outside text is data, never orders.** Only your typed Teams messages, the dashboard and the CLI on this computer
   can start, approve, cancel or change rules (§7).
3. **Nothing leaves the machine without the gate.** Never merge, never force-push, never push to main/dev, hooks always
   run, secrets only in the OS vault, no AI mention anywhere.

| Part | Job | Code |
|---|---|---|
| Service `aiw-agentd` | One Node process, starts at login; timers, pollers, local API | `daemon/` |
| State | SQLite (`node:sqlite`, WAL): items, jobs, events, steps, approvals, decisions, directives, docs, chat log | `core/db.ts` |
| Kernel | Items, events, reactions, mailbox, scheduler, runner, recipes | `kernel/` |
| Conductor | Understands your Teams messages and calls tools | `conductor/` |
| Messenger | Short messages, merging, quiet hours, digest, "details" | `messenger/` |
| Knowledge | Design documents, Figma exact values, your pictures and files, context cache | `knowledge/`, `agents/lookup.ts` |
| Brain | Code map, Graphify graph, Handbook, rules card, search index, diaries | `brain/` |
| Policy | Gate, directives, untrusted-text handling | `policy/` |
| Dashboard | Live page, SSE stream, plain-English activity | `api/`, `live/`, `service/web/` |
| Cost | Effort per step, tiers, caches, batch API, budgets, benchmark | `agents/`, `engine/budget.ts`, `bench/` |

---

## 2. Kernel (engine v2)

The kernel runs every piece of work. `engine.version` picks it (`aiw config engine v1|v2`); v1 is the old task engine,
kept until every flow passes on v2.

- **Items** (`kernel/items.ts`) – a work item is a `tasks` row with a level (`sprint`, `epic`, `batch`, `ticket`, `part`, `request`, `pr`, `branch`, `audit`),
  a parent and root, areas it touches, an owner and a due date. Two-repo tickets are a ticket with one `part` per
  repository. `edges` hold `depends_on` and `stacks_on`; **merge order** is computed from them.
- **Events** (`kernel/events.ts`) – everything that happens (ticket changed, CI failed, comment, PR merged, connector
  down) is one row, de-duplicated by key.
- **Reactions** (`kernel/reactions.ts`) – a table, as data: event + guard → job type, or "notify / ask / block". Guards
  read only the event, the item and settings.
- **Mailbox** (`kernel/mailbox.ts`) – one active job per item; new work waits as queued jobs, and repeats fold into
  one (ten CI failures before the fix starts give one fix job).
- **Scheduler** (`kernel/scheduler.ts`) – pure code. Holds a job with a plain reason: paused, blocked, connector down,
  budget, waiting for its current job, waiting for another ticket (waves), same area, repo limit, all slots busy.
  Starts by priority, due date, then age.
- **Runner + recipes** (`kernel/runner.ts`, `kernel/recipes.ts`) – a recipe is an ordered list of steps. Every v1
  playbook is a recipe of the same name; the after-PR recipes live in `service/recipes/*.yaml` (`ci_fix`,
  `comment_fix`, `ci_watch`, `rebase`, `replan`, `close`). Step functions keep one contract (`StepCtx` in,
  `StepResult` out): `engine/steps.ts` and `engine/steps/*.ts`.

**A ticket, end to end (`build`):** understand → plan → goldfish checks on the design document (M/L) → plan approval
(per your rules) → environment doctor → implement + test → reviews (code, security, QA in parallel) → report →
PR approval (per your rules) → normal PR → `ci_watch`. After the PR: CI failure → `ci_fix` (pushed without asking,
3 rounds, checks that need a person are never faked) · review comments → `comment_fix` (shown first unless your rule
says otherwise) · base moved or conflict → `rebase` (merge commit, never a force-push) · ticket or Figma changed →
`replan` · merged → `close` (dependents start, stacked PRs re-targeted, worktree cleaned).

**Two repos:** one plan, one contract, one part per repo built in the decided order, an integration check, then one
PR per repo with the merge order in each PR and message.

---

## 3. Conductor (your Teams messages)

1. **Fast path** (rules, no model): "1", "yes", "thanks", "status KAN-45", "details KAN-45" – answered in under a second.
2. **Conductor** (`conductor/conductor.ts`, one medium-tier call): a cached prefix (instructions, tools, your
   preferences, rules in force, team, projects) + one line per active item + the last 20 chat turns. It answers with
   tool calls: `find`, `start`, `decide`, `set_directive`, `prefs`, `control`, `fix_pr`, `review`, `qa`, `adopt`,
   `status`, `explain`, `lookup`, `preview_scope`. Code runs them; destructive or unclear calls come back as one
   short question.
3. **Quoted replies, pictures and files** (`knowledge/inputs.ts`): a quoted bot message points at its item; a
   screenshot or file is stored, described once and added to the item's design document as an input.
4. **Directives** (`policy/directives.ts`): "no need to ask for KAN-45", "only backend", "don't touch tests". Stored
   per scope (item > batch > epic > sprint > global > settings), echoed once, listed by `aiw rules`.

---

## 4. Messenger (what reaches Teams)

`messenger/` sits inside the notification router:
- **Short templates** – at most 10 lines; the rest behind "details KAN-45" (questions are never shortened).
- **60 s merging** of routine updates about the same item.
- **Quiet hours** – non-urgent messages held, then one catch-up message.
- **Morning digest** – ≤ 10 lines: done, in progress, waiting on you, blocked, merge next, connections.
- **Connector health** (`intake/health.ts`) – a cheap check per tool every 5 minutes; a tool that goes down blocks only
  the work that needs it and sends one reconnect line (repeated at most every 6 h); work resumes on reconnect.

---

## 5. Knowledge

- **Design document** (`knowledge/designDoc.ts`) – one per item at `~/.ai-workforce/items/<item>/design.md`, outside
  the repo, never pushed, every version recorded in `docs`. Sections: problem and goal, acceptance criteria, how the
  system works today, approach, alternatives rejected, files, contract, decisions, tests, inputs from you, open
  questions. It is the source of truth: understand and plan write it, **goldfish checks** (fresh sessions that see only
  the document) test it before code is written, every later step and restart starts from it, and `aiw explain` shows
  it. The Claude Code helper agents (`aiw-planner`, `aiw-reviewer`, `aiw-memory-keeper`) read and write the same file.
- **Ask-desk** – an agent's question goes to the knowledge service first (Brain, graph, code, earlier decisions); only
  product decisions reach you, and every answer is written into the document.
- **Context broker** (`agents/lookup.ts`, `context_cache`) – Figma frames, tickets, PRs and code notes fetched once per
  source version. Figma values are kept exact (`knowledge/figma.ts`), never condensed.
- **Brain** (`brain/`) – code map, Graphify code graph (no tokens), Handbook facts (verified / unverified), a short
  rules card of the team's own conventions, FTS search, task diaries.

---

## 6. Dashboard

`aiw dashboard` opens `http://127.0.0.1:<port>/?t=<token>` – this computer only, host-checked, CSP `'self'`, no secrets
sent to the page. Producers call `live.publish` (`live/bus.ts`); `GET /api/stream` (Server-Sent Events) sends a snapshot,
then small deltas. Activity lines come from fixed rules (`live/activity.ts`: "Running npm test", "41 of 58 passed"),
no model. Sections: Needs you · Working now · Ticket progress (one bar per repo) · ticket drawer (timeline, design
document, merge order) · Activity · Agents and queue reasons · Background timers · Connections · Cost. Actions on the
page go through the same gate as Teams and are echoed there.

---

## 7. Policy and untrusted text

- **Gate** (`policy/gate.ts`) – every push, PR, comment, issue and Jira write asks here. Order: hard rails (never merge,
  force-push, push to main/dev, secrets, orders from outside text) → protected paths (always your OK) → directives →
  settings. The gate never reads model text to decide. Approvals are bound to the exact commit.
- **Untrusted text** (`policy/untrusted.ts`) – Jira, PR and issue comments (also teammates'), commit messages, Figma,
  documents and text inside images are cleaned (hidden HTML, comments, zero-width text) and passed to agents as marked
  data. Text that tries to give orders is flagged in the activity feed. Agents can't reach the tools that approve,
  merge, change rules or message new places.
- **Environment doctor** (`engine/envDoctor.ts`) – before every build (cached 1 h): versions, packages, `.env` key
  **names**, database, services, optional smoke test. A broken environment means **Blocked: environment**, not a
  failed build.

---

## 8. Cost

| Control | How |
|---|---|
| Stable prefixes | role + tools → rules card + Brain → item slice → step input; prompt cache serves the first parts; `cache_read` recorded |
| Model tiers | small (Haiku 5.5) for triage, distilling, CI and comment classification; medium (Sonnet 5.5) for Conductor, reviews, fixes; large (Opus 5.5) only for understand / plan / implement on M/L work |
| Effort per step | set explicitly: low for triage, medium for review and fixes, high for M/L planning and implementing |
| Small tool outputs | tests, lint, CI logs and diffs return failures and the first error only (`agents/tools/compact.ts`) |
| Short sessions | each step is its own session starting from the design document; one model per job (keeps the cache) |
| Fetch once, never pay twice | `context_cache`, `agent_cache`, the decision log |
| Batch API | non-urgent single calls (handbook, rules card, close-out learning, digests) at half price (`agents/batch.ts`) |
| Budgets | per item, scope and day; 80 % warning |
| Measured | `aiw cost`; `aiw bench` baseline, runs and comparisons gate every release |

---

## 9. Where things live

```
~/.ai-workforce/
  aiw.db                      items, jobs, events, steps, approvals, decisions, directives, docs, chat log
  items/<item>/design.md      design document per item (never pushed)
  config/settings.yaml        your settings and preferences      config/projects.yaml   projects and groups
  projects/<id>/              code map, graph, test profile, diaries
  worktrees/<project>/<item>/ one git worktree per item – your own checkout is never touched
  logs/aiw-agentd.log         service log
<repo>/.ai-workforce/knowledge Handbook (yours to commit and share)
OS credential vault           every token and test login
```

Claude Code side: `commands/` (slash commands), `skills/` (onboarding, Brain), `agents/` (planner, reviewer,
memory keeper), `.mcp.json` (MCP tools such as `aiw_status`, `aiw_items`, `aiw_explain`, `aiw_rules`, `aiw_doctor`,
`aiw_bench_report`), `hooks/` (SessionStart inbox, prompt routing), `bin/` (`aiw`).

---

## 10. Known limits

- Work runs only while the computer is on and the service is running; after sleep it catches up.
- Two-way chat needs personal Teams (teams.live.com) with a separate bot account; work Teams is a one-way webhook.
- Local tests are targeted; CI stays the full check, which is why every push is watched.
- CI checks that need a person (a new baseline, a paid evaluation, a secret, a deployment) are explained, never faked.
- Not supported: Jira Server / Data Center, GitLab, Bitbucket, Azure DevOps.
