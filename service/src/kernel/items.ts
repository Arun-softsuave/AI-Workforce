/**
 * Kernel items (engine v2): work items are `tasks` rows with the kernel columns (level, parent_id, root_id, areas,
 * owner, due). Trees, dependency edges, area claims and merge order. No model calls – plain code over SQLite.
 * State changes always go through engine/tasks.ts transition() (legal moves only, audited).
 */
import { db, audit } from "../core/db.js";
import { nowIso, safeJson } from "../core/util.js";
import { activeTaskFor, createTask, getTask, transition, type State, type Task } from "../engine/tasks.js";
import {
  LEVELS, CONTAINER_LEVELS, type Level, type Item, type NewItem, type Edge, type EdgeType,
  type CreateItem, type GetItem, type ChildrenOf, type TreeOf, type SetItemState, type UpdateItem,
  type AddEdge, type RemoveEdge, type EdgesOf, type OpenDependencies, type AreaConflicts, type MergeOrder,
} from "./types.js";

export const EDGE_TYPES: readonly EdgeType[] = ["depends_on", "stacks_on", "same_area", "duplicates"];
/** States in which an item no longer holds an area claim. */
const INACTIVE: State[] = ["DONE", "CANCELLED", "FAILED", "MERGED"];
/** States in which a dependency counts as finished. */
const FINISHED: State[] = ["MERGED", "DONE"];

/** A tasks row (or Task) as an Item: parse areas, fill kernel defaults for rows written before the migration. */
export function toItem(r: any): Item {
  const data = typeof r.data === "string" ? safeJson(r.data, {}) : (r.data ?? {});
  const areas = Array.isArray(r.areas) ? r.areas : safeJson<unknown>(r.areas, []);
  return {
    ...r,
    data,
    level: (r.level ?? "ticket") as Level,
    parent_id: r.parent_id ?? null,
    root_id: r.root_id ?? null,
    areas: Array.isArray(areas) ? areas.filter((a): a is string => typeof a === "string") : [],
    owner: r.owner ?? "me",
    due: r.due ?? null,
  };
}

const rowById = (id: string): Item | undefined => {
  const r = db().prepare("SELECT * FROM tasks WHERE id=?").get(id);
  return r ? toItem(r) : undefined;
};

function checkLevel(level: unknown): asserts level is Level {
  if (!LEVELS.includes(level as Level)) throw new Error(`Unknown item level "${String(level)}"`);
}

// ------------------------------------------------------------------ items

export const getItem: GetItem = (idOrRef) => {
  const t: Task | undefined = getTask(idOrRef);
  return t ? rowById(t.id) : undefined;
};

export const createItem: CreateItem = (n: NewItem) => {
  const level = n.level ?? "ticket";
  checkLevel(level);
  let parent: Item | undefined;
  if (n.parentId) {
    parent = rowById(n.parentId);
    if (!parent) throw new Error(`Parent item ${n.parentId} not found`);
  }
  // dedupe like createTask: an active item for the same source and kind is returned as it is
  if (n.sourceId) {
    const dup = activeTaskFor(n.sourceId, n.kind);
    if (dup) return rowById(dup.id)!;
  }
  const t = createTask({
    projectId: n.projectId, source: n.source, sourceId: n.sourceId, sourceRef: n.sourceRef, title: n.title, kind: n.kind,
    role: n.role, priority: n.priority, data: n.data, state: n.state,
  });
  const rootId = parent ? (parent.root_id ?? parent.id) : t.id;
  db().prepare("UPDATE tasks SET level=?, parent_id=?, root_id=?, areas=?, owner=?, due=?, playbook=COALESCE(?, playbook), updated_at=? WHERE id=?")
    .run(level, parent?.id ?? null, rootId, JSON.stringify(n.areas ?? []), n.owner ?? "me", n.due ?? null, n.playbook ?? null, nowIso(), t.id);
  audit("service", "item.created", t.id, { level, parent: parent?.id, root: rootId });
  return rowById(t.id)!;
};

export const childrenOf: ChildrenOf = (parentId, opts = {}) =>
  (db().prepare(`SELECT * FROM tasks WHERE parent_id=? ${opts.includeCancelled ? "" : "AND state != 'CANCELLED'"} ORDER BY created_at, rowid`)
    .all(parentId) as any[]).map(toItem);

/** The whole tree under a root: root first, then depth-first in creation order. Cancelled items are included. */
export const treeOf: TreeOf = (rootId) => {
  const root = rowById(rootId);
  if (!root) return [];
  const out: Item[] = [];
  const seen = new Set<string>();
  const walk = (it: Item) => {
    if (seen.has(it.id)) return;                         // guards against a corrupt parent loop
    seen.add(it.id);
    out.push(it);
    for (const c of childrenOf(it.id, { includeCancelled: true })) walk(c);
  };
  walk(root);
  return out;
};

export const setItemState: SetItemState = (id, to, note) => {
  const t = transition(id, to, note);
  return rowById(t.id)!;
};

