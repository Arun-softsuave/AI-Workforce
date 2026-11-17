/**
 * Kernel recipes (engine v2): ordered step lists run by kernel/runner.ts with the unchanged STEPS functions (the after-PR
 * steps – ci_watch, rebase, replan, close – live in engine/steps/ and reach STEPS through engine/prFix.ts FIX_STEPS).
 * Two sources, one map (name → Recipe):
 *  - every v1 playbook (engine/playbooks.ts), as a recipe of the SAME name with the SAME steps and params, so v2 runs
 *    today's flows unchanged;
 *  - service/recipes/*.yaml (AIW_RECIPES overrides the folder): the new after-PR recipes (ci_fix, comment_fix, rebase,
 *    close, replan, ci_watch). A yaml recipe never replaces a playbook of the same name (validate() reports the clash).
 * Branching is plain code: `when` (a guard name or a simple condition on the item/job), `goto` (bounded by `max`),
 * `spawn_children` (the runner creates one child per entry of job.data[key]). No model calls here.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { serviceRoot } from "../core/paths.js";
import { loadPlaybooks, type Playbook } from "../engine/playbooks.js";
import {
  JOB_TYPES, type Item, type Job, type JobType, type Recipe, type RecipeStep,
  type LoadRecipes, type GetRecipe, type RecipeFromPlaybook, type NextStepIndex,
} from "./types.js";

export function recipeDir(): string {
  return process.env.AIW_RECIPES ?? path.join(serviceRoot(), "recipes");
}

// ------------------------------------------------------------------ playbooks as recipes

/** The job type a playbook's work belongs to (by its trigger); everything else is a "build". */
const JOB_BY_TRIGGER: Record<string, JobType> = { pr_fix: "comment_fix", pr_qa: "qa", pr_review: "review" };

export const recipeFromPlaybook: RecipeFromPlaybook = (pb: Playbook, job?: JobType): Recipe => ({
  name: pb.id,
  title: pb.title,
  job: job ?? JOB_BY_TRIGGER[pb.trigger] ?? "build",
  // steps and params unchanged (same params object, so a step sees exactly what v1 gives it)
  steps: pb.steps.map((s) => ({ name: s.name, params: s.params })),
});

// ------------------------------------------------------------------ yaml recipes

/** Keys a full-form step may have (`- name: x` style); anything else is reported by validate(). */
const STEP_KEYS = new Set(["name", "params", "when", "goto", "max", "spawn_children"]);

/** A yaml step: "name", { name: params } (playbook style) or { name: "x", params?, when?, goto?, max?, spawn_children? }. */
export function parseStep(s: unknown): RecipeStep {
  if (typeof s === "string") return { name: s, params: {} };
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error(`Bad recipe step: ${JSON.stringify(s)}`);
  const o = s as Record<string, any>;
  if (typeof o.name === "string") {
    const step: RecipeStep = { name: o.name, params: o.params ?? {} };
    if (o.when !== undefined) step.when = String(o.when);
    if (o.goto !== undefined) step.goto = String(o.goto);
    if (o.max !== undefined) step.max = Number(o.max);
    if (o.spawn_children !== undefined) step.spawn_children = String(o.spawn_children);
    const extra = Object.keys(o).filter((k) => !STEP_KEYS.has(k));
    if (extra.length) (step as any).unknownKeys = extra;
    return step;
  }
  const keys = Object.keys(o);
  if (keys.length !== 1) throw new Error(`Bad recipe step: ${JSON.stringify(s)}`);
  return { name: keys[0], params: o[keys[0]] ?? {} };
}

export function parseRecipe(raw: any, file = "recipe"): Recipe {
  if (!raw || typeof raw !== "object") throw new Error(`${file}: not a recipe`);
  const name = raw.name ?? raw.id;
  if (typeof name !== "string" || !name) throw new Error(`${file}: recipe has no name`);
  return { name, title: raw.title, job: (raw.job ?? "build") as JobType, steps: (raw.steps ?? []).map(parseStep) };
}

let cache: Map<string, Recipe> | undefined;
/** yaml recipes that were not loaded because a playbook has the same name (reported by validate()). */
let clashes: string[] = [];
/** yaml files that could not be read (reported by validate()). */
let loadErrors: string[] = [];

