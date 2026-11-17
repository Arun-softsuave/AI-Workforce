import "../core/quiet.js";

/**
 * Claude Code UserPromptSubmit hook. In a repository that is an AI Workforce project, it reminds Claude to hand ticket
 * work and new work requests to AI Workforce (plans, questions and approvals then happen in the user's Teams chat),
 * and to answer status questions from AI Workforce's task data. In any other folder it prints nothing, so Claude
 * works normally. Must be fast and must never fail or block a prompt.
 */
export function handoffContext(projectId: string, group: string | undefined, decisionsInTeams: boolean): string {
  return [
    `[AI Workforce] This folder is the AI Workforce project "${projectId}"${group ? ` (product ${group})` : ""}. For this message:`,
    "- If the user asks to work on, plan, implement or fix a Jira ticket (e.g. \"work on KAN-42\", \"plan KAN-42\"): call the aiw_run_ticket tool with the key and do NOT implement it yourself. Tell them the plan will come to their Teams chat for approval.",
    "- If the user asks for new code work WITHOUT a ticket (\"add a CSV export to the orders page\"): call aiw_start_request with their request in their words and do NOT implement it yourself. AI Workforce will ask them about the requirements in Teams first.",
    "- If they ask about the status/progress of a ticket or task: answer from aiw_task_report (fields now / waitingFor) or aiw_list_tasks.",
    decisionsInTeams
      ? "- Approvals and answers to AI Workforce questions happen ONLY in Teams. If the user tries to approve, reject or answer here, tell them to reply in the AI Workforce Teams chat."
      : "- Approvals: only call aiw_approve / aiw_reject / aiw_answer when the user explicitly says so.",
    "- Questions about the code, explanations, reviews and anything that is not a request for code changes: help normally.",
    "- If the user explicitly says to do it directly here (e.g. \"do it here\", \"without the workforce\"), work normally.",
  ].join("\n");
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || "{}") as { prompt?: string; cwd?: string };
  if (!input.prompt || input.prompt.trim().startsWith("/")) return;     // slash commands are handled by their own skills
  const { projectForPath } = await import("../engine/requests.js");
  const { loadSettings, requiredDecisionChannel } = await import("../core/config.js");
  const project = projectForPath(input.cwd ?? process.cwd());
  if (!project || project.status === "paused") return;                 // not an AI Workforce project: Claude works normally
  console.log(handoffContext(project.id, project.group, !!requiredDecisionChannel(loadSettings())));
}

if (process.argv[1] && /user-prompt\.(js|ts)$/.test(process.argv[1])) {
  const timer = setTimeout(() => process.exit(0), 8_000);
  main().catch(() => { /* never block a prompt because of the plugin */ }).finally(() => { clearTimeout(timer); });
}
