---
name: aiw-onboarding
description: Guide the user through AI Workforce first-run setup (service, model access, roles, connectors, notifications incl. two-way Teams bot, projects, product documents, Brain, go live). Use when the user runs /aiw-setup, asks to set up or configure AI Workforce, or the SessionStart context says the plugin is not set up yet.
---

# AI Workforce onboarding

Walk the user through setup one step at a time. Every step is saved, so setup can be resumed at any time.
Run the `aiw` CLI with Bash. If `aiw` is not on PATH, use `node "<plugin root>/service/dist/cli/aiw.js"`
(the plugin root is the folder that contains `.claude-plugin/plugin.json`).

## How to ask (important)
- **Offer choices, don't make the user type.** For every decision use the AskUserQuestion tool with 2–4 clear options
  (put the recommended one first and mark it "(Recommended)"). The user can always pick "Other" to type something else.
- **Exception – roles:** there are 8 roles and a question box allows only 4 options, so list ALL eight in plain text
  and let the user type their choice(s) (several allowed). Never hide roles behind "Other".
- Where the system can discover the answer, offer the discovered values as options (Jira projects, GitHub repos, local clones).
- Never ask for tokens, API keys, passwords or webhook URLs in the chat. Use the local browser pages (`aiw connect <tool> --browser`)
  or device-code sign-ins. If a secret is pasted into the chat anyway, don't use it – ask the user to revoke it and re-enter it the safe way.
- Keep each step short: one sentence on what it does → do it → confirm the result → next step. On errors show the exact message and the most likely fix.
  Optional steps can be skipped with `aiw setup skip <step>`.

## Steps

1. **Progress** – `aiw setup --json`; resume from `next`. If all steps are done, say so and offer `/aiw-status`.

2. **Prerequisites** – `aiw doctor` (Node ≥ 22.13, git ≥ 2.30, network). Explain any failure.

3. **Background service** – one sentence: it keeps working while Claude Code is closed (only while the computer is on).
   Options: *Install and start (Recommended)* · *Not now*. Then `aiw service install` and `aiw service status`.

4. **Model access** – options:
   - *Claude Code login (Recommended for personal use)* → `aiw model --provider claude-login`. Relay the printed warning: usage counts against
     the user's Claude plan; Anthropic asks products built on the Agent SDK to use API keys – the user should check their plan's terms.
   - *Anthropic API key* → the user runs `aiw model --provider claude --key-stdin` in their own terminal and pastes the key at the hidden prompt.
   - *Mock (free dry run, no real AI)* → `aiw model --provider mock`.

5. **Profile & roles** – ROLES ARE TYPED: show all eight and ask the user to type one or more:
   Backend Developer · Frontend Developer · Full Stack Developer · QA Engineer · DevOps Engineer · Business Analyst · Project Manager · UI/UX Designer
   (ids: backend-developer, frontend-developer, fullstack-developer, qa-engineer, devops-engineer, business-analyst, project-manager, uiux-designer).
   Then OPTIONS for working hours (e.g. *09:00–18:00* · *10:00–19:00*) and time zone (offer the local one detected from the system first).
   `aiw profile --name "<name>" --roles <ids> --tz <zone> --hours <HH:MM-HH:MM>`

