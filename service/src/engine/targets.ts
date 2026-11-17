import { loadProjects, type ProjectConfig } from "../core/config.js";
import { getMeta, setMeta } from "../core/db.js";
import { clients } from "../connectors/registry.js";
import { listTasks } from "./tasks.js";

/**
 * Which pull request(s) a Teams message is about – for any developer and any project, not one fixed flow:
 *   - a PR link, "PR 90", "PR 90 backend"
 *   - a ticket key: this developer's own tasks first, otherwise a GitHub search (e.g. a teammate's ticket)
 *   - a person: "Eric's PR" (GitHub login, matched loosely)
 * Every action (review, fix comments, QA) uses this, so they all understand the same ways of naming a PR.
 */

export interface PrTarget { project: ProjectConfig; repo: string; num: number; author?: string; title?: string; url?: string }

/** The GitHub login of the developer running this copy of the plugin. */
export async function myLogin(): Promise<string | undefined> {
  const cached = getMeta("github.login");
  if (cached) return cached;
  try { const me = (await clients.github()?.user())?.login; if (me) setMeta("github.login", me); return me; } catch { return undefined; }
}

export const projectForRepo = (repo: string): ProjectConfig | undefined =>
  loadProjects().find((p) => p.github?.repo && p.github.repo.toLowerCase() === repo.toLowerCase());

const reposOf = () => [...new Set(loadProjects().map((p) => p.github?.repo).filter((r): r is string => !!r))];

function urlTarget(url: string): PrTarget | undefined {
  const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(url);
  const project = m ? projectForRepo(m[1]) : undefined;
  return m && project ? { project, repo: project.github!.repo, num: Number(m[2]) } : undefined;
}

/** PRs for a ticket: the ones this plugin raised, then GitHub (title / description / branch mention the key). Open ones first. */
export async function findTicketPrs(key: string): Promise<PrTarget[]> {
  const k = key.toUpperCase().split("@")[0];
  const out = new Map<string, PrTarget & { state?: string }>();
  for (const t of listTasks({ limit: 2000 }).filter((x) => (x.data.ticket?.key ?? String(x.source_ref).split("@")[0]).toUpperCase() === k)) {
    for (const u of [t.data.pr?.url, ...(t.data.prs ?? []).map((x: any) => x.url)].filter(Boolean) as string[]) {
      const tg = urlTarget(u);
      if (tg) out.set(`${tg.repo}#${tg.num}`, { ...tg, url: u, state: "open" });
    }
  }
  const gh = clients.github();
  const repos = reposOf();
  if (gh && repos.length) {
    try {
      for (const p of (await gh.searchPrs?.(repos, k)) ?? []) {
        const project = projectForRepo(p.repo);
        if (project && !out.has(`${p.repo}#${p.number}`)) out.set(`${p.repo}#${p.number}`, { project, repo: project.github!.repo, num: p.number, author: p.author, title: p.title, url: p.url, state: p.state });
      }
    } catch { /* search is best effort */ }
    // branches named after the key (feat/KAN-60/...) that the search may miss
    for (const repo of repos) {
      try {
        for (const p of (await gh.openPrs?.(repo)) ?? []) {
          if (!new RegExp(`\\b${k}\\b`, "i").test(`${p.headRef ?? ""} ${p.title}`)) continue;
          const project = projectForRepo(repo);
          if (project && !out.has(`${repo}#${p.number}`)) out.set(`${repo}#${p.number}`, { project, repo, num: p.number, author: p.author, title: p.title, url: p.url, state: "open" });
        }
      } catch { /* optional */ }
    }
  }
  const all = [...out.values()];
  const open = all.filter((x) => x.state === "open");
  return (open.length ? open : all).map(({ state: _s, ...x }) => x);
}

/** "Eric's PR": open PRs whose author login contains the name. */
export async function findPersonPrs(name: string): Promise<PrTarget[]> {
  const gh = clients.github();
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!gh?.openPrs || n.length < 2) return [];
  const out: PrTarget[] = [];
  for (const repo of reposOf()) {
    try {
      for (const p of await gh.openPrs(repo)) {
        if (!p.author.toLowerCase().replace(/[^a-z0-9]/g, "").includes(n)) continue;
        const project = projectForRepo(repo);
        if (project) out.push({ project, repo, num: p.number, author: p.author, title: p.title, url: p.url });
      }
    } catch { /* optional */ }
  }
  return out;
}

/** A person named in the message as the owner of a PR or ticket ("Eric's PR", "the PR of Eric", "PR from Eric"). */
export function personIn(text: string): string | undefined {
  const skip = /^(my|the|this|that|your|our|his|her|their|a|an|it|its|pr|prs)$/i;
  const m = /\b([A-Za-z][\w.-]{1,30})['’]s\s+(?:pr|prs|pull requests?|tickets?|changes?)\b/i.exec(text)
    ?? /\b(?:pr|prs|pull requests?)\s+(?:of|from|by)\s+([A-Za-z][\w.-]{1,30})\b/i.exec(text);
  return m && !skip.test(m[1]) ? m[1] : undefined;
}

/**
 * Resolve the PR(s) a message is about. ticketRef: a ticket key the message named. Returns the targets, or a short
 * question when it cannot tell (never guesses for an action).
 */
export async function resolvePrTargets(text: string, ticketRef?: string): Promise<{ targets: PrTarget[] } | { error: string }> {
  const { parsePrRef, resolvePr } = await import("./prReview.js");
  const ref = parsePrRef(text);
  if (ref) {
    const r = await resolvePr(ref);
    return "error" in r ? { error: r.error } : { targets: [r] };
  }
  if (ticketRef) {
    const found = await findTicketPrs(ticketRef);
    if (found.length) return { targets: found };
    return { error: `I couldn't find a pull request for ${ticketRef.toUpperCase()} in ${reposOf().join(", ") || "your repositories"}. Paste the PR link, e.g. "review https://github.com/org/repo/pull/90".` };
  }
  const person = personIn(text);
  if (person) {
    const found = await findPersonPrs(person);
    if (found.length === 1) return { targets: found };
    if (found.length > 1) return { error: `${person} has ${found.length} open PRs: ${found.slice(0, 6).map((p) => `${p.repo.split("/")[1]} #${p.num} (${p.title})`).join("; ")}. Which one? e.g. "PR ${found[0].num}".` };
    return { error: `I found no open PR by "${person}". Paste the PR link, or name the ticket.` };
  }
  return { error: "Which PR? Paste the link, or say e.g. \"PR 90 frontend\" or the ticket key." };
}
