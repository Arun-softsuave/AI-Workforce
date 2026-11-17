---
description: Connect or reconnect a tool (jira, github, notion, figma, slack, teams)
argument-hint: <tool>
allowed-tools: Bash(aiw:*)
---
Connect the way Claude connects to MCP servers – a browser sign-in, no tokens:
- jira, github, notion: run `aiw connect $ARGUMENTS` in the background. Tell me a browser page opens (the URL, and for GitHub a one-time code, is printed) and wait until it finishes.
- figma: run `aiw connect figma`. It uses the Figma desktop app's MCP server (no token). If it says the app is not reachable, show me the printed steps.
- slack, teams (work webhook): these have no browser sign-in. Run `aiw connect $ARGUMENTS --browser` so I can enter the token / URL in a local page.

Only if a browser sign-in fails, offer the fallback `aiw connect $ARGUMENTS --browser` (never ask me to paste secrets in chat). Afterwards run `aiw connections` to confirm.
