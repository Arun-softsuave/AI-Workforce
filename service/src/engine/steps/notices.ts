/**
 * What a "none" reaction does (kernel/reactions.ts rows with job "none"): one short message, or a small state note.
 * Called by routeEvents for every event such a row matched. Code only – no model calls.
 *
 * Outside text (comment bodies, PR titles) is shown to the developer as quoted data only; it never starts work (§11a).
 */
import { loadSettings, type Settings } from "../../core/config.js";
import { truncate } from "../../core/util.js";
import { notify } from "../../notify/router.js";
import { sanitize } from "../../policy/untrusted.js";
import type { Item, KernelEvent, Reaction } from "../../kernel/types.js";
import { prOf, refOf, line } from "./common.js";

const quote = (s: unknown, max = 160) => `"${line(sanitize(String(s ?? "")), max)}"`;

/** The PR number / repo / link an event is about (payload first, then the item). */
function prFor(ev: KernelEvent, item: Item | undefined): { repo?: string; num?: number; url?: string } {
  const p = ev.payload ?? {};
  const fromItem = item ? prOf(item) : undefined;
  return { repo: p.repo ?? fromItem?.repo, num: Number(p.num ?? p.number ?? fromItem?.num) || undefined, url: p.url ?? fromItem?.url };
}

/** A short notice for an event, or undefined when nothing needs saying. Pure (reads only its arguments). */
export function noticeFor(ev: KernelEvent, item: Item | undefined, s: Settings): { kind: string; title: string; body: string; url?: string; urgent?: boolean } | undefined {
  const p = ev.payload ?? {};
  const pr = prFor(ev, item);
  const n = pr.num ? `PR #${pr.num}` : "the PR";
  const key = p.key ?? (Array.isArray(p.keys) ? p.keys[0] : undefined);
  const ref = item ? refOf(item) : (key ?? p.ticket ?? "");
  const text = p.text ?? p.body;
  const tag = ref ? ` · ${ref}` : "";
  // payload.author is the PR's author; the person who commented, reviewed, approved or mentioned is payload.by / reviewer
  const actor = p.by ?? p.reviewer ?? p.commenter ?? p.author ?? "Someone";
  const prAuthor = p.author ?? p.by ?? "Someone";
  const who = ["teammate_pr_opened", "review_requested"].includes(ev.type) ? prAuthor : actor;
  const proj = item?.project_id ?? ev.project_id ?? "";
  const say = (num?: number) => (num ? `say "review PR ${num}${proj ? ` ${proj}` : ""}"` : "say \"review the PR\"");
  switch (ev.type) {
    case "ci_passed":
      return { kind: "info", title: `✅ CI green on ${n}${tag}`, body: "All checks passed. Nothing merged.", url: pr.url };
    case "ci_failed":
      return { kind: "failed", title: `⚠️ CI still red on ${n}${tag} – please take a look`, body: `${(p.checks ?? []).join(", ") || "Checks failed"} after ${p.round ? Number(p.round) - 1 : 3} fix rounds. Say "fix the CI on PR ${pr.num ?? ""}" to try again.`, url: pr.url };
    case "comment_added": case "review_comment":
      return { kind: "pr_comment", title: `💬 ${who} commented on ${n}${tag}`, body: `${text ? quote(text) : ""}${p.path ? ` (${p.path})` : ""}\n\nSay "resolve the comments on PR ${pr.num ?? ""}" to fix them.`.trim(), url: pr.url };
    case "changes_requested":
      return { kind: "pr_changes_requested", urgent: true, title: `🛑 ${who} requested changes on ${n}${tag}`, body: `${text ? `${quote(text)}\n\n` : ""}Say "resolve the comments on PR ${pr.num ?? ""}".`, url: pr.url };
    case "mention":
      return { kind: "pr_comment", title: `📣 ${who} mentioned you on ${p.issue ? `issue #${p.issue}` : n}${tag}`, body: text ? quote(text, 240) : "Open the link to see it.", url: p.commentUrl ?? pr.url ?? p.url };
    case "teammate_pr_opened":
      return { kind: "info", title: `👀 ${who} raised ${n}${key ? ` · ${key}` : tag}`, body: `${p.title ? `${quote(p.title, 120)} – ` : ""}${say(pr.num)}.`, url: pr.url };
    case "review_requested":
      return { kind: "info", title: `👀 ${who} asked you to review ${n}${key ? ` · ${key}` : tag}`, body: `${s.pr?.autoReview ? "Reviewing it now – comments come here first." : `${say(pr.num)}.`}`, url: pr.url };
    case "new_commits": {
      const res = Number.isFinite(Number(p.resolved)) && Number(p.total) ? `resolved ${p.resolved} of ${p.total}` : "pushed new commits";
      return { kind: "pr_comment", title: `🔁 ${who} ${res} on ${n} you reviewed${tag}`, body: `Re-review? ${say(pr.num)} – only the change is checked.`, url: pr.url };
    }
    case "pr_approved":
      return { kind: "info", title: `✅ ${n}${tag} approved by ${who} – ready to merge`, body: `${p.mergeOrder ? `Merge order: ${p.mergeOrder}. ` : ""}I never merge – that is yours.`, url: pr.url };
    case "ticket_changed":
      return { kind: "info", title: `📝 ${ref || "The ticket"} changed in Jira – noted`, body: "No requirement changed, so the PR stays as it is.", url: p.url };
    case "pr_reopened":
      return { kind: "info", title: `↩️ ${n}${tag} was reopened – I look after it again`, body: "CI, comments and conflicts are watched again.", url: pr.url };
    case "pr_conflict_cleared":
      return { kind: "info", title: `✅ ${n}${tag} has no conflicts with ${p.base ?? "its base"} now`, body: "GitHub shows it can be merged. Nothing was merged – that is yours.", url: pr.url };
    case "pr_conflict":
      // only reached when no rebase job could start (the PR is not one this plugin can update): say so, never stay silent
      return { kind: "failed", title: `⚠️ ${n}${tag} has conflicts with ${p.base ?? "its base branch"}`, body: `I can't update it by myself${item ? ` (${refOf(item)} is ${String(item.state).toLowerCase().replace(/_/g, " ")})` : ""}. Say "rebase PR ${pr.num ?? ""}" and I'll bring ${p.base ?? "the base"} in, or resolve it yourself. Nothing is force-pushed.`, url: pr.url };
    default:
      return undefined;
  }
}

/**
 * Run a "none" reaction: notify / ask / design_note / review_start (block / resume belong to connector health).
 * Never throws (a message that cannot be sent is not a reason to stop routing).
 */
export async function handleNone(ev: KernelEvent, item: Item | undefined, r: Reaction, s: Settings = loadSettings()): Promise<void> {
  try {
    switch (r.recipe) {
      case "notify": {
        // ci_passed while a ci_watch job reports the result itself: one message only (same dedupe key as the watch)
        // re-review offer (K3 / H3): how many of my threads the author dealt with
        if (ev.type === "new_commits" && ev.payload?.resolved === undefined) {
          const pr = prFor(ev, item);
          const gh = (await import("../../connectors/registry.js")).clients.github();
          const me = s.team?.me?.github ?? (await import("../../core/db.js")).getMeta("github.login") ?? "";
          if (pr.repo && pr.num && gh?.reviewThreads && me) {
            try {
              const { resolvedCounts } = await import("../../intake/prActivity.js");
              const c = resolvedCounts(await gh.reviewThreads(pr.repo, pr.num), me);
              if (c.total) ev = { ...ev, payload: { ...ev.payload, ...c } };
            } catch { /* the plain offer is enough */ }
          }
        }
        const n = noticeFor(ev, item, s);
        if (!n) return;
        const pr = prFor(ev, item);
        const dedupeKey = ev.type === "ci_passed" && pr.repo && ev.payload?.sha ? `ci-green:${pr.repo}#${pr.num}:${ev.payload.sha}` : `ev:${ev.idem_key}`;
        await notify({ kind: n.kind, taskId: item?.id, taskRef: item ? refOf(item) : undefined, dedupeKey, title: truncate(n.title, 160), body: n.body, url: n.url, urgent: n.urgent });
        return;
      }
      case "ask":
        if (item && ev.type === "pr_closed") { const { askDropOrReopen } = await import("./close.js"); await askDropOrReopen(item.id); }
        return;
      case "design_note":
        if (item) { const { designNote } = await import("./replan.js"); await designNote(item.id, ev.payload ?? {}); }
        return;
      default:
        return;                                          // block / resume: connector health (intake/health.ts)
    }
  } catch { /* never stop routing for a message */ }
}

