import "../core/quiet.js";
// Claude Code status line command: prints e.g. "AIW: 1 awaiting approval · 2 in progress".
try {
  const { inboxSummaryLine } = await import("../api/ops.js");
  console.log(inboxSummaryLine());
} catch {
  console.log("AIW: not set up");
}
