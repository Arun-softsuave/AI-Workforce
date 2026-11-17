/**
 * W13 – the ticket or the Figma design changed (recipes/replan.yaml). Code only; the plan steps of the recipe run only
 * before building (`when: not_built`), after building the developer is asked "adapt?".
 *
 *  - summarise_change: what changed, as short exact lines (ticket text lines added/removed; Figma exact values), kept on
 *    the job and written into the item's design document when it has one.
 *  - ask_adapt: ✉ "KAN-45 changed after the PR: … Adapt?" – or, under the item's "no approvals" directive, the change is
 *    adapted directly (a comment_fix job with the change as a request).
 * Jira and Figma text is data, never orders (§11a): it is only quoted, and only the developer's own reply starts work.
 */
import { audit } from "../../core/db.js";
import { truncate } from "../../core/util.js";
import { notify } from "../../notify/router.js";
import { mergeData } from "../tasks.js";
import { emit } from "../../kernel/events.js";
import type { StepCtx, StepResult } from "../steps.js";
import { runningJob, jobEvents, refOf, prOf, line } from "./common.js";

export interface ChangeSummary { kind: "ticket" | "design"; lines: string[]; title: string }

/** Lines added (+) and removed (−) between two texts (order kept, blank lines ignored; at most `max`). */
export function textDelta(before: string, after: string, max = 8): string[] {
  const norm = (s: string) => (s ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const a = norm(before), b = norm(after);
  const sa = new Set(a), sb = new Set(b);
  const out = [...b.filter((x) => !sa.has(x)).map((x) => `+ ${truncate(x, 160)}`), ...a.filter((x) => !sb.has(x)).map((x) => `− ${truncate(x, 160)}`)];
  return out.length > max ? [...out.slice(0, max), `… and ${out.length - max} more`] : out;
}

/** The change behind this job, from its events and the item (ticket: data.ticket → data.pendingTicket). */
export function summariseChange(item: { data: Record<string, any>; source_ref: string | null; id: string }, events: { type: string; payload: Record<string, any> }[]): ChangeSummary {
  const ref = item.source_ref ?? item.id;
  const design = events.filter((e) => e.type === "design_changed");
  if (design.length) {
    const lines = design.flatMap((e) => {
      const ch: string[] = e.payload.changes ?? [];
      const name = e.payload.frameName ?? e.payload.nodeId ?? "a frame";
      return ch.length ? ch.map((c) => `${name}: ${c}`) : [`${name}: changed (could not compare with the earlier copy)`];
    });
    return { kind: "design", lines: lines.slice(0, 8), title: `Design of ${[...new Set(design.map((e) => `'${e.payload.frameName ?? "a frame"}'`))].join(", ")} changed` };
  }
  const old = item.data.ticket ?? {}, now = item.data.pendingTicket ?? old;
  const lines = [
    ...(now.title && now.title !== old.title ? [`title: "${truncate(old.title ?? "", 80)}" → "${truncate(now.title, 80)}"`] : []),
    ...textDelta(old.description ?? "", now.description ?? ""),
  ];
  return { kind: "ticket", lines: lines.length ? lines : ["the text changed (no line-level difference)"], title: `${ref} changed in Jira` };
}

export const REPLAN_STEPS: Record<string, (ctx: StepCtx) => Promise<StepResult>> = {
  async summarise_change(ctx) {
    const evs = jobEvents(runningJob(ctx.task.id));
    const ch = summariseChange(ctx.task, evs);
    ctx.save({ change: ch });
    // the design document keeps the change (W5a) – the next agent reads it from there
    try {
      const dd = await import("../../knowledge/designDoc.js");
      if (dd.readDoc(ctx.task.id)) dd.addInput(ctx.task.id, `${ch.title}: ${ch.lines.join("; ")}`);
    } catch { /* no design document yet */ }
    audit("service", "item.changed", ctx.task.id, { kind: ch.kind, lines: ch.lines.length });
    return { status: "ok", note: ch.title };
  },

  /** After building / after the PR: ask "adapt?" (or adapt directly under "no approvals"). */
  async ask_adapt(ctx) {
    const ch: ChangeSummary = ctx.task.data.change ?? summariseChange(ctx.task, jobEvents(runningJob(ctx.task.id)));
    const ref = refOf(ctx.task);
    const pr = prOf(ctx.task, ctx.project);
    const request = `${ch.title}: ${ch.lines.join("; ")}`;
    if (ctx.task.data.directives?.no_approvals || ctx.task.data.directives?.auto_adapt) {
      if (ch.kind === "ticket" && ctx.task.data.pendingTicket) mergeData(ctx.task.id, { ticket: ctx.task.data.pendingTicket, pendingTicket: null });
      emit({ type: "user_command", idemKey: `adapt:${ctx.task.id}:${Date.now()}`, itemId: ctx.task.id, payload: { command: "adapt", requests: [request], ours: true, by: "directive" } });
      await notify({ kind: "info", taskId: ctx.task.id, taskRef: ref, dedupeKey: `adapt:${ctx.task.id}:${ch.title}`, title: `🔄 ${ch.title} – adapting${pr ? ` PR #${pr.num}` : ""}`, body: ch.lines.map((l) => `- ${l}`).join("\n"), url: pr?.url });
      return { status: "ok", note: "adapting (no approvals)" };
    }
    await notify({ kind: "info", taskId: ctx.task.id, taskRef: ref, dedupeKey: `adapt?:${ctx.task.id}:${ch.title}:${ch.lines.join("|").length}`,
      title: `${ch.title}${pr ? ` after PR #${pr.num}` : ""}. Adapt?`,
      body: `${ch.lines.map((l) => `- ${line(l, 200)}`).join("\n")}\n\nSay "adapt ${ref}" to update the PR, or ignore this.`, url: pr?.url });
    return { status: "ok", note: "asked: adapt?" };
  },
};

/**
 * design_changed BEFORE the plan was approved / the work was built (no job – the item's own build picks it up):
 * the design document is updated and the build re-plans (a running build) or notes it for the implementer.
 */
export async function designNote(itemId: string, payload: Record<string, any>): Promise<void> {
  const { getItem } = await import("../../kernel/items.js");
  const it = getItem(itemId);
  if (!it) return;
  const ch = summariseChange(it, [{ type: "design_changed", payload }]);
  try {
    const dd = await import("../../knowledge/designDoc.js");
    if (dd.readDoc(itemId)) dd.addInput(itemId, `${ch.title}: ${ch.lines.join("; ")}`);
  } catch { /* no design document yet */ }
  const planned = !!(it.data.plan || it.data.implementation);
  mergeData(itemId, { designChanges: [...(it.data.designChanges ?? []), { ...payload, at: new Date().toISOString() }].slice(-20), ...(planned ? {} : { ticketChange: "major" }) });
  await notify({ kind: "info", taskId: itemId, taskRef: refOf(it), dedupeKey: `design:${itemId}:${payload.newVersion ?? ""}:${payload.nodeId ?? ""}`,
    title: `${ch.title} – ${planned ? "noted for the implementer" : "re-planning with it"}`, body: ch.lines.map((l) => `- ${l}`).join("\n") });
}