export const updateItem: UpdateItem = (id, patch) => {
  const it = rowById(id);
  if (!it) throw new Error(`Item ${id} not found`);
  const sets: string[] = [], args: any[] = [];
  if (patch.level !== undefined) { checkLevel(patch.level); sets.push("level=?"); args.push(patch.level); }
  if (patch.areas !== undefined) { sets.push("areas=?"); args.push(JSON.stringify(patch.areas ?? [])); }
  if (patch.owner !== undefined) { sets.push("owner=?"); args.push(patch.owner ?? "me"); }
  if (patch.due !== undefined) { sets.push("due=?"); args.push(patch.due); }
  if (patch.priority !== undefined) { sets.push("priority=?"); args.push(patch.priority); }
  let reroot = false;
  if (patch.parent_id !== undefined && patch.parent_id !== it.parent_id) {
    let rootId = id;
    if (patch.parent_id) {
      const p = rowById(patch.parent_id);
      if (!p) throw new Error(`Parent item ${patch.parent_id} not found`);
      if (treeOf(id).some((x) => x.id === p.id)) throw new Error(`Item ${p.source_ref ?? p.id} is inside ${it.source_ref ?? id}; it cannot be its parent`);
      rootId = p.root_id ?? p.id;
    }
    sets.push("parent_id=?"); args.push(patch.parent_id);
    if (patch.root_id === undefined) { sets.push("root_id=?"); args.push(rootId); reroot = true; }
  }
  if (patch.root_id !== undefined) { sets.push("root_id=?"); args.push(patch.root_id); reroot = true; }
  if (!sets.length) return it;
  sets.push("updated_at=?"); args.push(nowIso());
  db().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id=?`).run(...args, id);
  if (reroot) {
    const root = rowById(id)!.root_id ?? id;
    for (const d of treeOf(id).slice(1)) db().prepare("UPDATE tasks SET root_id=? WHERE id=?").run(root, d.id);
  }
  return rowById(id)!;
};

// ------------------------------------------------------------------ edges

const row2edge = (r: any): Edge => ({ from: r.from_id, to: r.to_id, type: r.type, created_at: r.created_at });

export const addEdge: AddEdge = (from, to, type) => {
  if (!EDGE_TYPES.includes(type)) throw new Error(`Unknown edge type "${type}"`);
  if (from === to) throw new Error("An item cannot have an edge to itself");
  db().prepare("INSERT OR IGNORE INTO edges (from_id, to_id, type, created_at) VALUES (?,?,?,?)").run(from, to, type, nowIso());
};

export const removeEdge: RemoveEdge = (from, to, type) => {
  db().prepare("DELETE FROM edges WHERE from_id=? AND to_id=? AND type=?").run(from, to, type);
};

export const edgesOf: EdgesOf = (id, dir = "both") => {
  const sql = dir === "out" ? "SELECT * FROM edges WHERE from_id=?"
    : dir === "in" ? "SELECT * FROM edges WHERE to_id=?"
    : "SELECT * FROM edges WHERE from_id=?1 OR to_id=?1";
  return (db().prepare(`${sql} ORDER BY created_at, rowid`).all(id) as any[]).map(row2edge);
};

export const openDependencies: OpenDependencies = (id) =>
  edgesOf(id, "out").filter((e) => e.type === "depends_on")
    .map((e) => rowById(e.to))
    .filter((x): x is Item => !!x && !FINISHED.includes(x.state));

// ------------------------------------------------------------------ area claims

const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
const isGlob = (p: string) => /[*?[{]/.test(p);
/** The fixed part of a glob before its first wildcard ("src/api/**" -> "src/api/"). */
const staticPrefix = (g: string) => { const i = g.search(/[*?[{]/); return i < 0 ? g : g.slice(0, i); };

function globToRegex(g: string): RegExp {
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { i++; if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*"; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { const j = g.indexOf("}", i); if (j < 0) { re += "\\{"; continue; } re += `(?:${g.slice(i + 1, j).split(",").map((s) => s.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`; i = j; }
    else if (c === "[") { const j = g.indexOf("]", i); if (j < 0) { re += "\\["; continue; } re += g.slice(i, j + 1); i = j; }
    else re += c.replace(/[.+^$()|\\\]]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`);   // a glob that names a folder also covers what is inside it
}

/** Prefix on path segments: "src/api" contains "src/api/x.ts" but not "src/apix". */
const pathPrefix = (dir: string, p: string) => dir === "" || p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
/** Plain string prefix for glob static parts ("src/a" is a possible prefix of "src/api"). */
const textPrefix = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

/**
 * Do two path patterns possibly touch the same file? Plain paths: same path or one inside the other (folder).
 * Plain path vs glob: the glob matches the path (or a folder of it). Two globs: their fixed prefixes overlap
 * (conservative – a lock too many is safe, a lock too few is not).
 */
export function pathsOverlap(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return true;                                // "" / "." = the whole repository
  const gx = isGlob(x), gy = isGlob(y);
  if (!gx && !gy) return pathPrefix(x, y) || pathPrefix(y, x);
  if (gx && gy) return textPrefix(staticPrefix(x), staticPrefix(y));
  const [glob, plain] = gx ? [x, y] : [y, x];
  if (globToRegex(glob).test(plain)) return true;
  return globEntersFolder(glob, plain);
}

/** Can the glob match something inside the folder `dir`? Segment by segment; "**" matches any depth. */
function globEntersFolder(glob: string, dir: string): boolean {
  const g = glob.split("/"), d = dir.split("/");
  for (let i = 0; i < d.length; i++) {
    if (i >= g.length) return false;                         // the glob ended above the folder (regex test covered it)
    if (g[i] === "**") return true;
    if (!globToRegex(g[i]).test(d[i])) return false;
  }
  return g.length > d.length;
}

/** Do two area lists overlap? An empty list means "not known yet" and never conflicts. */
export function areasOverlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => pathsOverlap(x, y)));
}

