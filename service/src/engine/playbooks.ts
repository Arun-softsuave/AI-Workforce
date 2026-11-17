import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { serviceRoot } from "../core/paths.js";

/** A playbook is a fixed recipe: code decides the order of steps, agents only work inside steps. */
export interface StepSpec { name: string; params: Record<string, any> }
export interface Playbook { id: string; title: string; roles: string[]; trigger: string; steps: StepSpec[] }

let cache: Map<string, Playbook> | undefined;

export function playbookDir(): string {
  return process.env.AIW_PLAYBOOKS ?? path.join(serviceRoot(), "playbooks");
}

export function loadPlaybooks(force = false): Map<string, Playbook> {
  if (cache && !force) return cache;
  cache = new Map();
  for (const f of fs.readdirSync(playbookDir()).filter((x) => /\.ya?ml$/.test(x))) {
    const raw = YAML.parse(fs.readFileSync(path.join(playbookDir(), f), "utf8"));
    const steps: StepSpec[] = (raw.steps ?? []).map((s: any) =>
      typeof s === "string" ? { name: s, params: {} } : { name: Object.keys(s)[0], params: Object.values(s)[0] ?? {} });
    cache.set(raw.id, { id: raw.id, title: raw.title, roles: raw.roles ?? [], trigger: raw.trigger, steps });
  }
  return cache;
}

export function getPlaybook(id: string): Playbook {
  const p = loadPlaybooks().get(id);
  if (!p) throw new Error(`Unknown playbook "${id}"`);
  return p;
}

export function stepIndex(pb: Playbook, name: string): number {
  return pb.steps.findIndex((s) => s.name === name);
}
