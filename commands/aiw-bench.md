---
description: Measure AI Workforce cost and accuracy – baseline report, benchmark runs of past tickets, and run-by-run comparison
argument-hint: "[report] | runs | plan <KAN-40 KAN-52 …> | compare <runA> <runB> | mark <runId> <ticket> yes|no"
allowed-tools: Bash(aiw:*)
---
Run `aiw bench $ARGUMENTS` (no argument = `aiw bench report`).

- **report** – the baseline from recorded runs: the costliest steps, agents and tickets, tokens, cache reads and $. Show a compact table and name the top 3 cost drivers.
- **runs** – list benchmark runs (id, version, tickets, cost).
- **plan <tickets…>** – how those past tickets would be re-run on throwaway local branches (never pushed, no Teams or Jira writes). Show it and ask me before anything else.
- **compare <runA> <runB>** – ticket by ticket; lower is better and regressions are marked. Say clearly whether the newer run kept accuracy (accepted tickets) and what it cost.
- **mark <runId> <ticket> yes|no** – record whether that ticket's result was acceptable. Only with the verdict I gave; never mark on my behalf.

Use only the numbers the command prints – don't estimate.
