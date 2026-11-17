import http from "node:http";
import { URL } from "node:url";
import { loadSettings } from "../core/config.js";
import { logger } from "../core/log.js";
import { audit } from "../core/db.js";
import { connect, disconnect, PROVIDERS, type Provider } from "../connectors/registry.js";
import { SLACK_APP_MANIFEST } from "../connectors/slack.js";
import { statusSnapshot, taskDetail, tasksList, inboxView, cost } from "./ops.js";
import { decideAndApply, cancelTask, resumeTask, refreshTask, startAwaiting, pauseAll, resumeAll, tick, answerTask } from "../engine/engine.js";
import { markInboxRead } from "../notify/router.js";
import { runTicket, pollAll } from "../intake/intake.js";
import { askBrain, brainSummary, onboardProject, confirmBrain, refreshProject } from "../brain/brain.js";
import { dashboardHtml, connectHtml } from "./dashboard.js";
import { dashboardRoutes, overviewSnapshot } from "./dashboardData.js";
import { handleStream } from "./stream.js";
import { webPage, webAsset, webHeaders } from "./web.js";

/**
 * Local API + dashboard. Bound to 127.0.0.1 only. Every /api call needs the X-AIW-Token header
 * (a custom header cannot be sent cross-site without CORS, which we never grant -> CSRF protection).
 */
type Handler = (m: RegExpMatchArray, body: any, url: URL) => Promise<any> | any;
const routes: [string, RegExp, Handler][] = [];
const r = (method: string, re: RegExp, h: Handler) => routes.push([method, re, h]);
const approver = () => loadSettings().profile.name || "local user";

