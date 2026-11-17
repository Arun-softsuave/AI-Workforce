import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { paths, ensureBaseDirs } from "../core/paths.js";
import { db, audit } from "../core/db.js";
import { loadSettings, saveSettings, updateSettings, loadProjects, upsertProject, removeProject, getProject, normaliseProject, type Channel } from "../core/config.js";
import { setSecret, deleteSecret, ALL_SECRETS } from "../core/secrets.js";
import { ROLES, recommendConnectors } from "../core/roles.js";
import { nowIso } from "../core/util.js";
import { readRuntime, pidAlive, api, kick } from "../core/runtime.js";
import { connect, disconnect, listConnections, PROVIDERS, type Provider } from "../connectors/registry.js";
import { isGitRepo, git } from "../git/git.js";
import { statusSnapshot, taskDetail, tasksList, inboxView, inboxSummaryLine, cost } from "../api/ops.js";
import { decideAndApply, cancelTask, resumeTask, refreshTask, startAwaiting, pauseAll, resumeAll } from "../engine/engine.js";
import { markInboxRead, notify } from "../notify/router.js";
import { desktopToast } from "../notify/channels.js";
import { onboardProject, confirmBrain, brainSummary, askBrain, refreshProject } from "../brain/brain.js";
import { runTicket } from "../intake/intake.js";
import { installAutostart, uninstallAutostart, startService, stopService, autostartInstalled } from "../daemon/service.js";
import { detectStack } from "../brain/codemap.js";

const CLAUDE_LOGIN_WARNING = `Using your Claude Code login for background work:
  • Background agents run with the account you are signed into in Claude Code – no API key is stored.
  • Their usage counts against YOUR Claude plan limits; heavy background work can slow your own Claude Code use.
  • Anthropic's docs ask products built on the Agent SDK to use API keys. Check your plan's terms before relying on this,
    and do not use this option when sharing the plugin with others – they should use their own API key.
  • Switch any time: aiw model --provider claude --key-stdin   or   aiw model --provider mock`;

type Args = { _: string[]; [k: string]: string | boolean | string[] };

export function parseArgs(argv: string[]): Args {
  const a: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const [k, v] = t.slice(2).split("=", 2);
      if (v !== undefined) a[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) a[k] = argv[++i];
      else a[k] = true;
    } else a._.push(t);
  }
  return a;
}

const out = (o: unknown, json: boolean) => console.log(json ? JSON.stringify(o, null, 2) : typeof o === "string" ? o : JSON.stringify(o, null, 2));
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const list = (v: unknown) => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean) : []);

function progress(step: string, status: "done" | "skipped" | "pending" | "failed", detail?: string): void {
  db().prepare("INSERT INTO setup_progress (step,status,detail,updated_at) VALUES (?,?,?,?) ON CONFLICT(step) DO UPDATE SET status=excluded.status, detail=excluded.detail, updated_at=excluded.updated_at")
    .run(step, status, detail ?? null, nowIso());
}

async function readStdin(prompt = "Paste the secret and press Enter (input is hidden): ", multiline = false): Promise<string> {
  if (process.stdin.isTTY) {
    // Interactive terminal: hidden prompt, so the secret is never echoed or kept in shell history.
    process.stdout.write(prompt);
    return new Promise((resolve) => {
      const stdin = process.stdin;
      let value = "";
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding("utf8");
      let lastCr = false;
      const onData = (ch: string) => {
        for (const c of ch) {
          if (c !== "\r" && c !== "\n") lastCr = false;
          // multi-line paste: a line break is kept; an empty line (Enter twice), Ctrl+Z or Ctrl+D ends the input
          if (multiline && (c === "\r" || c === "\n")) {
            const pairedLf = c === "\n" && lastCr;
            lastCr = c === "\r";
            if (pairedLf) continue;                                   // the \n of a Windows \r\n line break
            if (value === "" || value.endsWith("\n")) {
              stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
              process.stdout.write("\n");
              return resolve(value.trim());
            }
            value += "\n";
            continue;
          }
          if (c === "\r" || c === "\n" || c === "\u0004" || c === "\u001a") {
            stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData);
            process.stdout.write("\n");
            return resolve(value.trim());
          }
          if (c === "\u0003") { stdin.setRawMode(false); process.stdout.write("\n"); process.exit(130); }
          if (c === "\u0008" || c === "\u007f") value = value.slice(0, -1);
          else value += c;
        }
      };
      stdin.on("data", onData);
    });
  }
  let d = "";
  for await (const c of process.stdin) d += c;
  return d.trim();
}

const SETUP_STEPS = ["prereqs", "service", "model", "profile", "connectors", "notifications", "project", "team", "documents", "brain", "preferences", "ready", "live"] as const;

const HELP = `AI Workforce – local AI team member

Setup
  aiw setup                         Show onboarding progress and the next step (resumable)
  aiw doctor                        Check prerequisites (Node, git, disk, network, proxy)
  aiw doctor <project> [--smoke] [--verbose]   Can this project's tests run here? (versions, packages, .env names, database)
  aiw service install|start|stop|status|uninstall
  aiw model --provider claude|claude-login|mock [--key-stdin] [--small ID --medium ID --large ID]
                                    claude = API key · claude-login = your Claude Code login · mock = offline dry run
  aiw profile --name N --roles r1,r2 [--tz Area/City] [--hours 09:00-18:00]
  aiw roles                         List roles and recommended connectors
  aiw connect jira   [--site host] [--relogin]   Sign in with your Atlassian account in the browser (no API token)
  aiw connect notion [--relogin]                 Sign in with your Notion account in the browser (no integration token)
  aiw connect github [--relogin]                 Sign in to GitHub in the browser with a one-time code (no token)
  aiw connect figma                              Paste a Figma personal access token in a local page (recommended)
  aiw connect figma --desktop                    Use the Figma desktop app's MCP server instead (no token; app must be open)
  aiw connect <tool> --browser      Fallback: enter a token / URL in a local page (secrets never pass through the chat)
  aiw connect <jira|github|slack|teams|notion|figma> [--site --email --token-stdin --from-gh --user-id --webhook-stdin]
                                    Slack and work Teams always need an app token / webhook URL (no browser sign-in exists)
  aiw connect teams-personal [--chat "name" | --chat-id ID | --list-chats | --relogin]
  aiw connect teams-personal --bot [--owner "your name"] [--relogin]
                                    sign in as a separate bot account; notifications come from the bot, only you can command
                                    Two-way personal Teams (teams.live.com): notifications + "aiw approve …" replies
  aiw disconnect <tool>             aiw connections
  aiw notify --primary slack|teams|teams-personal|desktop|inbox [--fallback desktop,inbox] [--quiet 20:00-08:00] [--digest 09:00] [--jira-comments on|off]
  aiw notify test
  aiw project add --id ID --path DIR [--jira-site S --jira-keys PAY,CORE] [--repo owner/name --base main]
                  [--roles r1,r2] [--autonomy observe|plan|prepare|publish-drafts] [--test-cmd CMD] [--install-cmd CMD] [--related a,b]
                  [--group NAME]  repos with the same group share one Jira project; triage picks backend/frontend/both
  aiw project list|show <id>|remove <id>|set <id> --autonomy X
  aiw brain onboard <project> [--no-ai] [--full] | confirm <project> | show <project> | ask <project> "question" | rebuild <project>
  aiw conventions detect|show|confirm <project>   team rules: base branch, branch/commit style, rule files, PR template, checks
  aiw graph [status|install|build [project]|query <project> "<q>"]   code graphs (Graphify, code only, no AI tokens) the agents search first
  aiw conventions set <project> [--base dev] [--branch "{type}/{key}/{slug}"] [--commit "{type}({scope}): {summary} {key}"] [--checks "a;;b"]
  aiw brain add-doc <project> <file.pdf|.docx|.md|.txt> [--title T] [--private]   store a PRD / requirements doc in the Brain
  aiw brain docs <project>          list stored documents
  aiw setup skip <step>             mark an optional onboarding step as skipped
  aiw team detect <project>         suggest teammates (GitHub contributors, git history) and CODEOWNERS
  aiw team add --github LOGIN [--name N --email E] | remove <login> | me --github LOGIN | list
  aiw team reviewers <project> --codeowners | --list login1,org/team | --none
  aiw prefs [--draft-pr yes|no] [--auto-fix-ci yes|no] [--plan-approval ask|skip] [--pr-approval ask|skip]
            [--auto-review yes|no] [--auto-post-review yes|no] [--auto-qa-issues yes|no] [--parallel N]
  aiw ready [project]               ready check: GitHub access, lint/format tools, test runner + temporary database, screenshots, CI
  aiw tickets refresh | find "text" open Jira tickets by name (what Teams uses for "the invite email task")

Daily use
  aiw status | inbox [--all] | tasks [--state S] | show <ticket>
  aiw approve <ticket> | reject <ticket> "reason" | answer [<ticket>] "answer" | run <ticket> | start <ticket|all>
  aiw cancel <ticket> | resume <ticket> | refresh <ticket> | pause [--until ISO] | resume-all
  aiw poll | cost [--days 7] | dashboard | statusline | uninstall [--purge]
  aiw dashboard [--no-open]         Open the live dashboard in your browser (works only on this computer)
  aiw bench [report]                Token and cost baseline: costly steps, agents and tickets
  aiw bench runs | plan <tickets…> | compare <runA> <runB> | mark <runId> <ticket> yes|no
  aiw items [--all] [<ticket>]      Work items as a tree (epic → ticket → parts), with the job each one runs
  aiw explain <ticket>              Why it is where it is: design document, decisions, merge order, holds, last steps, rules
  aiw design <ticket> [path|show]   The item's design document (summary, file path, or the whole text)
  aiw adopt <branch|PR> --ticket KEY [--project id]   Finish your own branch: your commits stay, mine go on top (engine v2)
  aiw learned [<project>] | add|skip|remove <project> R1   Rule ideas from repeated review comments (rules card)
  aiw bench gate <runA> <runB> | overrides   Keep a cheaper model / effort only when accuracy holds
  aiw rules                         Standing rules in force ("no plan approval for KAN-45", "only backend"…)
  aiw rules add <rule> <value> [--ref KAN-45 | --scope global|item|batch|epic|sprint] [--until ISO]
                                    rules: plan_approval|pr_approval|start_approval|create_issues|create_tickets (skip|ask),
                                    auto_fix_ci|auto_resolve|post_review|no_questions (yes|no), only|dont_touch (area), budget_tokens (N)
  aiw rules remove <id>             Back to normal for that rule
  aiw config engine v1|v2           Which engine runs the work (v2: the kernel – items, events, jobs, recipes)
  aiw ask "question"                Ask the project assistant (same one that answers in Teams)
  aiw chat [--daily-tokens N] [--new]   Chat assistant budget / start a fresh conversation
Add --json to any command for machine-readable output.`;