export const loadRecipes: LoadRecipes = (force = false) => {
  if (cache && !force) return cache;
  const map = new Map<string, Recipe>();
  clashes = [];
  loadErrors = [];
  for (const pb of loadPlaybooks(force).values()) map.set(pb.id, recipeFromPlaybook(pb));
  const dir = recipeDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort() : [];
  for (const f of files) {
    try {
      const r = parseRecipe(YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")), f);
      if (map.has(r.name)) { clashes.push(r.name); continue; }   // a playbook keeps its name: v1 parity first
      map.set(r.name, r);
    } catch (e: any) {
      loadErrors.push(`${f}: ${e?.message ?? e}`);
    }
  }
  cache = map;
  return cache;
};

export const getRecipe: GetRecipe = (name: string) => {
  const r = loadRecipes().get(name);
  if (!r) throw new Error(`Unknown recipe "${name}"`);
  return r;
};

// ------------------------------------------------------------------ when: guards and simple conditions

type Guard = (item: Item, job: Job) => boolean;
const built = (i: Item) => !!(i.data?.implementation || i.data?.pr || (i.data?.prs ?? []).length);

/** Named guards a step's `when` may use. Pure: they only read the item and the job. */
export const GUARDS: Record<string, Guard> = {
  always: () => true,
  never: () => false,
  size_s: (i) => i.size === "S",
  size_m_or_l: (i) => i.size === "M" || i.size === "L",
  built: (i) => built(i),
  not_built: (i) => !built(i),
  has_pr: (i) => !!(i.data?.pr || (i.data?.prs ?? []).length),
  multi_repo: (i) => (i.data?.repos ?? []).length > 1,
  has_children: (_i, j) => Array.isArray(j.data?.children) && j.data.children.length > 0,
  ci_mode: (i, j) => (j.data?.fix?.mode ?? i.data?.fix?.mode) === "ci",
};

/** Read "size", "state", "level", "owner", "data.a.b" (item) or "job.a.b" (job.data). */
function valueAt(p: string, item: Item, job: Job): unknown {
  const parts = p.split(".");
  let v: any;
  if (parts[0] === "data") v = item.data;
  else if (parts[0] === "job") v = job.data;
  else if (parts.length === 1) return (item as any)[p];
  else return undefined;
  for (const k of parts.slice(1)) v = v == null ? undefined : v[k];
  return v;
}

const COND = /^\s*(!?)\s*([a-zA-Z_][\w.]*)\s*(?:(==|!=|\bin\b)\s*(.+?))?\s*$/;
const scalar = (s: string) => s.trim().replace(/^["']|["']$/g, "");

/** A simple condition: `name`, `!path`, `path == v`, `path != v`, `path in [a, b]` (paths: size, state, level, owner, data.*, job.*). */
export function parseCondition(expr: string): Guard | undefined {
  if (GUARDS[expr.trim()]) return GUARDS[expr.trim()];
  const m = COND.exec(expr);
  if (!m) return undefined;
  const [, not, p, op, rhs] = m;
  const first = p.split(".")[0];
  if (!["size", "state", "level", "owner", "data", "job", "priority"].includes(first)) return undefined;
  if (first !== "data" && first !== "job" && p.includes(".")) return undefined;
  if (not && op) return undefined;
  if (!op) return (i, j) => (not ? !valueAt(p, i, j) : !!valueAt(p, i, j));
  if (op === "in") {
    const list = rhs.trim();
    if (!/^\[.*\]$/.test(list)) return undefined;
    const vals = list.slice(1, -1).split(",").map(scalar).filter(Boolean);
    return (i, j) => vals.includes(String(valueAt(p, i, j)));
  }
  const want = scalar(rhs);
  return op === "==" ? (i, j) => String(valueAt(p, i, j)) === want : (i, j) => String(valueAt(p, i, j)) !== want;
}

/** Should this step run? (no `when` = yes; an unknown condition = no, and validate() reports it). */
export function stepApplies(step: RecipeStep, item: Item, job: Job): boolean {
  if (!step.when) return true;
  const g = parseCondition(step.when);
  return g ? g(item, job) : false;
}

// ------------------------------------------------------------------ moving through a recipe

/** Default bound of a `goto` loop when the step gives no `max`. */
export const DEFAULT_GOTO_MAX = 1;

/**
 * The step after `index` returned ok, plus the job.data patch the runner must save with it (goto counters).
 * A goto is followed while job.data.gotos[stepName] < max; then the recipe simply continues. Steps whose `when` is
 * false are skipped. -1 = the recipe is finished. Use index = -1 to find the first step.
 */
export function advance(recipe: Recipe, index: number, job: Job, item: Item): { next: number; data?: Record<string, any> } {
  let from = index + 1;
  let data: Record<string, any> | undefined;
  const cur = index >= 0 ? recipe.steps[index] : undefined;
  if (cur?.goto) {
    const gotos: Record<string, number> = { ...(job.data?.gotos ?? {}) };
    const max = cur.max ?? DEFAULT_GOTO_MAX;
    const target = recipe.steps.findIndex((s) => s.name === cur.goto);
    if (target >= 0 && (gotos[cur.name] ?? 0) < max) {
      gotos[cur.name] = (gotos[cur.name] ?? 0) + 1;
      data = { gotos };
      from = target;
    }
  }
  for (let i = from; i < recipe.steps.length; i++) if (stepApplies(recipe.steps[i], item, job)) return { next: i, data };
  return { next: -1, data };
}

export const nextStepIndex: NextStepIndex = (recipe, index, job, item) => advance(recipe, index, job, item).next;

/** The first step to run for a new job (-1 = nothing to do). */
export function firstStepIndex(recipe: Recipe, job: Job, item: Item): number {
  return advance(recipe, -1, job, item).next;
}

/** Entries a `spawn_children` step makes children from (job.data[key], an array; [] when absent). */
export function childSpecs(step: RecipeStep, job: Job): any[] {
  if (!step.spawn_children) return [];
  const v = job.data?.[step.spawn_children];
  return Array.isArray(v) ? v : [];
}

// ------------------------------------------------------------------ validation

export interface RecipeProblem { recipe: string; step?: string; problem: string }

/**
 * Check every recipe: unknown step names (not in STEPS), unknown `when` conditions, `goto` targets that do not exist,
 * a bad `max`, unknown step keys, an unknown job type, yaml recipes hidden by a playbook, unreadable yaml files.
 * `stepNames` defaults to the STEPS registry (engine/steps.ts, loaded on demand).
 */
export async function validate(recipes: Map<string, Recipe> = loadRecipes(), stepNames?: Iterable<string>): Promise<RecipeProblem[]> {
  const names = new Set(stepNames ?? Object.keys((await import("../engine/steps.js")).STEPS));
  return validateWith(recipes, names);
}

/** validate() with a known list of step names (synchronous). */
export function validateWith(recipes: Map<string, Recipe>, stepNames: Set<string>): RecipeProblem[] {
  const out: RecipeProblem[] = [];
  for (const f of loadErrors) out.push({ recipe: f.split(":")[0], problem: `could not be read – ${f}` });
  for (const n of clashes) out.push({ recipe: n, problem: "a playbook already has this name; the yaml recipe was not loaded" });
  for (const r of recipes.values()) {
    if (!JOB_TYPES.includes(r.job)) out.push({ recipe: r.name, problem: `unknown job type "${r.job}"` });
    if (!r.steps.length) out.push({ recipe: r.name, problem: "has no steps" });
    for (const s of r.steps) {
      if (!stepNames.has(s.name)) out.push({ recipe: r.name, step: s.name, problem: `unknown step "${s.name}"` });
      if (s.when !== undefined && !parseCondition(s.when)) out.push({ recipe: r.name, step: s.name, problem: `unknown condition "${s.when}"` });
      if (s.goto !== undefined && !r.steps.some((x) => x.name === s.goto)) out.push({ recipe: r.name, step: s.name, problem: `goto "${s.goto}" is not a step of this recipe` });
      if (s.max !== undefined && !(Number.isInteger(s.max) && s.max >= 1)) out.push({ recipe: r.name, step: s.name, problem: `max must be a whole number of 1 or more` });
      if (s.max !== undefined && s.goto === undefined) out.push({ recipe: r.name, step: s.name, problem: "max without goto" });
      if (s.spawn_children !== undefined && !s.spawn_children.trim()) out.push({ recipe: r.name, step: s.name, problem: "spawn_children needs a job.data key" });
      const extra: string[] | undefined = (s as any).unknownKeys;
      if (extra?.length) out.push({ recipe: r.name, step: s.name, problem: `unknown keys: ${extra.join(", ")}` });
    }
  }
  return out;
}
