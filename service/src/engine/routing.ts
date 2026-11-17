import { loadProjects, type ProjectConfig } from "../core/config.js";
import { loadCodeMap } from "../brain/codemap.js";
import { readDoc } from "../brain/handbook.js";
import { truncate } from "../core/util.js";

/**
 * Multi-repo projects: several repositories (e.g. backend + frontend) share one Jira project.
 * They are configured as separate projects with the same `group`; each keeps its own Brain.
 * Triage decides which member repo(s) a ticket needs.
 */
export function groupMembers(p: ProjectConfig): ProjectConfig[] {
  if (!p.group) return [p];
  return loadProjects().filter((x) => x.group === p.group && x.status !== "paused");
}

/** The member that polls Jira for the whole group (first in config order). */
export function isGroupLead(p: ProjectConfig): boolean {
  return !p.group || groupMembers(p)[0]?.id === p.id;
}

/** Short description of each member so the triage model can decide where work belongs. */
export function describeMembers(members: ProjectConfig[]): string {
  return members.map((m) => {
    const map = loadCodeMap(m.id);
    const langs = map ? Object.entries(map.stack.languages).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l).join(", ") : "unknown";
    const fw = map?.stack.frameworks.join(", ") || "none detected";
    let overview = "";
    try { overview = truncate(readDoc(m.local.path, "overview").narrative.replace(/\s+/g, " "), 300); } catch { /* not onboarded */ }
    return `- "${m.id}" (${m.github?.repo ?? m.local.path}): languages ${langs}; frameworks ${fw}. ${overview}`;
  }).join("\n");
}

const FRONTEND = /\b(ui|ux|page|screen|button|form|modal|component|css|style|layout|react|vue|angular|next\.?js|frontend|front-end|client|dashboard|view|display|show|render|navigation|responsive|accessib\w*)\b/i;
const BACKEND = /\b(api|endpoint|database|db|schema|migration|model|query|server|backend|back-end|service|auth\w*|token|webhook|queue|job|cron|cache|validation|persist\w*|store|index|search)\b/i;

/**
 * Offline / fallback routing used when the model gives no usable answer:
 * match member names (…frontend / …backend) against keyword signals in the ticket.
 */
export function heuristicTargets(text: string, members: ProjectConfig[]): string[] {
  const fe = members.find((m) => /front|web|ui|client/i.test(`${m.id} ${m.github?.repo ?? ""}`));
  const be = members.find((m) => /back|api|server|service/i.test(`${m.id} ${m.github?.repo ?? ""}`));
  const wantsFe = FRONTEND.test(text), wantsBe = BACKEND.test(text);
  const out: string[] = [];
  if (be && (wantsBe || !wantsFe)) out.push(be.id);
  if (fe && wantsFe) out.push(fe.id);
  return out.length ? out : [members[0].id];
}

/** Keep the configured member order (backend before frontend when that is how they were added). */
export function orderTargets(targets: string[], members: ProjectConfig[]): string[] {
  const valid = members.map((m) => m.id).filter((id) => targets.includes(id));
  return valid.length ? valid : [members[0].id];
}