6. **Connectors** – `aiw setup --json` lists `recommended` and `optional` connectors for the roles. For each, options: *Connect now* · *Skip*.
   RULE: connect the way Claude connects to MCP servers – a browser sign-in first. NEVER ask the user to create an API token, an
   integration or a personal access token unless the browser sign-in failed or the tool has none (Slack, work-Teams webhook).
   Run each sign-in command in the background, tell the user a browser page opens (the URL is printed too) and wait for it.
   - **Jira** – *Sign in with Atlassian in the browser (Recommended)*: `aiw connect jira`. The user picks their account and clicks
     Accept. If several sites are listed, re-run with `--site <host>`. Admin/permission error = the organisation blocks the Atlassian
     MCP connection → only then offer the API token: `aiw connect jira --browser`.
   - **GitHub** – *Sign in to GitHub in the browser (Recommended)*: `aiw connect github`. If `gh` is already signed in it is reused
     at once; otherwise a browser page opens and the printed one-time code is entered (it is also on the clipboard), then Authorize.
     If the GitHub CLI is missing, tell them to install it (`winget install GitHub.cli`) and run the command again. Token only as a
     last resort: `aiw connect github --browser`.
   - **Notion** – *Sign in with Notion in the browser (Recommended)*: `aiw connect notion`. They choose the workspace and the pages
     AI Workforce may read, then Allow. Fallback: `aiw connect notion --browser` (integration token).
   - **Figma – token first.** Figma must stay connected all the time (also when the Figma app is closed), and Figma's online MCP
     server only admits approved apps, so there is no browser sign-in for AI Workforce. Options:
     *Personal access token in the local page (Recommended)*: `aiw connect figma --browser` – the user creates a token in Figma
     (Settings → Security → Personal access tokens, scopes File content: read-only + Current user: read) and pastes it into the local
     page, never into the chat. It reads any file and is checked regularly, with a Teams alert if it stops working.
     *Also use the Figma desktop app (optional)*: open a file, Dev Mode (Shift+D) → "Enable desktop MCP server" (Dev or Full seat),
     then `aiw connect figma`. Tasks then read the design that is open in the app.
   - **Slack / work Teams webhook** – these services have no browser sign-in for outside apps (Slack requires an admin-approved Slack
     app; work Teams requires an Azure app). Say so in one line, offer *Skip (Recommended when using the Teams bot)*, otherwise
     `aiw connect <tool> --browser`.
   Confirm with `aiw connections`.