export const areaConflicts: AreaConflicts = (areas, exceptId) => {
  if (!areas.length) return [];
  const rows = (db().prepare(`SELECT * FROM tasks WHERE state NOT IN (${INACTIVE.map(() => "?").join(",")}) AND areas IS NOT NULL AND areas != '[]' ORDER BY priority, created_at, rowid`)
    .all(...INACTIVE) as any[]).map(toItem);
  return rows.filter((it) => it.id !== exceptId && areasOverlap(areas, it.areas));
};

// ------------------------------------------------------------------ merge order

/**
 * Topological sort of depends_on + stacks_on edges among `ids` ("from" merges after "to"). Ties: priority (lower
 * first), then created_at, then the order of `ids`. Edges to items outside `ids` are ignored. When there is a
 * cycle, `order` holds the items that can be ordered and `cycle` the ids of one cycle (first id repeated at the end).
 */
export const mergeOrder: MergeOrder = (ids) => {
  const uniq = [...new Set(ids)];
  const set = new Set(uniq);
  const pos = new Map(uniq.map((id, i) => [id, i]));
  const items = new Map(uniq.map((id) => [id, rowById(id)]));
  const rank = (id: string) => { const it = items.get(id); return [it?.priority ?? 3, it?.created_at ?? "", pos.get(id)!] as const; };
  const cmp = (a: string, b: string) => {
    const [pa, ca, ia] = rank(a), [pb, cb, ib] = rank(b);
    return pa - pb || (ca < cb ? -1 : ca > cb ? 1 : 0) || ia - ib;
  };
  const after = new Map<string, Set<string>>(uniq.map((id) => [id, new Set()]));   // to -> froms that wait for it
  const indeg = new Map<string, number>(uniq.map((id) => [id, 0]));
  for (const id of uniq) {
    for (const e of edgesOf(id, "out")) {
      if ((e.type !== "depends_on" && e.type !== "stacks_on") || !set.has(e.to) || e.to === id) continue;
      if (after.get(e.to)!.has(id)) continue;                           // both edge types between the same pair
      after.get(e.to)!.add(id);
      indeg.set(id, indeg.get(id)! + 1);
    }
  }
  const ready = uniq.filter((id) => indeg.get(id) === 0).sort(cmp);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const n of after.get(id)!) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) { ready.push(n); ready.sort(cmp); }
    }
  }
  if (order.length === uniq.length) return { order };
  return { order, cycle: findCycle(uniq.filter((id) => indeg.get(id)! > 0), set) };
};

/** One cycle among the left-over ids (each has an unfinished predecessor, so walking edges must loop). */
function findCycle(left: string[], set: Set<string>): string[] {
  const leftSet = new Set(left);
  const next = (id: string) => edgesOf(id, "out")
    .filter((e) => (e.type === "depends_on" || e.type === "stacks_on") && set.has(e.to) && leftSet.has(e.to) && e.to !== id)
    .map((e) => e.to);
  const state = new Map<string, 1 | 2>();   // 1 = on the path, 2 = done
  const path: string[] = [];
  const dfs = (id: string): string[] | undefined => {
    state.set(id, 1); path.push(id);
    for (const n of next(id)) {
      if (state.get(n) === 1) return [...path.slice(path.indexOf(n)), n];
      if (!state.has(n)) { const c = dfs(n); if (c) return c; }
    }
    state.set(id, 2); path.pop();
    return undefined;
  };
  for (const id of left) if (!state.has(id)) { const c = dfs(id); if (c) return c; }
  return left;
}

/**
 * Merge order of the work under a root: every non-container item of the tree that is not cancelled.
 * Throws "Merge order has a cycle: A -> B -> A" (source refs) when the edges loop.
 */
export function mergeOrderOf(rootId: string): string[] {
  const ids = treeOf(rootId).filter((it) => it.state !== "CANCELLED" && !CONTAINER_LEVELS.includes(it.level)).map((it) => it.id);
  const r = mergeOrder(ids);
  if (r.cycle) {
    const name = (id: string) => { const it = rowById(id); return it?.source_ref ?? it?.title ?? id; };
    throw new Error(`Merge order has a cycle: ${r.cycle.map(name).join(" -> ")}`);
  }
  return r.order;
}