r("GET", /^\/api\/health$/, () => ({ ok: true, pid: process.pid }));
r("POST", /^\/api\/qa$/, async (_m, b) => {
  const { startQaFromText } = await import("../engine/qa.js");
  const message = await startQaFromText(String(b.pr ?? ""), b.ticket ? String(b.ticket) : undefined, String(b.by ?? approver()), "claude-code");
  await tick();
  return { ok: true, message };
});
r("POST", /^\/api\/fix$/, async (_m, b) => {
  const { startFixFromText } = await import("../engine/prFix.js");
  const message = await startFixFromText(String(b.pr ?? ""), b.ticket ? String(b.ticket) : undefined, String(b.by ?? approver()), b.issues ? "issues" : b.ci ? "ci" : "comments", "claude-code");
  await tick();
  return { ok: true, message };
});
r("POST", /^\/api\/review$/, async (_m, b) => {
  const { startReviewFromText } = await import("../engine/prReview.js");
  const message = await startReviewFromText(`review ${String(b.pr ?? "")}`, b.ticket ? String(b.ticket) : undefined, String(b.by ?? approver()), "claude-code");
  await tick();
  return { ok: true, message };
});
r("GET", /^\/api\/status$/, () => statusSnapshot());
r("GET", /^\/api\/tasks$/, (_m, _b, u) => tasksList(u.searchParams.get("state")?.split(","), Number(u.searchParams.get("limit") ?? 50)));
r("GET", /^\/api\/tasks\/([^/]+)$/, (m) => taskDetail(decodeURIComponent(m[1])) ?? Promise.reject(new HttpErr(404, "task not found")));
r("POST", /^\/api\/tasks\/run$/, async (_m, b) => { const t = await runTicket(String(b.key)); await tick(); return { ok: true, task: t.id, ref: t.source_ref }; });
r("POST", /^\/api\/tasks\/([^/]+)\/cancel$/, async (m) => ({ ok: !!(await cancelTask(decodeURIComponent(m[1]))) }));
r("POST", /^\/api\/tasks\/([^/]+)\/resume$/, async (m) => { const t = resumeTask(decodeURIComponent(m[1])); await tick(); return { ok: !!t, state: t?.state }; });
r("POST", /^\/api\/tasks\/([^/]+)\/refresh$/, async (m) => { const t = refreshTask(decodeURIComponent(m[1])); await tick(); return { ok: !!t, state: t?.state }; });
r("POST", /^\/api\/tasks\/([^/]+)\/start$/, async (m) => { const n = startAwaiting(decodeURIComponent(m[1])); await tick(); return { ok: n > 0, started: n }; });
r("POST", /^\/api\/approve\/([^/]+)$/, (m, b) => decideAndApply(decodeURIComponent(m[1]), "approved", b.approver ?? approver(), b.channel ?? "dashboard"));
r("POST", /^\/api\/reject\/([^/]+)$/, (m, b) => decideAndApply(decodeURIComponent(m[1]), "rejected", b.approver ?? approver(), b.channel ?? "dashboard", b.reason));
// dashboard buttons and message box: the same code as the Teams commands, echoed to Teams (api/actions.ts)
r("POST", /^\/api\/act$/, async (_m, b) => (await import("./actions.js")).runDashboardAction({ id: String(b.id ?? ""), action: b.action, text: b.text ?? b.reason ?? b.answer, value: b.value, who: b.by ?? approver() }));
r("POST", /^\/api\/message$/, async (_m, b) => (await import("./actions.js")).dashboardMessage(String(b.text ?? ""), b.by ?? approver()));
r("POST", /^\/api\/answer$/, (_m, b) => answerTask(b.ref, String(b.answer ?? ""), b.by ?? approver(), b.channel ?? "dashboard"));
r("GET", /^\/api\/inbox$/, (_m, _b, u) => inboxView(u.searchParams.get("all") === "1"));
r("POST", /^\/api\/inbox\/read$/, (_m, b) => { markInboxRead(b.task); return { ok: true }; });
r("POST", /^\/api\/pause$/, (_m, b) => { pauseAll(b.until); return { ok: true }; });
r("POST", /^\/api\/resume$/, async () => { resumeAll(); await tick(); return { ok: true }; });
r("POST", /^\/api\/poll$/, async () => { const res = await pollAll(); await tick(); return res; });
r("POST", /^\/api\/kick$/, async () => { await tick(); return { ok: true }; });
// standing rules (directives), why an item is where it is, the item tree (dashboard + CLI over the API)
r("GET", /^\/api\/rules$/, async () => (await import("./ops.js")).rulesView());
r("POST", /^\/api\/rules$/, async (_m, b) => (await import("./ops.js")).addRule({ rule: String(b.rule ?? ""), value: b.value, ref: b.ref, scope: b.scope, until: b.until }, "dashboard"));
r("POST", /^\/api\/rules\/([^/]+)\/remove$/, async (m) => (await import("./ops.js")).removeRule(decodeURIComponent(m[1]), "dashboard"));
r("GET", /^\/api\/explain\/([^/]+)$/, async (m) => (await import("./ops.js")).explainItem(decodeURIComponent(m[1])));
r("GET", /^\/api\/items$/, async (_m, _b, u) => (await import("./ops.js")).itemsTree({ all: u.searchParams.get("all") === "1", root: u.searchParams.get("ref") ?? undefined }));
r("GET", /^\/api\/cost$/, (_m, _b, u) => cost(Number(u.searchParams.get("days") ?? 7)));
r("GET", /^\/api\/brain\/([^/]+)$/, (m) => ({ summary: brainSummary(m[1]) }));
r("POST", /^\/api\/brain\/([^/]+)\/ask$/, (m, b) => ({ answer: askBrain(m[1], String(b.q ?? "")) }));
r("POST", /^\/api\/brain\/([^/]+)\/rebuild$/, (m) => { refreshProject(m[1]); return { ok: true }; });
r("POST", /^\/api\/brain\/([^/]+)\/onboard$/, async (m, b) => onboardProject(m[1], { useAi: b.ai !== false, full: !!b.full }).then((x) => ({ files: x.map.files.length, facts: x.facts, tokens: x.tokens, mode: x.mode })));
r("POST", /^\/api\/brain\/([^/]+)\/confirm$/, (m) => ({ confirmed: confirmBrain(m[1]) }));
r("POST", /^\/api\/connect\/([a-z]+)$/, async (m, b) => {
  if (!PROVIDERS.includes(m[1] as Provider)) throw new HttpErr(400, "unknown provider");
  return connect(m[1] as Provider, b);
});
r("DELETE", /^\/api\/connect\/([a-z]+)$/, (m) => { disconnect(m[1] as Provider); return { ok: true }; });
r("GET", /^\/api\/slack-manifest$/, () => SLACK_APP_MANIFEST);
r("GET", /^\/api\/bench$/, async () => { const B = await import("../bench/benchmark.js"); return { text: B.renderBaseline(B.baselineReport()) }; });
r("GET", /^\/api\/projects\/([^/]+)\/env$/, async (m, _b, u) => {
  const { getProject } = await import("../core/config.js");
  const p = getProject(decodeURIComponent(m[1]));
  if (!p) throw new HttpErr(404, "project not found");
  const E = await import("../engine/envDoctor.js");
  const res = await E.checkEnvironment(p.local.path, { project: p, force: true, smoke: u.searchParams.get("smoke") === "1" });
  return { ...res, report: E.envReport(res) };
});
// Live dashboard data (read-only): overview, needs, working, board, timeline, agents, timers, connections, feed
for (const [m, re, h] of dashboardRoutes) r(m, re, h);

