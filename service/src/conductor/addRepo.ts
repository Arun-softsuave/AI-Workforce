import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { audit } from "../core/db.js";
import { loadProjects, upsertProject, normaliseProject, getProject } from "../core/config.js";
import { notify } from "../notify/router.js";
import { logger } from "../core/log.js";

/**
 * A2 from Teams: "add the admin-panel repo, github acme/admin-panel". The new repository joins the product group of
 * the existing ones (same Jira keys, same group), is cloned next to them (your message is the permission), then learned
 * in the background (conventions, rules card, CI map, code map) and checked (ready check). One message when done.
 */
export interface AddRepoArgs { name?: string; github?: string; path?: string; group?: string }

let cloneFn = (url: string, dir: string): void => { execFileSync("git", ["clone", "--quiet", url, dir], { stdio: "ignore", timeout: 15 * 60_000 }); };
export function setRepoCloner(f: typeof cloneFn): void { cloneFn = f; }

export async function addRepo(a: AddRepoArgs, who: string, opts: { background?: boolean } = {}): Promise<{ ok: boolean; reply: string }> {
  const gh = String(a.github ?? "").replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "").trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(gh)) return { ok: false, reply: "Which GitHub repository? e.g. \"add the admin-panel repo, github acme/admin-panel\"." };
  const id = String(a.name ?? gh.split("/")[1]).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
  if (getProject(id)) return { ok: false, reply: `${id} is already set up.` };
  const all = loadProjects();
  const sibling = all.find((p) => (a.group ? (p.group ?? p.id) === a.group : true) && p.local?.path) ?? all[0];
  const dir = a.path ?? (sibling?.local?.path ? path.join(path.dirname(sibling.local.path), gh.split("/")[1]) : undefined);
  if (!dir) return { ok: false, reply: `Where should ${gh} live on this computer? Say "add ${gh} at D:\\\\code\\\\${gh.split("/")[1]}".` };
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(path.dirname(dir), { recursive: true }); cloneFn(`https://github.com/${gh}.git`, dir); }
    catch (e: any) { return { ok: false, reply: `I couldn't clone ${gh}: ${String(e?.message ?? e).slice(0, 200)}. Check your GitHub access, or clone it yourself and say this again.` }; }
  }
  const p = normaliseProject({
    id, group: sibling?.group ?? sibling?.id, jira: sibling?.jira, github: { repo: gh, baseBranch: sibling?.github?.baseBranch ?? "main" },
    local: { path: dir }, roles: sibling?.roles ?? ["fullstack-developer"], autonomy: sibling?.autonomy ?? "plan",
  } as any);
  upsertProject(p);
  audit(`user:${who}`, "project.added", id, { github: gh, via: "teams" });
  const learn = async () => {
    const lines: string[] = [];
    try { const { onboardProject } = await import("../brain/brain.js"); await onboardProject(id); lines.push("✅ Learned its code, conventions and rules"); } catch (e: any) { lines.push(`⚠️ Learning it: ${String(e?.message ?? e).slice(0, 120)}`); }
    try { const { detectConventions } = await import("../brain/conventions.js"); const c = await detectConventions(id); lines.push(`✅ Base branch ${c.baseBranch}; CI: ${(c.ci?.jobs ?? []).length} check${(c.ci?.jobs ?? []).length === 1 ? "" : "s"} mapped`); } catch { /* reported above */ }
    try {
      const { readyCheck } = await import("../engine/ready.js");
      const r = await readyCheck(id);
      const bad = r.items.filter((x) => x.state === "fail");
      lines.push(bad.length ? `⚠️ Ready check: ${bad.map((x) => `${x.area} – ${x.detail}${x.fix ? ` (${x.fix})` : ""}`).slice(0, 3).join("; ")}` : "✅ Ready check passed");
    } catch (e: any) { lines.push(`⚠️ Ready check: ${String(e?.message ?? e).slice(0, 120)}`); }
    await notify({ kind: "info", dedupeKey: `repo-added:${id}`, title: `📦 ${id} is set up`, body: lines.join("\n") }).catch(() => {});
  };
  if (opts.background === false) await learn();
  else void learn().catch((e) => logger.warn("repo learning failed", { project: id, error: e?.message }));
  return { ok: true, reply: `📦 Added ${gh} as ${id}${sibling?.group || sibling?.id ? ` (with ${sibling.group ?? sibling.id})` : ""}, in ${dir}. I'm learning it now and will tell you here when it's ready.` };
}
