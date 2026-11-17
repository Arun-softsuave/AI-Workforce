---
description: Connect or reconnect a tool (jira, github, notion, figma, slack, teams)
argument-hint: <tool>
allowed-tools: Bash(aiw:*)
---
Connect the way Claude connects to MCP servers – a browser sign-in, no tokens:
- jira, github, notion: run `aiw connect $ARGUMENTS` in the background. Tell me a browser page opens (the URL, and for GitHub a one-time code, is printed) and wait until it finishes.
- figma (token first – it stays connected when the Figma app is closed): run `aiw connect figma`. A local page opens where I paste a Figma personal access token (Figma → Settings → Security → Personal access tokens; scopes File content: read-only and Current user: read). Never ask for the token in chat. Only if I ask for the desktop app instead: `aiw connect figma --desktop` (the app must be open with its MCP server enabled); if it is not reachable, show me the printed steps.
- slack, teams (work webhook): these have no browser sign-in. Run `aiw connect $ARGUMENTS --browser` so I can enter the token / URL in a local page.

Only if a browser sign-in fails (jira, github, notion), offer the fallback `aiw connect $ARGUMENTS --browser` (never ask me to paste secrets in chat). Afterwards run `aiw connections` to confirm.
