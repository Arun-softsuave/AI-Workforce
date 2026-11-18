/** Normalised work item – every tracker adapter maps into this shape. */
export interface WorkItem {
  provider: "jira";
  id: string;            // immutable provider id (survives key moves, e.g. PAY-142 -> CORE-88)
  key: string;
  projectKey: string;
  title: string;
  description: string;
  status: string;
  statusCategory?: string;
  assignee?: string;      // provider account id
  assigneeName?: string;
  priority?: string;
  labels: string[];
  issueType?: string;
  url: string;
  /** The parent (an epic in team-managed projects) and its type. */
  parentKey?: string;
  parentType?: string;
  updated: string;
  created?: string;
  comments?: { author: string; body: string; created: string }[];
}

export interface CiRun {
  id: string;
  repo: string;
  branch: string;
  workflow: string;
  conclusion: string;
  url: string;
  headSha: string;
  updated: string;
}

export interface ConnectionTest {
  ok: boolean;
  account?: string;
  detail?: string;
  scopes?: string[];
}

export const PRIORITY_RANK: Record<string, number> = { Highest: 1, Blocker: 1, High: 2, Critical: 1, Medium: 3, Low: 4, Lowest: 5 };