class HttpErr extends Error { constructor(public status: number, msg: string) { super(msg); } }

export function startApiServer(port: number, token: string): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: any, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      res.end(type === "application/json" ? JSON.stringify(body) : body);
    };
    try {
      // Pages: the token is passed once in the query string by the CLI ("aiw dashboard").
      if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/connect/"))) {
        if (url.searchParams.get("t") !== token) return send(401, "<h1>Open the dashboard with <code>aiw dashboard</code></h1>", "text/html");
        if (url.pathname === "/") {
          const html = webPage(token);                         // the live dashboard (service/web); old page if it is missing
          if (!html) return send(200, dashboardHtml(token), "text/html");
          res.writeHead(200, webHeaders("text/html; charset=utf-8"));
          return res.end(html);
        }
        return send(200, connectHtml(url.pathname.split("/")[2], token), "text/html");
      }
      // Static files of the dashboard (scripts, styles): no data in them, so no token (a <script src> cannot send one).
      if (req.method === "GET" && url.pathname.startsWith("/web/")) {
        const host = String(req.headers.host ?? "");
        if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, { error: "bad host" });
        const a = webAsset(url.pathname);
        if (!a) return send(404, { error: "not found" });
        res.writeHead(200, webHeaders(a.type));
        return res.end(a.body);
      }
      // Live updates (Server-Sent Events): EventSource cannot send headers, so the stream checks ?t= itself.
      if (req.method === "GET" && url.pathname === "/api/stream") { handleStream(req, res, token, { snapshot: overviewSnapshot }); return; }
      if (!url.pathname.startsWith("/api/")) return send(404, { error: "not found" });
      if (req.headers["x-aiw-token"] !== token) return send(401, { error: "missing or invalid session token" });
      const host = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, { error: "bad host" });   // DNS-rebinding guard
      const body = await readBody(req);
      for (const [method, re, h] of routes) {
        const m = url.pathname.match(re);
        if (m && method === req.method) return send(200, (await h(m, body, url)) ?? { ok: true });
      }
      send(404, { error: "no such endpoint" });
    } catch (e: any) {
      logger.error("api error", { path: url.pathname, error: e.message });
      send(typeof e?.status === "number" ? e.status : 500, { error: e.message });
    }
  });
  return new Promise((resolve, reject) => {
    const tryListen = (p: number, attemptsLeft: number) => {
      const onError = (err: any) => {
        server.off("listening", onListening);
        if (err.code === "EADDRINUSE" && attemptsLeft > 0) tryListen(p + 1, attemptsLeft - 1);   // pick a free port automatically
        else reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const port = (server.address() as { port: number }).port;          // the port actually bound
        audit("service", "api.listen", undefined, { port });
        resolve({ server, port });
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(p, "127.0.0.1");
    };
    tryListen(port, 20);
  });
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1_000_000) { reject(new HttpErr(413, "body too large")); req.destroy(); } });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpErr(400, "invalid JSON")); } });
  });
}