export async function main(argv: string[]): Promise<number> {
  ensureBaseDirs();
  const a = parseArgs(argv);
  const json = !!a.json;
  const [cmd, sub, third] = a._;
  switch (cmd) {
    case undefined: case "help": case "--help": console.log(HELP); return 0;

    // ------------------------------------------------------------ setup
    case "setup": {
      if (sub === "skip" && third) { progress(third, "skipped", str(a.reason) ?? "skipped by user"); out(`Skipped ${third}.`, json); return 0; }
      const rows = db().prepare("SELECT step, status, detail FROM setup_progress").all() as any[];
      const map = new Map(rows.map((r) => [r.step, r]));
      // Connectors can be added from the CLI or the browser page – always show the live list.
      const live = listConnections().filter((c) => c.status === "connected" || c.status === "pending-admin");
      if (live.length) map.set("connectors", { step: "connectors", status: "done", detail: live.map((c) => c.provider).join(", ") });
      const steps = SETUP_STEPS.map((s) => ({ step: s, status: map.get(s)?.status ?? "pending", detail: map.get(s)?.detail ?? null }));
      const next = steps.find((s) => s.status === "pending" || s.status === "failed");
      const s = loadSettings();
      out(json ? { steps, next: next?.step ?? null, roles: s.profile.roles, recommended: recommendConnectors(s.profile.roles) }
        : `Onboarding progress\n${steps.map((x) => `  [${x.status === "done" ? "x" : x.status === "skipped" ? "-" : " "}] ${x.step}${x.detail ? ` – ${x.detail}` : ""}`).join("\n")}\n\nNext step: ${next?.step ?? "none – you're live"}`, json);
      return 0;
    }
    case "doctor": {
      // "aiw doctor <project>": can this repository's tests run here? (Python/Node version, packages, .env names, database)
      if (sub) return envDoctorCmd(sub, !!a.smoke, !!a.verbose, json);
      const checks = await doctor();
      progress("prereqs", checks.every((c) => c.ok || !c.required) ? "done" : "failed", checks.filter((c) => !c.ok).map((c) => c.name).join(", ") || undefined);
      out(json ? checks : [checks.map((c) => `${c.ok ? "OK  " : c.required ? "FAIL" : "WARN"}  ${c.name}${c.detail ? ` – ${c.detail}` : ""}`).join("\n"),
        loadProjects().length ? `\nCheck a project's local setup: aiw doctor <${loadProjects().map((p) => p.id).join("|")}>` : ""].join("\n").trimEnd(), json);
      return checks.some((c) => !c.ok && c.required) ? 1 : 0;
    }
    case "bench": {
      const B = await import("../bench/benchmark.js");
      if (!sub || sub === "report") {
        const r = B.baselineReport(undefined, { since: str(a.since) });
        out(json ? r : B.renderBaseline(r), json); return 0;
      }
      if (sub === "compare") {
        const [x, y] = [third, a._[3]];
        if (!x || !y) { out("Usage: aiw bench compare <runA> <runB>   (aiw bench runs lists them)", json); return 1; }
        const c = B.compareRuns(x, y);
        out(json ? c : B.renderComparison(c), json); return 0;
      }
      if (sub === "runs") {
        const runs = B.listBenchmarkRuns();
        out(json ? runs : runs.length ? runs.map((r) => `${r.runId}  v${r.version}  ${r.tickets} ticket(s)  ${B.fmtUsd(r.cost)}  ${r.createdAt}`).join("\n") : "No benchmark runs yet.", json); return 0;
      }
      if (sub === "plan") {
        const tickets = a._.slice(2);
        if (!tickets.length) { out("Usage: aiw bench plan KAN-40 KAN-52 …", json); return 1; }
        const p = B.benchmarkPlan(tickets);
        out(json ? p : p.text, json); return 0;
      }
      if (sub === "mark") {
        const [run, ticket, verdict] = a._.slice(2);
        if (!run || !ticket || !/^(yes|no)$/i.test(verdict ?? "")) { out("Usage: aiw bench mark <runId> <ticket> yes|no", json); return 1; }
        const ok = B.markAccepted(run, ticket, /^yes$/i.test(verdict));
        out(ok ? "Saved." : `No row for ${ticket} in run ${run}.`, json); return ok ? 0 : 1;
      }
      if (sub === "gate") {
        // §9.1.8: a cheaper model / effort is kept only when accuracy and questions hold and it is really cheaper
        const [x, y] = [third, a._[3]];
        if (!x || !y) { out("Usage: aiw bench gate <runBefore> <runAfter>", json); return 1; }
        const g = B.acceptSavingRuns(x, y);
        out(json ? g : g.text, json); return 0;
      }
      if (sub === "overrides") {
        const O = await import("../bench/overrides.js");
        out(json ? O.listOverrides() : O.renderOverrides(), json); return 0;
      }
      out("Usage: aiw bench [report|runs|plan <tickets…>|compare <runA> <runB>|gate <runA> <runB>|overrides|mark <runId> <ticket> yes|no]", json); return 1;
    }
    case "service": {
      if (sub === "install") {
        const f = installAutostart();
        const r = await startService();
        progress("service", r.started || /already/.test(r.message) ? "done" : "failed", r.message);
        out({ autostart: f, ...r }, json); return 0;
      }
      if (sub === "start") { out(await startService(), json); return 0; }
      if (sub === "stop") { out(await stopService(), json); return 0; }
      if (sub === "uninstall") { await stopService(); uninstallAutostart(); out("Service stopped and autostart removed.", json); return 0; }
      const rt = readRuntime();
      const alive = !!rt && pidAlive(rt.pid);
      out({ running: alive, pid: alive ? rt!.pid : null, port: alive ? rt!.port : null, autostart: autostartInstalled(), logs: path.join(paths.logs(), "aiw-agentd.log") }, json);
      return 0;
    }
    case "model": {
      const provider = str(a.provider) as "claude" | "claude-login" | "mock" | undefined;
      if (provider && !["claude", "claude-login", "mock"].includes(provider)) { out("Provider must be claude, claude-login or mock.", json); return 1; }
      const s = updateSettings((x) => {
        if (provider) x.models.provider = provider;
        if (str(a.small)) x.models.small = str(a.small)!;
        if (str(a.medium)) x.models.medium = str(a.medium)!;
        if (str(a.large)) x.models.large = str(a.large)!;
      });
      if (a["key-stdin"]) {
        const key = await readStdin();
        if (!key) { out("No key on stdin.", json); return 1; }
        const test = await testAnthropicKey(key, s.models.small);
        if (!test.ok) { progress("model", "failed", test.detail); out(`API key rejected: ${test.detail}`, json); return 1; }
        setSecret("anthropic.apiKey", key);
      }
      if (s.models.provider === "claude-login") {
        if (!json) console.log(CLAUDE_LOGIN_WARNING);
        if (!a["skip-test"]) {
          const { testAgentAuth } = await import("../agents/runner.js");
          const t = await testAgentAuth();
          if (!t.ok) {
            progress("model", "failed", `Claude Code login test failed: ${t.detail}`);
            out(`Claude Code login could not be used: ${t.detail}\nMake sure \`claude\` is installed and you are logged in (run \`claude\` then /login), or use an API key.`, json);
            return 1;
          }
        }
        progress("model", "done", "Claude Code login (your Claude subscription)");
        out({ provider: "claude-login", small: s.models.small, medium: s.models.medium, large: s.models.large, auth: "Claude Code login" }, json);
        return 0;
      }
      const hasKey = s.models.provider === "mock" || !!process.env.ANTHROPIC_API_KEY || !!(await import("../core/secrets.js")).getSecret("anthropic.apiKey");
      progress("model", hasKey ? "done" : "pending", s.models.provider === "mock" ? "offline mock model (no AI calls)" : hasKey ? "Anthropic API key stored in OS vault" : "API key missing");
      out({ provider: s.models.provider, small: s.models.small, medium: s.models.medium, large: s.models.large, apiKey: s.models.provider === "mock" ? "not needed" : hasKey ? "stored" : "missing" }, json);
      return 0;
    }
    case "profile": {
      const roles = list(a.roles);
      const bad = roles.filter((r) => !ROLES.some((x) => x.id === r));
      if (bad.length) { out(`Unknown role(s): ${bad.join(", ")}. Run \`aiw roles\`.`, json); return 1; }
      const s = updateSettings((x) => {
        if (str(a.name)) x.profile.name = str(a.name)!;
        if (roles.length) x.profile.roles = roles;
        if (str(a.tz)) x.profile.timezone = str(a.tz);
        if (str(a.hours)) x.profile.workingHours = str(a.hours)!;
      });
      if (str(a.prefs)) { fs.mkdirSync(path.dirname(paths.globalPrefs()), { recursive: true }); fs.writeFileSync(paths.globalPrefs(), str(a.prefs)!); }
      progress("profile", s.profile.roles.length ? "done" : "pending", s.profile.roles.join(", "));
      out({ profile: s.profile, recommended: recommendConnectors(s.profile.roles) }, json);
      return 0;
    }
    case "roles": out(ROLES.map((r) => ({ id: r.id, label: r.label, recommended: r.recommended, optional: r.optional })), json); return 0;

    case "connect": {
      const p = sub as Provider;
      if (!PROVIDERS.includes(p)) { out(`Usage: aiw connect <${PROVIDERS.join("|")}>`, json); return 1; }
      if (p === "teams-personal") return connectTeamsPersonal(a, json);
      // Default for every tool that allows it: sign in with the browser, like Claude connects to MCP servers.
      // Tokens / URLs are only the fallback (--browser opens the local credentials page, --token-stdin reads one).
      const manual = !!(a.browser || a["token-stdin"] || a["webhook-stdin"] || a["bot-token-stdin"] || a["from-gh"] || a["pending-admin"] || (p === "jira" && a.email));
      if (p === "jira" && (a.oauth || !manual)) return connectJiraOAuth(a, json);
      if (p === "notion" && (a.oauth || !manual)) return connectNotionOAuth(a, json);
      if (p === "github" && !manual) return connectGitHubBrowser(a, json);
      if (p === "figma" && a.desktop) return connectFigmaDesktop(a, json);
      // a Figma token first (the docs' default): reads any file, app open or not; the desktop app only behind --desktop
      if (p === "figma") updateSettings((s) => { s.figma = { ...(s.figma ?? {}), mode: "token" }; });
      if (p === "figma" && !manual) return openConnectPage(p, json);
      if (a.browser) return openConnectPage(p, json);
      const secretFromStdin = a["token-stdin"] || a["webhook-stdin"] || a["bot-token-stdin"] ? await readStdin() : undefined;
      const res = await connect(p, {
        site: str(a.site), email: str(a.email), token: p === "slack" || p === "teams" ? undefined : secretFromStdin,
        fromGh: !!a["from-gh"], botToken: p === "slack" ? secretFromStdin : undefined, appToken: str(a["app-token"]),
        userId: str(a["user-id"]), webhookUrl: p === "teams" ? secretFromStdin : undefined, pendingAdmin: !!a["pending-admin"],
      });
      if (!res.ok && !secretFromStdin && !a["from-gh"] && !a["pending-admin"]) {
        out(`${res.detail}\nTip: run \`aiw connect ${p} --browser\` to enter credentials in a local page (they never pass through the chat).`, json);
        return 1;
      }
      const conns = listConnections().filter((c) => c.status === "connected" || c.status === "pending-admin");
      if (conns.length) progress("connectors", "done", conns.map((c) => `${c.provider}${c.status === "pending-admin" ? " (pending admin)" : ""}`).join(", "));
      out(res.ok ? `Connected ${p}: ${res.account ?? res.detail ?? ""}` : `Failed to connect ${p}: ${res.detail}`, json);
      return res.ok ? 0 : 1;
    }
    case "disconnect": { disconnect(sub as Provider); out(`Disconnected ${sub}.`, json); return 0; }
    case "connections": out(listConnections().map((c) => ({ provider: c.provider, account: c.account, status: c.status, updated: c.updated_at })), json); return 0;

    case "notify": {
      if (sub === "test") {
        const r = await notify({ kind: "info", title: "AI Workforce test notification", body: "If you can read this, notifications work.", dedupeKey: nowIso() }, new Date(Date.now()));
        progress("notifications", r.delivered.length ? "done" : "failed", r.delivered.length ? `delivered via ${r.delivered.join(", ")}` : "no channel delivered – check connections");
        out(r, json); return 0;
      }
      const s = updateSettings((x) => {
        if (str(a.primary)) x.notifications.primary = str(a.primary) as Channel;
        if (a.fallback) x.notifications.fallback = list(a.fallback) as Channel[];
        if (str(a.quiet)) x.notifications.quietHours = str(a.quiet) === "off" ? "off" : str(a.quiet);   // "off" must be stored explicitly, otherwise the default comes back
        if (str(a.digest)) x.notifications.digestTime = str(a.digest)!;
        if (str(a["jira-comments"])) x.notifications.jiraComments = str(a["jira-comments"]) === "on";
      });
      out(s.notifications, json); return 0;
    }

    case "project": return projectCmd(sub, third, a, json);
    case "graph": {
      // Code graphs (Graphify, code only – no AI tokens): aiw graph [status|install|build [project]|query <project> "<question>"]
      const G = await import("../brain/graph.js");
      const { loadProjects, getProject } = await import("../core/config.js");
      const action = sub ?? "status";
      if (action === "install") { const r = await G.installGraphify(); out(r.ok ? `Graphify ${r.detail}.` : `Graphify not installed: ${r.detail}`, json); return r.ok ? 0 : 1; }
      if (action === "build") {
        if (!G.graphifyBin()) { const r = await G.installGraphify(); if (!r.ok) { out(`Graphify not installed: ${r.detail}`, json); return 1; } }
        const list = third ? [getProject(third)].filter(Boolean) as any[] : loadProjects();
        for (const p of list) { const r = await G.buildGraph(p, { force: !!a.force }); out(`${p.id}: ${r.ok ? `built in ${Math.round(r.ms / 1000)} s` : `failed – ${r.detail}`}`, json); }
        return 0;
      }
      if (action === "query") {
        const q = (a._ as string[]).slice(3).join(" ").replace(/^"|"$/g, "");
        if (!third || !q) { out('Usage: aiw graph query <project> "<question>"', json); return 1; }
        out(await G.graphQuery(third, q), json); return 0;
      }
      const rows = loadProjects().map((p) => { const s = G.graphStatus(p); return { project: p.id, built: s.built, upToDate: s.current, at: s.at }; });
      out(json ? { installed: !!G.graphifyBin(), projects: rows } : [`Graphify: ${G.graphifyBin() ? "installed" : "not installed (aiw graph install)"}`, ...rows.map((r) => `${r.project}: ${r.built ? (r.upToDate ? "up to date" : "out of date – refreshing in the background") : "not built (aiw graph build)"}${r.at ? ` · ${r.at.slice(0, 16).replace("T", " ")}` : ""}`)].join("\n"), json);
      return 0;
    }
    // ------------------------------------------------------------ team, preferences, ready check, ticket index
    case "team": {
      const T = await import("../core/team.js");
      if (sub === "detect") {
        const p = third ? getProject(third) : undefined;
        if (!p) { out("Usage: aiw team detect <project>", json); return 1; }
        const t = await T.suggestTeam(p);
        if (t.me) updateSettings((x) => { x.team.me = { ...(x.team.me ?? {}), github: t.me }; });
        out(json ? t : [
          `You: ${t.me ? `@${t.me}` : "unknown (GitHub not connected)"}`,
          `People who worked on ${p.github?.repo ?? p.id} recently:`,
          ...t.members.map((m) => `  @${m.github}${m.name ? ` – ${m.name}` : ""} (${m.commits} commits)`),
          t.codeownersFile ? `CODEOWNERS: ${t.codeowners.map((o) => `@${o}`).join(", ")}` : "CODEOWNERS: none in this repository",
          "", `Add teammates: aiw team add --github LOGIN --name "Name"`, `Reviewers:     aiw team reviewers ${p.id} ${t.codeownersFile ? "--codeowners" : "--list login1,login2"}`,
        ].join("\n"), json);
        return 0;
      }
      if (sub === "add") {
        const login = str(a.github)?.replace(/^@/, "");
        if (!login) { out("Usage: aiw team add --github LOGIN [--name N] [--email E]", json); return 1; }
        const s = updateSettings((x) => {
          x.team.members = [...x.team.members.filter((m) => m.github.toLowerCase() !== login.toLowerCase()), { github: login, name: str(a.name) ?? login, email: str(a.email) }];
        });
        progress("team", "done", s.team.members.map((m) => m.name).join(", "));
        out(s.team, json); return 0;
      }
      if (sub === "remove" && third) { const s = updateSettings((x) => { x.team.members = x.team.members.filter((m) => m.github.toLowerCase() !== third.replace(/^@/, "").toLowerCase()); }); out(s.team, json); return 0; }
      if (sub === "me") { const login = str(a.github)?.replace(/^@/, ""); if (!login) { out("Usage: aiw team me --github LOGIN", json); return 1; } out(updateSettings((x) => { x.team.me = { github: login }; }).team, json); return 0; }
      if (sub === "reviewers") {
        const p = third ? getProject(third) : undefined;
        if (!p) { out("Usage: aiw team reviewers <project> --codeowners | --list a,b | --none", json); return 1; }
        if (a.none) p.reviewers = undefined;
        else if (a.codeowners) {
          if (!T.readCodeowners(p.local.path).length) { out(`${p.id} has no CODEOWNERS file – use --list login1,login2`, json); return 1; }
          p.reviewers = { from: "codeowners", logins: [] };
        } else if (list(a.list).length) p.reviewers = { from: "list", logins: list(a.list).map((l) => l.replace(/^@/, "")) };
        else { out("Give --codeowners, --list login1,login2 or --none", json); return 1; }
        upsertProject(p);
        progress("team", "done", `${p.id}: reviewers ${p.reviewers ? (p.reviewers.from === "codeowners" ? "from CODEOWNERS" : p.reviewers.logins.join(", ")) : "none"}`);
        out({ project: p.id, reviewers: p.reviewers ?? null }, json); return 0;
      }
      const s = loadSettings();
      out(json ? { team: s.team, reviewers: Object.fromEntries(loadProjects().map((p) => [p.id, p.reviewers ?? null])) } : [
        `You: ${s.team.me?.github ? `@${s.team.me.github}` : "not set"}`,
        `Team: ${s.team.members.map((m) => `${m.name} (@${m.github})`).join(", ") || "nobody yet – aiw team detect <project>"}`,
        ...loadProjects().map((p) => `${p.id} reviewers: ${p.reviewers ? (p.reviewers.from === "codeowners" ? "CODEOWNERS" : p.reviewers.logins.join(", ")) : "none"}`),
      ].join("\n"), json);
      return 0;
    }
    case "prefs": {
      const yn = (k: string): boolean | undefined => { const v = str(a[k]); return v === undefined ? undefined : /^(y|yes|on|true|1)$/i.test(v); };
      const bad = ["plan-approval", "pr-approval"].find((k) => str(a[k]) && !["ask", "skip", ...(k === "plan-approval" ? ["autonomy"] : [])].includes(str(a[k])!));
      if (bad) { out(`--${bad} must be ask or skip`, json); return 1; }
      const s = updateSettings((x) => {
        const set = <K extends keyof typeof x.pr>(k: K, v: boolean | undefined) => { if (v !== undefined) x.pr[k] = v as any; };
        set("draft", yn("draft-pr")); set("autoFixCi", yn("auto-fix-ci")); set("autoReview", yn("auto-review"));
        set("autoPostReview", yn("auto-post-review")); set("autoQaIssues", yn("auto-qa-issues"));
        const plan = str(a["plan-approval"]); if (plan) x.workflow.planApproval = plan === "ask" ? "always" : plan as any;
        const pr = str(a["pr-approval"]); if (pr) x.workflow.prApproval = pr as any;
        const n = Number(str(a.parallel)); if (Number.isFinite(n) && n >= 1 && n <= 10) x.limits.maxParallel = Math.round(n);
      });
      const summary = {
        pullRequests: s.pr.draft ? "draft" : "ready for review", planApproval: s.workflow.planApproval === "skip" ? "not asked" : "asked",
        prApproval: s.workflow.prApproval === "skip" ? "not asked" : "asked", ciFailures: s.pr.autoFixCi ? "fixed and pushed without asking" : "fix shown first",
        whenAskedToReview: s.pr.autoReview ? "review straight away" : "tell me and wait", reviewComments: s.pr.autoPostReview ? "posted directly" : "shown first",
        qaFindings: s.pr.autoQaIssues ? "GitHub issues created directly" : "shown first", tasksAtOnce: s.limits.maxParallel,
      };
      if (Object.keys(a).some((k) => k !== "_" && k !== "json")) progress("preferences", "done", `PRs ${summary.pullRequests}; CI ${s.pr.autoFixCi ? "auto-fixed" : "shown first"}; plan ${summary.planApproval}; PR ${summary.prApproval}`);
      out(json ? summary : Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join("\n"), json);
      return 0;
    }
    case "ready": {
      const R = await import("../engine/ready.js");
      const reports = sub ? [await R.readyCheck(sub)] : (await R.readyAll()).reports;
      const global = R.globalReady();
      const fails = [...global, ...reports.flatMap((r) => r.items)].filter((i) => i.state === "fail").length;
      progress("ready", "done", fails ? `${fails} thing(s) to fix – run aiw ready` : "all set");
      out(json ? { global, reports } : R.readyText(reports, global), json);
      return 0;
    }
    case "tickets": {
      const TI = await import("../intake/ticketIndex.js");
      if (sub === "refresh") { out({ indexed: await TI.refreshTicketIndex(true) }, json); return 0; }
      if (sub === "find" && third) { const hits = TI.findTickets(a._.slice(2).join(" "), 8); out(json ? hits : hits.map((t) => `${t.key}  ${t.title}  [${t.status}${t.mine ? ", yours" : ""}]  score ${t.score}`).join("\n") || "No matching open ticket.", json); return 0; }
      const all = TI.ticketIndex();
      out(json ? all : `${all.length} open tickets indexed (${all.filter((t) => t.mine).length} assigned to you).\n${all.filter((t) => t.mine).slice(0, 20).map((t) => `${t.key}  ${t.title}  [${t.status}]`).join("\n")}`, json);
      return 0;
    }

    case "conventions": {
      const C = await import("../brain/conventions.js");
      const id = third;
      if (!id || !["detect", "show", "confirm", "set"].includes(sub ?? "")) { out("Usage: aiw conventions detect|show|confirm|set <project> [--base dev --branch \"{type}/{key}/{slug}\" --commit \"{type}({scope}): {summary} {key}\" --checks \"cmd1;;cmd2\"]", json); return 1; }
      if (sub === "detect") { const c = await C.detectConventions(id); progress("conventions", "pending", `${id}: detected – confirm with aiw conventions confirm ${id}`); out(json ? c : C.conventionsSummary(c), json); return 0; }
      if (sub === "confirm") { C.confirmConventions(id); out("Conventions confirmed.", json); return 0; }
      if (sub === "set") {
        const o: any = {};
        if (str(a.base)) o.baseBranch = str(a.base);
        if (str(a.branch)) o.branchTemplate = str(a.branch);
        if (str(a.commit)) o.commitTemplate = str(a.commit);
        if (str(a.checks)) o.checks = str(a.checks)!.split(";;").map((x) => x.trim()).filter(Boolean);
        const c = C.setConventionOverride(id, o);
        out(json ? c : C.conventionsSummary(c), json); return 0;
      }
      out(json ? getProject(id)?.conventions : C.conventionsSummary(getProject(id)?.conventions), json); return 0;
    }

    case "brain": {
      const id = third;
      if (!id && sub !== "list") { out("Usage: aiw brain onboard|confirm|show|ask|rebuild <project>", json); return 1; }
      if (sub === "onboard") {
        const viaService = await api("POST", `/api/brain/${id}/onboard`, { ai: !a["no-ai"], full: !!a.full }, 30 * 60_000).catch(() => undefined);
        const r = viaService ?? await onboardProject(id, { useAi: !a["no-ai"], full: !!a.full }).then((x) => ({ files: x.map.files.length, facts: x.facts, tokens: x.tokens, mode: x.mode }));
        progress("brain", "done", `${id}: ${r.files} files mapped, ${r.facts} facts – review with \`aiw brain show ${id}\` then \`aiw brain confirm ${id}\``);
        out({ ...r, next: `Review ${path.join(getProject(id)!.local.path, ".ai-workforce", "knowledge")} then run: aiw brain confirm ${id}` }, json);
        return 0;
      }
      if (sub === "confirm") { out({ confirmed: confirmBrain(id) }, json); return 0; }
      if (sub === "add-doc") {
        const file = a._[3];
        if (!file) { out("Usage: aiw brain add-doc <project> <file.pdf|.docx|.md|.txt> [--title T] [--private]", json); return 1; }
        const p = getProject(id);
        if (!p) { out(`No project ${id}`, json); return 1; }
        const targets = p.group ? loadProjects().filter((x) => x.group === p.group).map((x) => x.id) : [id];
        const { addDocument } = await import("../brain/docs.js");
        const res = await addDocument(targets, path.resolve(file), { title: str(a.title), private: !!a.private });
        progress("documents", "done", `${res[0].title} → ${targets.join(", ")}`);
        out(json ? res : res.map((r) => `Stored "${r.title}" for ${r.project}: ${r.sections} sections, ${r.chars.toLocaleString()} chars${r.facts ? `, ${r.facts} facts proposed` : ""}${r.private ? " (private – not in the repo)" : ""}\n  ${r.file}`).join("\n"), json);
        return 0;
      }
      if (sub === "docs") {
        const { listDocuments } = await import("../brain/docs.js");
        out(listDocuments(id), json); return 0;
      }
      if (sub === "show") { out(brainSummary(id), json); return 0; }
      if (sub === "ask") { out(askBrain(id, a._.slice(3).join(" ")), json); return 0; }
      if (sub === "rebuild") { refreshProject(id); out("Map and index rebuilt.", json); return 0; }
      return 1;
    }

    // ------------------------------------------------------------ daily use
    case "status": {
      const s = statusSnapshot();
      const rt = readRuntime();
      const alive = !!rt && pidAlive(rt.pid);
      if (json) { out({ service: alive ? { pid: rt!.pid, port: rt!.port } : null, ...s }, true); return 0; }
      console.log([
        `Service: ${alive ? `running (pid ${rt!.pid}, port ${rt!.port})` : "NOT RUNNING – run `aiw service start`"}${s.paused ? ` · PAUSED until ${s.paused}` : ""}`,
        `Model: ${s.provider}${s.provider === "mock" ? " (offline – no real AI work)" : ""}`,
        `Connections: ${s.connections.map((c) => `${c.provider}=${c.status}`).join(", ") || "none"}`,
        `Projects: ${s.projects.map((p) => `${p.id} [${(p.jira ?? []).join(",")}] ${p.autonomy}`).join("; ") || "none"}`,
        `Tasks: ${Object.entries(s.tasks).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`,
        `Last check: ${s.lastPoll ? `${s.lastPoll.at}${s.lastPoll.errors?.length ? ` (errors: ${s.lastPoll.errors.join("; ")})` : ""}` : "never"}`,
        inboxSummaryLine(),
      ].join("\n"));
      return 0;
    }
    case "inbox": {
      const items = inboxView(!!a.all);
      out(json ? items : items.length ? items.map((i) => `• [${i.kind}] ${i.title}\n  ${String(i.body ?? "").split("\n").join("\n  ")}`).join("\n") : "Inbox is empty – nothing needs your attention.", json);
      return 0;
    }
    case "tasks": {
      const t = tasksList(a.state ? list(a.state) : undefined, 50);
      out(json ? t : t.map((x) => `${(x.ref ?? x.id).padEnd(14)} ${x.state.padEnd(18)} ${x.size ?? "-"}  ${x.title ?? ""}${x.pr ? `  ${x.pr}` : ""}`).join("\n") || "No tasks yet.", json);
      return 0;
    }
    case "show": {
      const d = taskDetail(sub);
      if (!d) { out(`No task for ${sub}`, json); return 1; }
      out(json ? d : [`${d.ref} – ${d.title}`, `State: ${d.state}  Size: ${d.size}  Playbook: ${d.playbook}  Tokens: ${d.tokens}`,
        d.ticketUrl ? `Ticket: ${d.ticketUrl}` : "", d.pr ? `PR: ${d.pr}` : "", d.error ? `Error: ${d.error}` : "",
        d.questions ? `Questions: ${d.questions.join(" / ")}` : "",
        d.approval ? `Approval: ${d.approval.action} ${d.approval.state}${d.approval.head ? ` (commit ${d.approval.head})` : ""}` : "",
        "Steps:", ...d.steps.map((s) => `  - ${s.name}: ${s.status}${s.note ? ` – ${s.note}` : ""}${s.error ? ` – ${s.error}` : ""}`),
        d.report ? `\n${d.report}` : ""].filter(Boolean).join("\n"), json);
      return 0;
    }
    case "approve": case "reject": {
      const reason = cmd === "reject" ? a._.slice(2).join(" ") || str(a.reason) || "Rejected without a reason" : undefined;
      const viaService = await api("POST", `/api/${cmd}/${encodeURIComponent(sub)}`, { reason, approver: loadSettings().profile.name || os.userInfo().username, channel: "claude-code" }).catch((e) => ({ ok: false, message: e.message }));
      const r = viaService ?? await decideAndApply(sub, cmd === "approve" ? "approved" : "rejected", loadSettings().profile.name || os.userInfo().username, "claude-code", reason);
      out(r.message + (viaService ? "" : " (service not running – it will continue when started)"), json);
      return r.ok ? 0 : 1;
    }
    case "run": {
      const viaService = await api("POST", "/api/tasks/run", { key: sub }, 60_000).catch((e) => { throw e; });
      if (viaService) { out(`Started ${viaService.ref} (${viaService.task}).`, json); return 0; }
      const t = await runTicket(sub);
      out(`Queued ${t.source_ref} (${t.id}) – it will start when the service runs.`, json);
      return 0;
    }
    case "answer": {
      const looksLikeRef = !!sub && /^[A-Z][A-Z0-9]+-\d+(@[\w-]+)?$|^t_[0-9a-f]+$/i.test(sub);
      const text = (looksLikeRef ? a._.slice(2) : a._.slice(1)).join(" ");
      const viaService = await api("POST", "/api/answer", { ref: looksLikeRef ? sub : undefined, answer: text, by: loadSettings().profile.name || os.userInfo().username }).catch(() => undefined);
      const { answerTask } = await import("../engine/engine.js");
      const r = viaService ?? await answerTask(looksLikeRef ? sub : undefined, text, loadSettings().profile.name || os.userInfo().username);
      out(r.message, json); return r.ok ? 0 : 1;
    }
    case "qa": case "fix": {
      // aiw qa account <project> <email> – the demo login QA uses for the live local app (password asked hidden, kept in the OS vault)
      if (cmd === "qa" && sub === "account") {
        const { setSecret, deleteSecret } = await import("../core/secrets.js");
        const projectId = a._[2] ? String(a._[2]) : "";
        const email = a._[3] ? String(a._[3]) : "";
        if (!projectId || !getProject(projectId)) { out("Usage: aiw qa account <project> <email>   (or: aiw qa account <project> --remove)", json); return 1; }
        if (a.remove) { deleteSecret(`qa.${projectId}.email`); deleteSecret(`qa.${projectId}.password`); out(`Removed the QA demo account of ${projectId}.`, json); return 0; }
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) { out("Give the demo account's email: aiw qa account <project> <email>", json); return 1; }
        const password = (await readStdin("Password of the demo account (input is hidden): ")).trim();
        if (!password) { out("No password given – nothing saved.", json); return 1; }
        setSecret(`qa.${projectId}.email`, email);
        setSecret(`qa.${projectId}.password`, password);
        if (a.totp) {
          const secret = (await readStdin("Authenticator (TOTP) secret of the demo account – the base32 key shown when MFA was set up (input is hidden): ")).trim();
          if (secret) setSecret(`qa.${projectId}.totp`, secret.replace(/\s/g, ""));
        }
        out(`Saved the QA demo account for ${projectId} (${email})${a.totp ? " with its authenticator secret" : ""} in the OS credential vault. QA and the PR screenshots use it for the live local app.`, json);
        return 0;
      }
      // aiw qa token <project> – a signed-in session (access [refresh]) for the live local app; renewed automatically
      if (cmd === "qa" && sub === "token") {
        const projectId = a._[2] ? String(a._[2]) : "";
        if (!projectId || !getProject(projectId)) { out("Usage: aiw qa token <project>", json); return 1; }
        const { parseTokenInput, saveSession, jwtSecondsLeft } = await import("../engine/qaSession.js");
        const t = parseTokenInput(await readStdin("Paste the access token, then a space and the refresh token if you have it (input is hidden): "));
        if (!t) { out("No token given – nothing saved.", json); return 1; }
        saveSession(projectId, t.access, t.refresh);
        const left = jwtSecondsLeft(t.access);
        out(`Saved the session for ${projectId}${left !== undefined ? ` (access token valid for ${Math.max(0, Math.round(left / 60))} more minutes${t.refresh ? "; renewed with the refresh token after that" : ""})` : ""}.`, json);
        return 0;
      }
      // aiw qa env <project> – secret settings for testing on this computer (e.g. fresh cloud credentials), given only to
      // the QA copy of that backend. Paste lines like "SET NAME=value", "export NAME=value" or "NAME=value".
      if (cmd === "qa" && sub === "env") {
        const { setSecret, getSecret, deleteSecret } = await import("../core/secrets.js");
        const projectId = a._[2] ? String(a._[2]) : "";
        if (!projectId || !getProject(projectId)) { out("Usage: aiw qa env <project>   (or --remove)", json); return 1; }
        if (a.remove) { deleteSecret(`qa.${projectId}.env`); out(`Removed the test settings of ${projectId}.`, json); return 0; }
        const text = await readStdin("Paste the settings (SET NAME=value lines), then press Enter on an empty line (input is hidden): ", true);
        const add: Record<string, string> = {};
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*(?:set\s+|export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/i.exec(line);
          if (m && m[2]) add[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
        }
        if (!Object.keys(add).length) { out("No NAME=value lines found – nothing saved.", json); return 1; }
        let cur: Record<string, string> = {};
        try { cur = JSON.parse(getSecret(`qa.${projectId}.env`) ?? "{}"); } catch { /* none */ }
        setSecret(`qa.${projectId}.env`, JSON.stringify({ ...cur, ...add }));
        out(`Saved ${Object.keys(add).join(", ")} for ${projectId} in the OS credential vault. Only the QA copy of ${projectId} gets them (they override .env); nothing is written to a file.`, json);
        return 0;
      }
      // aiw qa database <project> – a login to the LOCAL PostgreSQL, used only to create and drop temporary test databases
      if (cmd === "qa" && sub === "database") {
        const { setSecret, deleteSecret } = await import("../core/secrets.js");
        const projectId = a._[2] ? String(a._[2]) : "";
        if (!projectId || !getProject(projectId)) { out("Usage: aiw qa database <project>   (or --remove)", json); return 1; }
        if (a.remove) { deleteSecret(`qa.${projectId}.dbUrl`); out(`Removed the local database login of ${projectId}.`, json); return 0; }
        const url = (await readStdin("Local PostgreSQL login, e.g. postgresql://postgres:<password>@127.0.0.1:5432/postgres (input is hidden): ")).trim();
        if (!/^postgres(ql)?(\+\w+)?:\/\/[^@]+@(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?\//i.test(url)) { out("That is not a login to a LOCAL PostgreSQL (localhost / 127.0.0.1) – nothing saved.", json); return 1; }
        setSecret(`qa.${projectId}.dbUrl`, url);
        out(`Saved in the OS credential vault. Tests of ${projectId} now get a temporary database on your local PostgreSQL (created and dropped each run; your own databases are never touched).`, json);
        return 0;
      }
      // aiw qa <PR link | PR number [repo] | ticket>   ·   aiw fix <…> [--issues | --ci]   (results come to Teams first)
      const what = a._.slice(1).join(" ").trim();
      if (!what) { out(`Usage: aiw ${cmd} <PR link | PR number [repo] | ticket key>${cmd === "fix" ? " [--issues | --ci]" : ""}`, json); return 1; }
      const isTicket = /^[A-Z][A-Z0-9]+-\d+$/i.test(what);
      const pr = isTicket ? "" : /^\d+\b/.test(what) ? `PR ${what}` : what;
      const r = await api("POST", `/api/${cmd}`, { pr, ticket: isTicket ? what : undefined, issues: !!a.issues, ci: !!a.ci, by: loadSettings().profile.name || os.userInfo().username }, 60_000).catch((e) => ({ ok: false, message: e.message }));
      out(r ? r.message : "The AI Workforce service is not running – start it with `aiw service start`.", json);
      return r?.ok ? 0 : 1;
    }
    case "review": {
      // aiw review https://github.com/org/repo/pull/90 | aiw review 90 frontend | aiw review KAN-52
      const what = a._.slice(1).join(" ").trim();
      if (!what) { out("Usage: aiw review <PR link | PR number [repo] | ticket key>", json); return 1; }
      const isTicket = /^[A-Z][A-Z0-9]+-\d+$/i.test(what);
      const pr = isTicket ? "" : /^\d+\b/.test(what) ? `PR ${what}` : what;
      const r = await api("POST", "/api/review", { pr, ticket: isTicket ? what : undefined, by: loadSettings().profile.name || os.userInfo().username }, 60_000).catch((e) => ({ ok: false, message: e.message }));
      out(r ? r.message : "The AI Workforce service is not running – start it with `aiw service start`.", json);
      return r?.ok ? 0 : 1;
    }
    case "start": { const n = startAwaiting(sub ?? "all"); await kick(); out(`Started ${n} task(s).`, json); return 0; }
    case "cancel": { const t = await cancelTask(sub); out(t ? `${t.source_ref ?? t.id}: ${t.state}` : `No task ${sub}`, json); return t ? 0 : 1; }
    case "resume": { const t = resumeTask(sub); await kick(); out(t ? `${t.source_ref ?? t.id}: ${t.state}` : `No task ${sub}`, json); return t ? 0 : 1; }
    case "refresh": { const t = refreshTask(sub); await kick(); out(t ? `${t.source_ref ?? t.id}: ${t.state}` : `No task ${sub}`, json); return t ? 0 : 1; }
    case "pause": pauseAll(str(a.until)); out(`Paused${a.until ? ` until ${a.until}` : ""}. New work is queued, nothing starts.`, json); return 0;
    case "resume-all": resumeAll(); await kick(); out("Resumed.", json); return 0;
    case "read": markInboxRead(sub); out("Marked as read.", json); return 0;
    case "poll": {
      const r = await api("POST", "/api/poll", {}, 120_000);
      out(r ?? "Service is not running – start it with `aiw service start`.", json); return r ? 0 : 1;
    }
    case "cost": {
      // fresh input vs cache reads, by day / ticket / agent / recipe, alerts, then the model / effort overrides (§9.1.9)
      const days = Number(a.days ?? 7);
      if (json) { out(cost(days), json); return 0; }
      const { costViewText } = await import("../api/ops.js");
      out(costViewText(days), json); return 0;
    }
    case "adopt": {
      // W16: finish your own branch – your commits stay, mine go on top, a normal push (never forced). Engine v2 only.
      const target = sub;
      if (!target) { out("Usage: aiw adopt <branch|PR link|PR number> --ticket <KEY> [--project <id>]", json); return 1; }
      const { startAdoptFromText } = await import("../engine/steps/adopt.js");
      const ticket = str(a.ticket);
      const text = [/^\d+$/.test(target) ? `PR ${target}` : /github\.com/.test(target) ? target : `branch ${target}`, ticket ? ticket : "", a.project ? `project ${a.project}` : ""].filter(Boolean).join(" ");
      const r = await startAdoptFromText(text, "cli", "cli");
      await kick();
      out(r, json); return 0;
    }
    case "learned": {
      // O3: rule ideas from repeated review comments – "aiw learned <project>", "aiw learned add|skip|remove <project> R1"
      const L = await import("../engine/steps/close_out.js");
      const projectId = ["add", "skip", "remove"].includes(sub ?? "") ? third : sub;
      const p = projectId ? getProject(projectId) : loadProjects()[0];
      if (!p) { out("Usage: aiw learned [<project>] | add|skip|remove <project> R1", json); return 1; }
      const ref = a._[3];
      if (sub === "add" && ref) { const r = L.acceptRule(p.id, ref, { by: "cli", line: str(a.line) }); out(r ? `Added to the rules card: ${r.line}` : `No rule idea ${ref}.`, json); return r ? 0 : 1; }
      if (sub === "skip" && ref) { const r = L.rejectRule(p.id, ref, { by: "cli" }); out(r ? `Skipped ${ref}.` : `No rule idea ${ref}.`, json); return r ? 0 : 1; }
      if (sub === "remove" && ref) { const r = L.removeRule(p.id, ref); out(r ? `Removed ${ref} from the rules card.` : `No learned rule ${ref}.`, json); return r ? 0 : 1; }
      out(json ? L.ruleProposals(p.id) : L.renderProposals(p.id), json); return 0;
    }
    case "design": {
      // the design document of an item (W5a): its path and its ≤ 10-line summary, or the whole text with "show"
      if (!sub) { out("Usage: aiw design <ticket> [path|show]", json); return 1; }
      const t = (await import("../engine/tasks.js")).getTask(sub);
      const DD = await import("../knowledge/designDoc.js");
      const id = t?.data.leadId ?? t?.id ?? sub;
      const doc = DD.readDoc(id) ?? (t?.source_ref ? DD.readDoc(t.source_ref) : undefined);
      if (!doc) { out(`No design document for ${sub} yet.`, json); return 1; }
      if (third === "path") { out(doc.path, json); return 0; }
      out(json ? doc : third === "show" ? doc.text : `${DD.summary(doc.itemId)}\nFile: ${doc.path}`, json); return 0;
    }
    case "dashboard": {
      const rt = readRuntime();
      if (!rt || !pidAlive(rt.pid)) { out("Service is not running – start it with `aiw service start`.", json); return 1; }
      const url = `http://127.0.0.1:${rt.port}/?t=${encodeURIComponent(rt.token)}`;
      if (!a["no-open"]) openUrl(url);
      out(`Dashboard: ${url}\n(This link only works on this computer.)`, json); return 0;
    }
    case "statusline": console.log(inboxSummaryLine()); return 0;
    case "items": {
      const { itemsTree, itemsTreeText } = await import("../api/ops.js");
      const lines = itemsTree({ all: !!a.all, root: sub });
      if (sub && !lines.length) { out(`No item ${sub}.`, json); return 1; }
      out(json ? lines : itemsTreeText(lines), json);
      return 0;
    }
    case "explain": {
      if (!sub) { out("Usage: aiw explain <ticket>", json); return 1; }
      const { explainItem } = await import("../api/ops.js");
      const r = await explainItem(sub);
      out(json ? r : r.text, json);
      return r.ok ? 0 : 1;
    }
    case "rules": {
      const ops = await import("../api/ops.js");
      if (!sub || sub === "list") {
        const rules = await ops.rulesView();
        out(json ? rules : rules.length ? rules.map((r) => `${r.id}  ${r.text}${r.until ? ` (until ${r.until.slice(0, 10)})` : ""}`).join("\n") : "No rules in force – your settings apply.", json);
        return 0;
      }
      if (sub === "add") {
        const rule = third, value = a._?.[3] ?? a.value;
        if (!rule || value === undefined) { out("Usage: aiw rules add <rule> <value> [--ref KAN-45 | --scope global] [--until ISO]", json); return 1; }
        const v = value === "yes" ? true : value === "no" ? false : value;
        const r = await ops.addRule({ rule, value: v, ref: str(a.ref), scope: str(a.scope), until: str(a.until) }, "cli");
        out(r.message, json);
        return r.ok ? 0 : 1;
      }
      if (sub === "remove" || sub === "rm" || sub === "clear") {
        if (!third) { out("Usage: aiw rules remove <id>   (ids are listed by `aiw rules`)", json); return 1; }
        const r = await ops.removeRule(third, "cli");
        out(r.message, json);
        return r.ok ? 0 : 1;
      }
      out("Usage: aiw rules [list] | add <rule> <value> [--ref KAN-45] | remove <id>", json);
      return 1;
    }
    case "config": {
      if (sub !== "engine") { out("Usage: aiw config engine v1|v2", json); return 1; }
      if (!third) { const { engineVersion } = await import("../core/config.js"); out(`engine ${engineVersion()}`, json); return 0; }
      if (third !== "v1" && third !== "v2") { out("The engine is v1 or v2.", json); return 1; }
      updateSettings((s) => { s.engine = { ...(s.engine ?? {}), version: third as "v1" | "v2" }; });
      audit("user", "settings.engine", undefined, { version: third });
      await kick();
      out(`Engine set to ${third}.${third === "v2" ? " Running work moves over at its next step; `aiw config engine v1` switches back." : ""}`, json);
      return 0;
    }
    case "ask": {
      const q = a._.slice(1).join(" ").trim();
      if (!q) { out('Usage: aiw ask "which KAN tickets are in progress?"', json); return 1; }
      const { answerQuestion } = await import("../chat/assistant.js");
      out(await answerQuestion(q, loadSettings().profile.name || os.userInfo().username), json);
      return 0;
    }
    case "chat": {
      const { setMeta } = await import("../core/db.js");
      if (str(a["daily-tokens"])) setMeta("chat.dailyTokenLimit", String(Number(a["daily-tokens"])));
      if (a.new) { const { resetConversation } = await import("../chat/assistant.js"); resetConversation(); }
      out("Chat settings updated.", json); return 0;
    }
    case "uninstall": {
      await stopService(); uninstallAutostart();
      for (const s of ALL_SECRETS) deleteSecret(s);
      if (a.purge) { try { fs.rmSync(paths.home(), { recursive: true, force: true }); } catch { /* db may be open */ } }
      out(`Service removed, credentials deleted${a.purge ? ", local data purged" : ` (local data kept in ${paths.home()} – use --purge to delete)`}.`, json);
      return 0;
    }
    case "live": {
      progress("live", "done", "watching for work");
      await notify({ kind: "info", title: "AI Workforce is live", body: `Watching ${loadProjects().map((p) => p.id).join(", ")}. You'll be notified here when work arrives.`, dedupeKey: nowIso() });
      out("You're live.", json); return 0;
    }
    default: console.log(HELP); return 1;
  }
}

/** Jira: sign in with your Atlassian account in the browser (Atlassian's official MCP server, OAuth – no API token). */
async function connectJiraOAuth(a: Args, json: boolean): Promise<number> {
  const A = await import("../connectors/atlassianMcp.js");
  const { recordJiraOAuth } = await import("../connectors/registry.js");
  try {
    if (!A.hasAtlassianLogin() || a.relogin) {
      if (a.relogin) A.forgetAtlassianLogin();
      await A.atlassianLogin((url) => console.log(`\nSign in to Atlassian in your browser (it should open automatically):\n  ${url}\n\nChoose your Atlassian account and click "Accept". Waiting (up to 10 minutes)...\n`));
    }
    const sites = await A.accessibleSites();
    if (!sites.length) { out("Signed in, but this account has no Jira Cloud site it can access.", json); return 1; }
    const want = str(a.site)?.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    const site = want ? sites.find((s) => s.url.toLowerCase().includes(want)) : sites.length === 1 ? sites[0] : undefined;
    if (!site) {
      out(`Signed in. This account can access several sites – choose one:\n${sites.map((s) => `  ${new URL(s.url).host}  (${s.name})`).join("\n")}\nThen run: aiw connect jira --oauth --site <host>`, json);
      return 1;
    }
    const user = await A.atlassianUser();
    recordJiraOAuth(new URL(site.url).host, site.id, `${user.displayName} (${user.accountId})`, user.email);
    const conns = listConnections().filter((c) => c.status === "connected" || c.status === "pending-admin");
    progress("connectors", "done", conns.map((c) => c.provider).join(", "));
    out(`Connected Jira with your Atlassian sign-in: ${user.displayName} @ ${new URL(site.url).host} (no API token needed).`, json);
    return 0;
  } catch (e: any) {
    const blocked = /forbidden|not allowed|admin|unauthori[sz]ed|access denied|403/i.test(e.message);
    out(`Atlassian sign-in failed: ${e.message}${blocked ? "\nYour organisation may need to allow the Atlassian MCP connection (an admin setting). Meanwhile you can connect with an API token: aiw connect jira --browser" : ""}`, json);
    return 1;
  }
}

function connectorsDone(): void {
  const conns = listConnections().filter((c) => c.status === "connected" || c.status === "pending-admin");
  if (conns.length) progress("connectors", "done", conns.map((c) => c.provider).join(", "));
}

/** Notion: sign in with your Notion account in the browser (Notion's official MCP server, OAuth – no integration token). */
async function connectNotionOAuth(a: Args, json: boolean): Promise<number> {
  const { NOTION_MCP, notionAccount } = await import("../connectors/docs.js");
  const M = await import("../connectors/mcpOAuth.js");
  const { recordNotionOAuth } = await import("../connectors/registry.js");
  try {
    if (!M.hasMcpLogin(NOTION_MCP) || a.relogin) {
      if (a.relogin) M.forgetMcpLogin(NOTION_MCP);
      await M.mcpLogin(NOTION_MCP, (url) => console.log(`\nSign in to Notion in your browser (it should open automatically):\n  ${url}\n\nChoose your workspace, pick the pages AI Workforce may read, and click "Allow". Waiting (up to 10 minutes)...\n`));
    }
    const account = await notionAccount().catch(() => "Notion user");
    recordNotionOAuth(account);
    connectorsDone();
    out(`Connected Notion with your Notion sign-in: ${account} (no integration token needed).`, json);
    return 0;
  } catch (e: any) {
    out(`Notion sign-in failed: ${e.message}\nYou can still connect with an integration token: aiw connect notion --browser`, json);
    return 1;
  }
}

/** GitHub: the GitHub CLI's browser sign-in (one-time code on github.com/login/device). No personal access token. */
async function connectGitHubBrowser(a: Args, json: boolean): Promise<number> {
  const { tokenFromGhCli, testGitHub } = await import("../connectors/github.js");
  const { recordGitHubBrowser } = await import("../connectors/registry.js");
  const { openBrowser } = await import("../connectors/mcpOAuth.js");
  const { spawn, spawnSync } = await import("node:child_process");
  if (spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0) {
    out("GitHub sign-in uses the GitHub CLI, which is not installed.\n  Install it (Windows: winget install GitHub.cli · macOS: brew install gh), open a new terminal and run `aiw connect github` again.\n  Fallback without the CLI: aiw connect github --browser (paste a token).", json);
    return 1;
  }
  let token = a.relogin ? undefined : tokenFromGhCli();
  if (!token) {
    console.log("\nSigning in to GitHub in your browser...");
    const ok = await new Promise<boolean>((resolve) => {
      const gh = spawn("gh", ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "https", "--skip-ssh-key", "--scopes", "repo,read:org,workflow"],
        { stdio: ["pipe", "pipe", "pipe"] });
      let opened = false, buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        const code = /code:?\s*\(?([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(buf)?.[1];
        const url = /(https:\/\/github\.com\/login\/device)/.exec(buf)?.[1];
        if (code && url && !opened) {
          opened = true;
          console.log(`\n  1. A browser page opens: ${url}\n  2. Enter the code:  ${code}  (also copied to your clipboard)\n  3. Click "Authorize". Waiting (up to 15 minutes)...\n`);
          openBrowser(url);
        }
      };
      gh.stdout.on("data", onData); gh.stderr.on("data", onData);
      gh.stdin.write("\n"); gh.stdin.end();
      const timer = setTimeout(() => { gh.kill(); resolve(false); }, 15 * 60_000);
      gh.on("exit", (code) => { clearTimeout(timer); resolve(code === 0); });
    });
    if (!ok) { out("GitHub sign-in did not finish. Run `aiw connect github` to try again.", json); return 1; }
    token = tokenFromGhCli();
  }
  if (!token) { out("Signed in, but the GitHub CLI returned no login. Run `gh auth status` to check.", json); return 1; }
  const t = await testGitHub(token);
  if (!t.ok) { out(`GitHub sign-in check failed: ${t.detail}`, json); return 1; }
  recordGitHubBrowser(t, token);
  connectorsDone();
  out(`Connected GitHub with your GitHub sign-in: ${t.account} (no personal access token needed).`, json);
  return 0;
}

/** Figma: the Figma desktop app's own MCP server – no token and no sign-in (the app is already signed in). */
async function connectFigmaDesktop(_a: Args, json: boolean): Promise<number> {
  const { figmaDesktopStatus, FIGMA_DESKTOP_URL } = await import("../connectors/figmaDesktop.js");
  const { recordFigmaDesktop } = await import("../connectors/registry.js");
  const s = await figmaDesktopStatus();
  if (!s.ok) {
    out([
      `Figma desktop app not reachable at ${FIGMA_DESKTOP_URL}.`,
      s.detail ?? "",
      "To connect without a token:",
      "  1. Install and open the Figma desktop app (figma.com/downloads) and sign in.",
      "  2. Open a design file, switch to Dev Mode (Shift+D), and in the right panel click \"Enable desktop MCP server\"",
      "     (or Figma menu → Preferences → Enable Dev Mode MCP Server). Needs a Dev or Full seat.",
      "  3. Run `aiw connect figma --desktop` again.",
      "Recommended instead (reads any file, also when the app is closed): aiw connect figma  (paste a personal access token)",
    ].join("\n"), json);
    return 1;
  }
  recordFigmaDesktop(s.tools);
  updateSettings((st) => { st.figma = { ...(st.figma ?? {}), mode: "desktop" }; });      // you chose the app: use it first
  connectorsDone();
  out(`Connected Figma through the desktop app (${s.tools.length} tools, no token needed). Keep the app open with the design file when a task needs it.`, json);
  return 0;
}

/** Teams (personal): Microsoft device-code sign-in, then choose the chat for notifications and commands. */
async function connectTeamsPersonal(a: Args, json: boolean): Promise<number> {
  const { teamsPersonal, NOTES_CHAT } = await import("../connectors/teamsPersonal.js");
  const tp = await teamsPersonal();
  if (a["list-chats"]) {
    if (!tp.hasSavedLogin()) { out("Sign in first: aiw connect teams-personal", json); return 1; }
    const chats = await tp.listChats(30);
    out(json ? chats : chats.map((c) => `${c.id}  ${c.title}${c.type ? ` (${c.type})` : ""}`).join("\n"), json);
    return 0;
  }
  if (!tp.hasSavedLogin() || a.relogin) {
    const l = await tp.startLogin();
    const whoSignsIn = a.bot ? "the BOT's personal Microsoft account (NOT your own)" : "your personal Microsoft account (e.g. you@gmail.com / outlook.com)";
    console.log(`\nSign in to Microsoft Teams personal (teams.live.com):\n  1. Open ${l.verificationUrl}\n  2. Enter the code:  ${l.userCode}\n  3. Sign in with ${whoSignsIn}\nWaiting for you to finish (up to 15 minutes)...\n`);
    try { await tp.waitForLogin(); }
    catch (e: any) { out(`Sign-in failed: ${e.message}`, json); return 1; }
  }
  let chatId = str(a["chat-id"]);
  let chatTitle: string | undefined;
  if (a.bot) {
    // Signed in as the bot account: find its 1:1 chat with the owner (the person who receives notifications).
    const chats = str(a.owner) ? await tp.findChats(str(a.owner)!, "chat") : await tp.listChats(30, "chat");
    const oneToOne = chats.filter((c) => c.id !== NOTES_CHAT && !String(c.id).startsWith("48:"));
    if (oneToOne.length !== 1) {
      out(oneToOne.length
        ? `Several 1:1 chats found – choose the one with YOUR account:\n${oneToOne.map((c) => `  ${c.title}`).join("\n")}\nThen run: aiw connect teams-personal --bot --owner "<your name>"`
        : `No 1:1 chat found for the bot account. From YOUR Teams account, start a chat with the bot account and send "hi", then run this again.`, json);
      return 1;
    }
    const members = await tp.getChatMembers(oneToOne[0].id);
    const owner = members.find((m) => !m.isMe);
    if (!owner) { out("Could not identify your account in that chat.", json); return 1; }
    const res = await connect("teams-personal", { mode: "bot", chatId: oneToOne[0].id, chatTitle: oneToOne[0].title, ownerId: owner.mri, ownerName: owner.name ?? oneToOne[0].title });
    out(res.ok ? `Bot mode connected. Notifications will come from the bot account in its chat with ${owner.name ?? oneToOne[0].title}. A hello message was sent.\nOnly messages from ${owner.name ?? "you"} are accepted as commands.\nMake it your main channel: aiw notify --primary teams-personal --fallback desktop,inbox`
      : `Failed: ${res.detail}`, json);
    return res.ok ? 0 : 1;
  }
  if (!chatId && str(a.chat)) {
    const found = await tp.findChats(str(a.chat)!);
    if (!found.length) { out(`No chat matching "${a.chat}". Use --list-chats to see them.`, json); return 1; }
    chatId = found[0].id; chatTitle = found[0].title;
  }
  const res = await connect("teams-personal", { chatId: chatId ?? NOTES_CHAT, chatTitle });
  out(res.ok ? `Connected to Teams (personal). Notifications go to: ${chatTitle ?? (chatId ? chatId : "your Notes chat")}. A test message was sent there.\nMake it your main channel: aiw notify --primary teams-personal --fallback desktop,inbox`
    : `Failed: ${res.detail}`, json);
  return res.ok ? 0 : 1;
}

async function projectCmd(sub: string | undefined, id: string | undefined, a: Args, json: boolean): Promise<number> {
  if (sub === "list" || !sub) { out(loadProjects(), json); return 0; }
  if (sub === "show") { out(getProject(id!) ?? `No project ${id}`, json); return 0; }
  if (sub === "remove") { out(removeProject(id!) ? `Removed ${id} (Brain files kept).` : `No project ${id}`, json); return 0; }
  if (sub === "set") {
    const p = getProject(id!);
    if (!p) { out(`No project ${id}`, json); return 1; }
    if (str(a.autonomy)) p.autonomy = str(a.autonomy) as any;
    if (str(a["test-cmd"])) p.local.testCommand = str(a["test-cmd"]);
    if (str(a.status)) p.status = str(a.status) as any;
    if (a.roles) p.roles = list(a.roles);
    if (str(a.group)) p.group = str(a.group) === "none" ? undefined : str(a.group);
    upsertProject(p); out(p, json); return 0;
  }
  if (sub === "add") {
    const pid = str(a.id);
    const dir = str(a.path);
    if (!pid || !dir) { out("Usage: aiw project add --id ID --path DIR [...]", json); return 1; }
    const abs = path.resolve(dir);
    if (!isGitRepo(abs)) { out(`${abs} is not a git repository. Clone the repo first (git clone …) and pass its folder.`, json); return 1; }
    const s = loadSettings();
    let repo = str(a.repo);
    if (!repo) {
      const url = git(abs, ["remote", "get-url", "origin"], { allowFail: true });
      repo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)?.[1];
    }
    const stack = detectStack(abs);
    const keys = list(a["jira-keys"]).map((k) => k.toUpperCase());
    const clash = loadProjects().find((p) => p.id !== pid && p.jira?.keys.some((k) => keys.includes(k)) && !a["jql-extra"] && !(str(a.group) && p.group === str(a.group)));
    const p = normaliseProject({
      id: pid,
      jira: keys.length ? { site: str(a["jira-site"]) ?? (db().prepare("SELECT json_extract(meta,'$.site') AS s FROM connections WHERE provider='jira'").get() as any)?.s, keys, jqlExtra: str(a["jql-extra"]), qaStatus: str(a["qa-status"]) } : undefined,
      github: repo ? { repo, baseBranch: str(a.base) ?? (git(abs, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { allowFail: true }).replace("origin/", "") || "main") } : undefined,
      local: { path: abs, testCommand: str(a["test-cmd"]) ?? stack.testCommand, installCommand: str(a["install-cmd"]) },
      roles: a.roles ? list(a.roles) : s.profile.roles,
      autonomy: str(a.autonomy) ?? "prepare",
      related: list(a.related),
      group: str(a.group),
    });
    upsertProject(p);
    fs.mkdirSync(paths.projectDir(pid), { recursive: true });
    audit("user", "project.add", pid, { keys, repo });
    progress("project", "done", `${pid} → ${keys.join(",") || "no Jira"} · ${repo ?? "no GitHub remote"} · ${abs}`);
    out({ project: p, warning: clash ? `Jira key(s) also used by project "${clash.id}" – add --jql-extra to split them (e.g. by component).` : undefined,
      next: `aiw brain onboard ${pid}` }, json);
    return 0;
  }
  out("Usage: aiw project add|list|show|set|remove", json);
  return 1;
}

/** "aiw doctor <project>": the environment doctor for one repository (always a fresh check, no cache). */
async function envDoctorCmd(id: string, smoke: boolean, verbose: boolean, json: boolean): Promise<number> {
  const p = getProject(id);
  if (!p) { out(`No project "${id}". Projects: ${loadProjects().map((x) => x.id).join(", ") || "none – add one with aiw project add"}`, json); return 1; }
  const E = await import("../engine/envDoctor.js");
  const r = await E.checkEnvironment(p.local.path, { project: p, force: true, smoke });
  if (json) { out(r, true); return r.ok ? 0 : 1; }
  const lines = [E.envReport(r)];
  if (verbose || !r.ok) {
    for (const c of r.checks) lines.push(`${c.ok ? "OK  " : c.warn ? "WARN" : "FAIL"}  ${c.name}${c.detail ? ` – ${c.detail}` : ""}${!c.ok && c.fix ? `\n      Fix: ${c.fix}` : ""}`);
  }
  out(lines.join("\n"), false);
  return r.ok ? 0 : 1;
}

interface Check { name: string; ok: boolean; required: boolean; detail?: string }

async function doctor(): Promise<Check[]> {
  const checks: Check[] = [];
  const [maj, min] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js ≥ 22.13", ok: maj > 22 || (maj === 22 && min >= 13), required: true, detail: process.versions.node });
  let gitV = "";
  try { gitV = execFileSync("git", ["--version"], { encoding: "utf8" }).trim(); } catch { /* missing */ }
  const gv = /(\d+)\.(\d+)/.exec(gitV);
  checks.push({ name: "git ≥ 2.30 (worktrees)", ok: !!gv && (+gv[1] > 2 || (+gv[1] === 2 && +gv[2] >= 30)), required: true, detail: gitV || "not found" });
  try { fs.accessSync(paths.home(), fs.constants.W_OK); checks.push({ name: `Write access to ${paths.home()}`, ok: true, required: true }); }
  catch { checks.push({ name: `Write access to ${paths.home()}`, ok: false, required: true }); }
  try { const st = fs.statfsSync(paths.home()); const gb = (st.bavail * st.bsize) / 1024 ** 3; checks.push({ name: "Free disk ≥ 5 GB", ok: gb >= 5, required: false, detail: `${gb.toFixed(1)} GB free` }); } catch { /* unsupported */ }
  for (const [name, url] of [["Anthropic API", "https://api.anthropic.com"], ["Atlassian", "https://api.atlassian.com"], ["GitHub API", "https://api.github.com"], ["Slack API", "https://slack.com/api/api.test"]]) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(url, { method: "GET", signal: ctrl.signal }); clearTimeout(t);
      checks.push({ name: `Network: ${name}`, ok: true, required: name === "Anthropic API", detail: `HTTP ${r.status}` });
    } catch (e: any) { checks.push({ name: `Network: ${name}`, ok: false, required: name === "Anthropic API", detail: e.cause?.code ?? e.message }); }
  }
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  checks.push({ name: "Proxy", ok: true, required: false, detail: proxy ? `HTTPS_PROXY set (${proxy.replace(/\/\/.*@/, "//***@")}) – Node 24 honours it with NODE_USE_ENV_PROXY=1` : "none" });
  return checks;
}

async function testAnthropicKey(key: string, model: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    if (r.ok) return { ok: true };
    const j: any = await r.json().catch(() => ({}));
    return { ok: false, detail: `${r.status} ${j.error?.message ?? ""}`.trim() };
  } catch (e: any) { return { ok: false, detail: e.message }; }
}

async function openConnectPage(p: Provider, json: boolean): Promise<number> {
  const rt = readRuntime();
  if (!rt || !pidAlive(rt.pid)) { out("Start the service first: aiw service start", json); return 1; }
  const url = `http://127.0.0.1:${rt.port}/connect/${p}?t=${encodeURIComponent(rt.token)}`;
  openUrl(url);
  out(`Opened ${url}\nEnter the credentials in your browser – they go straight to your OS credential vault.`, json);
  return 0;
}

function openUrl(url: string): void {
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch { /* user can copy the URL */ }
}

export { desktopToast, saveSettings };