7. **Notifications** – options for the main channel:
   - *Microsoft Teams – two-way with a bot (Recommended)* (personal Teams at teams.live.com)
   - *Microsoft Teams – my own Notes chat* (personal Teams, messages appear in the user's own name)
   - *Windows desktop alerts only*
   - *Work Teams (company account) – one-way webhook*
   Then the daily check-up time (default 10:00 – one Teams message with what waits for them, what runs, what finished,
   failures and connection health) and quiet hours (default *None* – it works 24 h while the computer is on).
   With the two-way Teams bot, Teams becomes the ONE place they work: every message goes only there, and plans,
   questions and PR approvals are answered there in plain words ("plan for KAN-42", "1", "yes", "no, use …").

   **Teams with a separate bot – explain clearly before starting:**
   "To receive messages from a bot (e.g. "AI Workforce Bot") instead of from yourself, you need a SECOND personal Microsoft account
   that acts as the bot. The plugin signs in to Teams as that bot account and messages your own account."
   Steps for the user:
     1. Create the bot account: open https://signup.live.com (normal window, no VPN – Microsoft may block sign-ups from VPN/office networks;
        if blocked, wait a few hours or use a phone hotspot). Choose "Use your email address instead" with a spare email (e.g. a second Gmail),
        or create a new @outlook.com address. Name it **AI Workforce** / **Bot**.
     2. Sign in once at https://teams.live.com with the bot account (incognito window) and finish the welcome screens.
     3. From the bot account: Chat → New chat → type the user's FULL personal Teams email → send "hi".
        In the user's own Teams, accept the chat and reply "hi". (Or start the chat from the user's side – either works.)
     4. Run `aiw connect teams-personal --bot` in the background, read the device code from its output and tell the user:
        "Open https://login.microsoft.com/device, enter <code>, and sign in with the BOT account (not your own)".
        If several chats are found, re-run with `--owner "<user's name>"`.
     5. The bot sends "Hi <name>! I'm your AI Workforce assistant…". Then `aiw notify --primary teams-personal --fallback desktop,inbox`.
   Own-Notes-chat variant: `aiw connect teams-personal` (sign in with the user's own personal account).
   Tell the user what they can do in the chat: any question about the project (bot chat; in own Notes chat start with "aiw"),
   and commands: help, inbox, status, approve <task>, reject <task> "reason", run <KEY>, new. Only the user's own messages are accepted.
   Note: personal Teams only (work/school Teams is not supported for two-way); it uses Teams' unofficial web APIs.
   Finish with `aiw notify test`.

8. **Projects** – discover and OFFER options:
   - Jira projects (list them via the Jira connection) and GitHub repos (`gh repo list` / the GitHub connection), and local clones found on disk.
   - Several repos for one Jira project (backend + frontend)? Offer *One product, several repos (Recommended when the Jira project is shared)* →
     add each repo with the same `--group <name>`; triage decides backend / frontend / both per ticket.
   - Autonomy options: *plan – approve the plan before any code (Recommended)* · *prepare – approve before any PR* · *observe – notify only*.
   `aiw project add --id <id> --path "<clone>" --jira-keys <KEY> [--group <name>] --roles <ids> --autonomy <level>`
   If the repo isn't cloned locally, offer to clone it first.
   After adding projects, run `aiw pause` so no work starts before the Brain and documents are ready (resumed at go-live).

8b. **Team** – one sentence: the plugin learns who works on each repo so it can request reviews on its PRs.
   `aiw team detect <project>` suggests teammates (GitHub contributors and recent git history) and shows whether the repo has a
   CODEOWNERS file; it also saves the user's own GitHub login. Offer the suggestions as options and add the chosen ones with
   `aiw team add --github <login> --name "<name>"` (`aiw team me --github <login>` if the user's own login is wrong; `aiw team list` to show).
   Then reviewers, per project – options:
   *From CODEOWNERS (Recommended when the repo has one)* → `aiw team reviewers <project> --codeowners` (owners of the changed files) ·
   *A fixed list* → `aiw team reviewers <project> --list login1,org/team` · *No reviewers* → `aiw team reviewers <project> --none`.
   The PR author is never asked to review their own PR.

9. **Product documents** – options: *Yes, I have a PRD / BRD / spec* · *No / later*.
   If yes: ask for the file path(s) (.pdf .docx .md .txt), then options: *Private – keep it on this PC only (Recommended for confidential docs)* ·
   *Shared – store it in the repo for the team*. `aiw brain add-doc <project> "<path>" [--private]` (stored for every repo in a group).
   If no: `aiw setup skip documents`.

10. **Brain** – one sentence: the plugin studies each repo (code map + AI reading within a budget) and writes a Handbook.
    `aiw brain onboard <project>` for each project; show a short summary of what it learned; options:
    *Looks right – confirm (Recommended)* · *I'll review the files first* · *Something is wrong (tell me)*. Confirm with `aiw brain confirm <project>`.
    Mention the Handbook lives in `<repo>/.ai-workforce/knowledge/` (uncommitted; commit it to share with the team).

10b. **Team conventions** – `aiw conventions detect <project>` for each project (also runs during Brain onboarding). Show the summary:
    base branch (from where PRs actually go), branch and commit style, instruction files (CLAUDE.md, AGENTS.md, CONTRIBUTING…), PR template,
    lint/format checks and Jira ticket style. Options: *Looks right – confirm (Recommended)* · *Change something*.
    Overrides: `aiw conventions set <project> --base dev` (or --branch / --commit / --checks), then `aiw conventions confirm <project>`.
    If the summary says **Environment: BROKEN**, tell the user the exact repair command it prints (e.g. `uv sync`). A working
    Python elsewhere in the repo (e.g. `.venv-local`) is used automatically; otherwise that repo's work continues "not tested locally".
    Mention the hard rule: nothing in commits, branches, PRs, Jira or code ever mentions Claude/AI, and PRs are never merged by the plugin.
    From what it learned (docstring style, test layout, CI checks, the team's instruction files) the plugin writes a short **rules card**
    that every coding, review and fix step follows. Short instruction files are used word for word.

10c. **Testing on this computer (optional, recommended)** – one sentence: tests, QA checks and PR screenshots run the real app here.
    The test profile of each repo is detected automatically the first time it is needed; nothing to type for that. Explain the rules in
    one line each: test suites never use the `.env` database (they get a temporary one: local server, else Docker); the running app uses
    the `.env` database (shared or local) with background work switched off; work never stops – anything that can't run here is reported
    as "not tested locally". Then offer, one by one (options: *Set it up now* · *Skip*):
    - **Docker Desktop** – needed when there is no local database login or no local Redis/Valkey; the plugin starts it itself when needed.
      Check with `docker --version`; if missing, point to https://www.docker.com/products/docker-desktop/.
    - **A local database login** (only if their local PostgreSQL/MySQL doesn't accept the `.env` login): the USER runs
      `aiw qa database <backend project>` in their own terminal (hidden input). Never ask for it in chat.
    - **Secret test settings** a backend needs to log anyone in locally (e.g. fresh cloud credentials): the USER runs
      `aiw qa env <backend project>` and pastes `SET NAME=value` lines (hidden input, OS credential vault). Never ask for them in chat.
    - **A signed-in test session** for the live app and screenshots (MFA apps): the USER runs `aiw qa token <frontend project>` (access +
      refresh token of a session from their LOCAL backend), or `aiw qa account <frontend project> <demo email> --totp` (demo account +
      authenticator secret). Without one, QA asks once in Teams and those checks say "not tested in the live local app".

10d. **Preferences** – `aiw prefs` shows the current choices. Ask one question at a time (recommended option first):
    - Pull requests: *Normal, ready for review (Recommended)* · *Draft* → `aiw prefs --draft-pr no|yes`
    - Failing CI and lint checks on the plugin's PRs: *Fix and push without asking (Recommended)* · *Show the fix in Teams first*
      → `aiw prefs --auto-fix-ci yes|no`. Review-comment fixes and QA issues are always shown in Teams first.
    - Plan approval: *Ask me (Recommended)* · *Don't ask* → `aiw prefs --plan-approval ask|skip`
    - PR approval before raising it: *Ask me (Recommended)* · *Don't ask* → `aiw prefs --pr-approval ask|skip`
    - When someone asks me to review: *Tell me and wait (Recommended)* · *Review straight away* → `aiw prefs --auto-review no|yes`;
      review comments *Shown first (Recommended)* · *Posted directly* → `--auto-post-review no|yes`;
      QA findings *Shown first (Recommended)* · *GitHub issues created directly* → `--auto-qa-issues no|yes`
    - Tasks at once: *3 (Recommended)* · *1* · *5* → `aiw prefs --parallel N`
    Flags can be combined in one `aiw prefs` call. Show the final summary it prints.

10e. **Ready check** – one sentence: it finds now what would otherwise fail in the middle of a ticket. Read-only: it never edits
    files or commits, and tests never touch the `.env` database.
    `aiw ready` (all projects) or `aiw ready <project>`. It checks the model, Jira/GitHub connections, Teams, preferences and team,
    then per repo: push access and the base branch, reviewers, the rules card and CI checks, lint/format tools, the test runner and a
    temporary test database, and PR screenshots (Playwright). Show the result as it is; for each ✘ line give the printed fix and offer
    *Fix it now* · *Later*. Work still runs with open items – anything that can't run here is reported as "not tested locally".
    Re-run `aiw ready <project>` after a fix. Coming later: a deeper **environment doctor** under `aiw doctor` (language versions,
    installed dependencies, `.env` key names, database and services, a one-test smoke run) – today `aiw doctor` checks the prerequisites only.

11. **Go live** – options: *Go live now (Recommended)* · *Not yet*.
    `aiw resume-all` then `aiw live`. Explain: tickets assigned to the user (updated in the last 24 h) are picked up; older ones via `aiw run <KEY>`;
    plans and PRs need explicit approval; nothing is ever merged or deployed. Offer `aiw dashboard`.

Optional: suggest the Claude Code status line `"statusLine": { "type": "command", "command": "aiw statusline" }`.
