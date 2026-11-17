# AI Workforce – Quick Start for testers

AI Workforce is a Claude Code plugin plus a small background service that runs **on your own computer**.
It watches your Jira tickets, understands your repositories (the "Brain"), prepares plans/code/tests with AI agents,
and asks for your approval in Teams, Claude Code or a desktop alert. It never merges or deploys anything.

## 1. What you need

| Requirement | Check |
|---|---|
| Windows 10/11 (macOS/Linux work too) | |
| Node.js **22.13 or newer** | `node --version` |
| Git **2.30+** | `git --version` |
| Claude Code (signed in) | `claude --version` |
| Optional: GitHub CLI signed in | `gh auth status` |
| A Jira Cloud account | you sign in in the browser (an API token is only a fallback) |
| The project repo(s) cloned locally | |
| Recommended: **Docker Desktop** (installed; the plugin starts it when needed) | `docker --version` – used for temporary test databases / Redis when your computer has no usable local ones |

## 2. Install (5 minutes)

1. Unzip `ai-workforce.zip` to a permanent folder, e.g. `C:\tools\ai-workforce` (don't run it from Downloads).
2. Open **PowerShell** and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File C:\tools\ai-workforce\scripts\install.ps1
   ```
   This installs dependencies, builds the service, adds the `aiw` command to your PATH and registers the plugin in Claude Code.
   If it can't register the plugin, run inside Claude Code:
   `/plugin marketplace add C:\tools\ai-workforce` and `/plugin install ai-workforce@ai-workforce-local`.
3. Close and reopen your terminal, then **restart Claude Code**.

## 3. Onboarding (15–25 minutes)

In Claude Code run **`/ai-workforce:aiw-setup`** and follow the steps. You'll mostly click options:

1. Prerequisites check
2. Background service (auto-starts when you log in; no admin rights)
3. Model: **Claude Code login** (uses your Claude plan) · API key · or **Mock** (free dry run)
4. Your role(s) – type them (8 roles listed)
5. Connect **GitHub** (reuses `gh` login) and **Jira** – *Sign in with Atlassian* in the browser (no API token); API token only if your company blocks it
6. Notifications – see section 4 for the Teams bot
7. Projects – pick your Jira project, repo(s) and local folder(s); choose **plan** autonomy (approve before any code)
8. Product document (PRD/BRD) – optional, can stay private on your PC
9. Brain – the AI studies your repos and writes a Handbook; you confirm it
10. Testing on this computer (optional) – run these in **your own terminal** (input is hidden; never paste secrets in chat or Teams):
    - `aiw qa env <backend>` – secret settings the backend needs locally (e.g. fresh cloud credentials), as `SET NAME=value` lines
    - `aiw qa token <frontend>` – a signed-in test session (access + refresh token from your **local** backend), or
      `aiw qa account <frontend> <demo email> --totp` – a demo account with its authenticator secret
    - `aiw qa database <backend>` – only if your local PostgreSQL doesn't accept the `.env` login (otherwise Docker is used)

    Without these the work still runs end to end; the affected checks are marked "not tested locally".
11. Go live

## 4. Teams notifications with a separate bot (optional, recommended)

To get messages **from a bot** (e.g. "AI Workforce Bot") in your personal Teams and chat with it like Claude Code,
you need a **second personal Microsoft account** that acts as the bot:

1. Create it at https://signup.live.com – normal browser window, **no VPN** (Microsoft may block sign-ups from VPNs/office networks;
   if blocked, wait a few hours or use your phone's hotspot). "Use your email address instead" with a spare email works well.
   Name it **AI Workforce** / **Bot**.
2. Sign in once at https://teams.live.com with the bot account (incognito window).
3. Bot account: **Chat → New chat →** your own Teams email (full address) → send "hi". In your own Teams, accept and reply "hi".
4. In onboarding choose *Teams – two-way with a bot*. You'll get a code: open https://login.microsoft.com/device and sign in with the **bot** account.
5. The bot greets you. Now type in that chat, e.g. `help`, `status`, `which KAN tickets are in progress?`, `approve KAN-42@nue-backend`.

Only **personal** Teams (teams.live.com) supports two-way chat. For company (work) Teams use the one-way webhook option.

## 5. What to test

| # | Test | Expected |
|---|---|---|
| 1 | `aiw status` | Service running, connectors connected, projects listed |
| 2 | `aiw notify test` | A test message from the bot in Teams (or a desktop alert) |
| 3 | In the bot chat: `help` | List of commands within ~30 s |
| 4 | In the bot chat: "what does this project do?" | A short answer based on your repo + Brain |
| 5 | In the bot chat: `plan for <JIRA-KEY>` (a small ticket assigned to you) | "On it", then the full plan with choices 1 / 2 / 3 |
| 6 | Reply `1` (or `yes`) | Code is built and tested on a separate branch; any doubt comes as a question with options; then "Built and tested – raise the PR?" |
| 7 | Reply `2`, then what to change | It re-plans / reworks using your feedback |
| 7a | Reply `1` to "raise the PR?" | A draft PR is raised and its link is posted in the chat |
| 7b | `add <some small feature>` (no ticket) | `TASK-n`: questions about the requirements, a summary to confirm, then the normal plan → PR flow |
| 7c | In Claude Code (inside the project folder): `what's the status of <JIRA-KEY>?` | Answers from the same task ("implementing and testing, attempt 1 of 3") |
| 8 | `/ai-workforce:aiw-inbox` and `aiw dashboard` | Same items in Claude Code and the local web page |
| 9 | Close Claude Code, assign yourself a ticket in Jira | Within ~5 minutes the bot messages you |

Your own files are never touched – all work happens in separate git worktrees (`~/.ai-workforce/worktrees`).

## 6. Useful commands

```
aiw status · aiw inbox · aiw tasks · aiw show <task> · aiw approve <task> · aiw reject <task> "reason"
aiw pause / aiw resume-all · aiw dashboard · aiw cost · aiw ask "question" · aiw doctor
aiw service start|stop|status · aiw uninstall [--purge]
```

## 7. Reporting problems

Please send: what you did, what you expected, what happened, plus
- `aiw status --json` output
- the last lines of `C:\Users\<you>\.ai-workforce\logs\aiw-agentd.log`

Never share tokens, API keys or the contents of `~/.ai-workforce` – they contain your credentials' references and project data.

## 8. Remove everything

```
aiw uninstall --purge
```
Then in Claude Code: `/plugin uninstall ai-workforce`.
