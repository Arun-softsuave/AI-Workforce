/**
 * A role is configuration, not a separate set of agents:
 * it selects which playbooks react to which triggers and which connectors are recommended.
 */
export interface RoleDef {
  id: string;
  label: string;
  recommended: string[];      // connectors, most important first
  optional: string[];
  triggers: string[];         // event kinds this role reacts to
}

export const ROLES: RoleDef[] = [
  { id: "backend-developer", label: "Backend Developer", recommended: ["jira", "github"], optional: ["slack", "teams", "notion"], triggers: ["assigned", "ci_failed"] },
  { id: "frontend-developer", label: "Frontend Developer", recommended: ["jira", "github", "figma"], optional: ["slack", "teams"], triggers: ["assigned", "ci_failed"] },
  { id: "fullstack-developer", label: "Full Stack Developer", recommended: ["jira", "github"], optional: ["figma", "slack", "teams"], triggers: ["assigned", "ci_failed"] },
  { id: "qa-engineer", label: "QA Engineer", recommended: ["jira", "github"], optional: ["slack", "teams"], triggers: ["ready_for_qa"] },
  { id: "devops-engineer", label: "DevOps Engineer", recommended: ["github"], optional: ["slack", "teams", "jira"], triggers: ["ci_failed"] },
  { id: "business-analyst", label: "Business Analyst", recommended: ["jira", "notion"], optional: ["slack", "teams"], triggers: ["epic_created"] },
  { id: "project-manager", label: "Project Manager", recommended: ["jira"], optional: ["slack", "teams", "notion"], triggers: ["daily_digest"] },
  { id: "uiux-designer", label: "UI/UX Designer", recommended: ["figma", "jira"], optional: ["notion", "slack", "teams"], triggers: ["design_review"] },
];

export const roleById = (id: string) => ROLES.find((r) => r.id === id);
export const isDeveloper = (roles: string[]) => roles.some((r) => /developer$/.test(r));

export function recommendConnectors(roles: string[]): { recommended: string[]; optional: string[] } {
  const rec = new Set<string>(), opt = new Set<string>();
  for (const r of roles.map(roleById).filter(Boolean) as RoleDef[]) {
    r.recommended.forEach((c) => rec.add(c));
    r.optional.forEach((c) => opt.add(c));
  }
  rec.forEach((c) => opt.delete(c));
  return { recommended: [...rec], optional: [...opt] };
}

/** Which playbook handles a given trigger for a project's roles. */
export function playbookFor(trigger: string, size?: string): string | undefined {
  switch (trigger) {
    case "assigned": return size === "S" ? "dev-small-change" : "dev-feature";
    case "ready_for_qa": return "qa-test-plan";
    case "ci_failed": return "devops-ci-failure";
    case "epic_created": return "ba-stories";
    case "daily_digest": return "pm-daily-digest";
    case "design_review": return "design-review";
    default: return undefined;
  }
}
