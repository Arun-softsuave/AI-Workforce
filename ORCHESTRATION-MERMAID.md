# AI Workforce – agentic orchestration in Mermaid

The complete orchestration of the new design (see `DESIGN-ORCHESTRATION.md` and `AIW-System-Design.html`), as Mermaid diagrams.
Paste any block into Mermaid (mermaid.ai / mermaid.live), GitHub, or a Markdown viewer that supports Mermaid.

**Colour key** (used in every diagram):

| Colour | Meaning | Cost |
|---|---|---|
| grey | plain code | free |
| green | Haiku | cheap |
| blue | Sonnet | most agent work |
| violet | Opus | planning and coding size M/L work |
| amber | you, or a gate | a decision |

---

## 1. The whole system

```mermaid
flowchart TB
  subgraph IN["Inputs - local polling, no server"]
    direction LR
    T["Teams chat<br/>3-10 s adaptive"]
    J["Jira + ticket index"]
    G["GitHub<br/>ETag, 304 = free"]
    F["Figma<br/>token"]
    H["Connector health<br/>every 5 min"]
    CL["Clock<br/>digest, expiry"]
  end

  T --> FP{"Fast path<br/>rule matches?"}
  FP -- "yes: yes / 1 / status" --> ACT["Act at once"]
  FP -- "no" --> CON["Conductor<br/>Sonnet + tools"]
  J --> EV["Event log"]
  G --> EV
  F --> EV
  H --> EV
  CL --> EV

  ACT --> WG[("Work graph - SQLite<br/>items, edges, jobs, steps,<br/>events, decisions, directives,<br/>contracts, chat")]
  CON --> WG
  EV --> RX["Reactions<br/>event to job rules"]
  RX --> MB["Item mailbox<br/>one job at a time per item"]
  MB --> SCH["Scheduler<br/>waves, 5 slots, 2 builds per repo,<br/>area locks, priority, budgets"]
  SCH --> REC["Recipe runner<br/>durable steps, resume in-flight step only"]
  REC <--> WG
  REC --> AG["Agents<br/>Claude Agent SDK"]
  AG <--> BRK["Context broker"]
  BRK <--> CACHE[("Context cache<br/>+ agent cache")]
  BRK --> KN["Knowledge agent"]
  REC --> GATE{"Policy and<br/>safety gate"}
  GATE -- "allowed" --> EFF["Effectors<br/>push, PR, comment,<br/>issue, Jira"]
  GATE -- "needs your OK" --> MSG
  REC --> MSG["Messenger<br/>short templates, merge,<br/>details on request"]
  MSG --> T

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef haiku fill:#e1f3ea,stroke:#1d7a55,color:#17202b
  classDef opus fill:#eee6fa,stroke:#6a3fb5,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class T,J,G,F,H,CL,FP,ACT,EV,RX,MB,SCH,REC,BRK,MSG,EFF,WG,CACHE code
  class CON,AG,KN sonnet
  class GATE you
```

---

## 2. A Teams message: fast path or Conductor

```mermaid
flowchart TD
  M["Your message"] --> R{"Fast path rule?<br/>reply to the focus item,<br/>status, exact command"}
  R -- "yes" --> X["Do it - under 1 s"] --> OUT["One short reply"]
  R -- "no" --> CTX["Build context by code<br/>cached prefix: instructions + tools<br/>working set: every active item<br/>last 20 turns + summary"]
  CTX --> C["Conductor - Sonnet"]
  C --> TOOLS{"Which tools?"}
  TOOLS --> T1["find<br/>key, link, name, epic,<br/>sprint, PR, branch, history"]
  TOOLS --> T2["start / preview_scope"]
  TOOLS --> T3["decide<br/>approve, reject, answer"]
  TOOLS --> T4["set_directive<br/>no approval, backend only"]
  TOOLS --> T5["fix_pr / review / qa / adopt"]
  TOOLS --> T6["status / explain / lookup"]
  TOOLS --> T7["control<br/>pause, cancel, priority, undo"]
  T1 --> AMB{"Ambiguous or<br/>destructive?"}
  T2 --> AMB
  T3 --> AMB
  T4 --> AMB
  T5 --> AMB
  T7 --> AMB
  AMB -- "yes" --> ASK["One short question"] --> OUT
  AMB -- "no" --> WG[("Work graph<br/>items, jobs, directives")] --> OUT
  T6 --> OUT

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class R,X,CTX,TOOLS,T1,T2,T3,T4,T5,T6,T7,AMB,WG,OUT code
  class C sonnet
  class M,ASK you
```

---

## 3. Life of a work item (ticket, part, PR, branch, audit)

```mermaid
stateDiagram-v2
  [*] --> NEW
  NEW --> UNDERSTANDING
  UNDERSTANDING --> NEEDS_INFO: product question
  NEEDS_INFO --> UNDERSTANDING: you answer
  UNDERSTANDING --> PLANNED
  PLANNED --> AWAITING_PLAN_OK: plan approval on
  PLANNED --> BUILDING: no approval needed
  AWAITING_PLAN_OK --> BUILDING: approve
  AWAITING_PLAN_OK --> PLANNED: change requested
  BUILDING --> BLOCKED: dependency or connector
  BLOCKED --> BUILDING: unblocked
  BUILDING --> READY: tests, reviews, standards pass
  READY --> AWAITING_PR_OK: PR approval on
  READY --> PR_OPEN: no approval needed
  AWAITING_PR_OK --> PR_OPEN: approve
  state PR_OPEN {
    [*] --> Watching
    Watching --> CiFix: ci_failed
    CiFix --> Watching: fix pushed
    Watching --> CommentFix: resolve comments
    CommentFix --> Watching: pushed and replied
    Watching --> Rebase: conflict with dev
    Rebase --> Watching
    Watching --> QA: QA requested
    QA --> Watching: issues created
  }
  PR_OPEN --> MERGED: pr_merged
  PR_OPEN --> CLOSED: closed without merge
  MERGED --> DONE: close, unblock dependents, learn
  CLOSED --> PAUSED: drop or reopen?
  DONE --> [*]
```

---

## 4. The ticket recipe: code edges and model-chosen branches

Diamonds marked **model** take the branch chosen by an agent's structured answer. Diamonds marked **code** are plain rules.

```mermaid
flowchart TD
  S(["start"]) --> TR["Triage - Haiku"]
  TR --> D1{"model: size?"}
  D1 -- "S" --> SMALL["small-change recipe<br/>Sonnet throughout"]
  D1 -- "M / L" --> UND["Understand - Opus<br/>cached context + code by search"]
  UND --> D2{"model: repos?"}
  D2 -- "one repo" --> PLAN
  D2 -- "two repos" --> LEAD["Lead: contract + parts<br/>sequential or parallel"]
  LEAD --> PLAN
  UND --> Q{"model: open questions?"}
  Q -- "yes" --> KA["Knowledge agent"]
  KA --> Q2{"model: product decision?"}
  Q2 -- "no" --> PLAN
  Q2 -- "yes" --> YOU1["Ask you<br/>all questions in one message"] --> PLAN
  Q -- "no" --> PLAN["Plan - Opus"]
  PLAN --> PR1["Plan review - Sonnet"]
  PR1 --> D3{"model: pass?"}
  D3 -- "no" --> PLAN
  D3 -- "yes" --> G1{"code: plan approval needed?"}
  G1 -- "yes" --> YOU2["One short plan message"] --> BUILD
  G1 -- "no" --> INFO["Plan sent as information"] --> BUILD
  SMALL --> BUILD["Build + targeted tests<br/>Opus M/L, Sonnet S"]
  BUILD --> D4{"code: tests and lint pass?"}
  D4 -- "no, round 3 or less" --> BUILD
  D4 -- "yes" --> REV["Code, security, QA reviewers<br/>Sonnet x3 in parallel"]
  REV --> D5{"model: blocker?"}
  D5 -- "yes, 2 rounds or less" --> BUILD
  D5 -- "no" --> STD["Standards guard<br/>docstrings, stray files"]
  STD --> PRE["Prepublish<br/>rebase, secrets, no AI mention"]
  PRE --> G2{"code: PR approval needed?"}
  G2 -- "yes" --> YOU3["One approval message"] --> PUB
  G2 -- "no" --> PUB["Publish<br/>normal PR, reviewers,<br/>screenshots, merge order"]
  PUB --> OPEN(["PR_OPEN - events take over"])

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef haiku fill:#e1f3ea,stroke:#1d7a55,color:#17202b
  classDef opus fill:#eee6fa,stroke:#6a3fb5,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class S,OPEN,D4,G1,G2,STD,PRE,PUB,INFO code
  class TR haiku
  class SMALL,PR1,REV,KA,D1,D2,D3,D5,Q,Q2 sonnet
  class UND,LEAD,PLAN,BUILD opus
  class YOU1,YOU2,YOU3 you
```

---

## 5. Events drive everything after the request

```mermaid
flowchart LR
  subgraph EVENTS["Events"]
    direction TB
    E1["ticket_assigned"]
    E2["ticket_changed"]
    E3["ci_failed"]
    E4["ci_passed"]
    E5["comment_added"]
    E6["teammate_pr_opened"]
    E7["review_requested"]
    E8["new_commits"]
    E9["pr_conflict"]
    E10["pr_merged"]
    E11["pr_closed"]
    E12["connector_down / up"]
    E13["clock"]
  end
  subgraph JOBS["Jobs on the item"]
    direction TB
    J1["build"]
    J2["replan delta"]
    J3["ci_fix - no asking"]
    J5["notify, or comment_fix if auto"]
    J7["review if auto, else notify"]
    J8["rebase local work, or notify reviewer"]
    J9["rebase"]
    J10["close, unblock dependents,<br/>re-target stacked PRs, learn"]
    J11["pause: drop or reopen?"]
    J12["block or resume jobs"]
    J13["digest, expire approvals"]
    N["notify only"]
  end
  E1 --> J1
  E2 --> J2
  E3 --> J3
  E4 --> N
  E5 --> J5
  E6 --> N
  E7 --> J7
  E8 --> J8
  E9 --> J9
  E10 --> J10
  E11 --> J11
  E12 --> J12
  E13 --> J13
  JOBS --> MB["Item mailbox<br/>one job at a time,<br/>duplicates merged"]

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  class E1,E2,E3,E4,E5,E6,E7,E8,E9,E10,E11,E12,E13,J1,J2,J3,J5,J7,J8,J9,J10,J11,J12,J13,N,MB code
```

---

## 6. Sprint, epic and batch: hierarchical orchestration

```mermaid
flowchart TD
  REQ["build sprint 14 / the onboarding epic /<br/>do KAN-45, KAN-47 and the templates task"] --> FIND["find: resolve every target - code"]
  FIND --> PREV["Preview: count, repos, estimate<br/>always for sprints - code"]
  PREV --> YOK{"you: start?"}
  YOK -- "yes" --> CTXO["Understand the whole scope once<br/>Haiku distils, Opus reads"]
  CTXO --> SP["Scope planner - Opus<br/>tickets, repos, dependencies,<br/>contracts, waves, merge order, gaps"]
  SP --> GP{"code: scope approval needed?"}
  GP -- "yes" --> YP["One plan message"] --> W
  GP -- "no" --> W["Scheduler: wave 1"]
  W --> T1["KAN-45<br/>ticket recipe"]
  W --> T2["KAN-52<br/>ticket recipe"]
  T1 --> PR1["PR #140"]
  T2 --> PR2["PR #142"]
  PR1 --> W2["wave 2: dependency met"]
  W2 --> T3["KAN-47<br/>stacked on #140"]
  T3 --> PR3["PR #141 based on #140"]
  PR1 --> MO["Merge order<br/>1. #140  2. #141  3. #142<br/>in PRs, Teams, status"]
  PR3 --> MO
  PR2 --> MO
  MO --> EC["Epic check - Sonnet<br/>criteria x merged code"]
  EC --> SUM["One summary: shipped, follow-ups, cost"]
  T3 -. "needs a contract change" .-> SP
  SP -. "contract v2" .-> T1

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef opus fill:#eee6fa,stroke:#6a3fb5,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class FIND,PREV,GP,W,W2,PR1,PR2,PR3,MO,SUM code
  class CTXO,SP,T1,T2,T3 opus
  class EC sonnet
  class REQ,YOK,YP you
```

---

## 7. Inside a job: the two routes for every need

```mermaid
flowchart LR
  A["Agent working on a step"] --> N{"What does it need?"}
  N -- "information to keep going" --> R1["Route 1 - tool call in the same turn"]
  R1 --> BR["Context broker"]
  BR --> L1["figma frame, need"]
  BR --> L2["code search / read / map"]
  BR --> L3["ticket, prd, contract, history"]
  BR --> L4["ask question"]
  L1 --> RET["Answer returned, cited,<br/>agent keeps working"]
  L2 --> RET
  L3 --> RET
  L4 --> RET
  N -- "changes the plan, another item,<br/>or needs a person" --> R2["Route 2 - end the step with a result"]
  R2 --> K["Kernel routes an event"]
  K --> O1["contract_change: lead or planner decides"]
  K --> O2["review blocker: back to build with findings"]
  K --> O3["product question: you, others keep running"]
  K --> O4["ticket changed: delta re-plan at next step"]

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class N,R1,BR,L1,L2,L3,RET,R2,K,O1,O2,O4 code
  class A,L4 sonnet
  class O3 you
```

---

## 8. The implementer needs Figma again

```mermaid
sequenceDiagram
  autonumber
  participant I as Implementer - Opus
  participant B as Context broker - code
  participant C as Cache
  participant F as Figma API - token
  participant H as Distiller - Haiku
  Note over I: building the invite modal for KAN-52
  I->>B: figma("Invite modal", need: spacing, error state)
  B->>B: check policy and budget
  B->>C: lookup file + node 812:44 + file version
  alt cached spec card exists
    C-->>B: spec card
  else miss
    B->>F: get node 812:44 only, never the whole file
    F-->>B: design data
    B->>H: distil, map colours to repo design tokens
    H-->>B: spec card, about 1.5k tokens
    B->>C: store under file + node + version
  end
  B-->>I: spec card with source and version
  Note over I: keeps building in the same turn
  Note over C: reviewer and screenshotter later read it for free
```

---

## 9. The plugin needs to understand the code again

```mermaid
flowchart TD
  J["A later job on the item<br/>CI fix, comments, continue, adopt"] --> NOTE[("Item code note<br/>files, entry points, flow<br/>stamped with commit SHA + file hashes")]
  NOTE --> DIFF["git diff note SHA..now<br/>on the note's files - code"]
  DIFF --> D{"How much changed?"}
  D -- "nothing" --> REUSE["Reuse the note<br/>0 tokens"]
  D -- "some files" --> DELTA["Delta re-read - Sonnet<br/>changed files + failing test only"]
  D -- "over 30 percent or restructured" --> FULL["Full re-understand - Opus<br/>rare"]
  DELTA --> UPD["Update and re-stamp the note"]
  FULL --> UPD
  REUSE --> CTX["Into the job's context"]
  UPD --> CTX
  CTX --> MORE{"Still missing something?"}
  MORE -- "yes" --> LIVE["Live code search via the broker<br/>exact line ranges"]
  MORE -- "no" --> GO["Job continues"]
  LIVE --> GO

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef opus fill:#eee6fa,stroke:#6a3fb5,color:#17202b
  class J,NOTE,DIFF,D,REUSE,UPD,CTX,MORE,LIVE,GO code
  class DELTA sonnet
  class FULL opus
```

---

## 10. Knowledge agent: ask the data before the human

```mermaid
flowchart TD
  Q["ask: which validator should invites use?"] --> L1{"Decision log<br/>same question, same or parent scope?"}
  L1 -- "found" --> A["Answer + evidence, back in the same turn"]
  L1 -- "no" --> L2{"Cached context<br/>ticket, PRD section, Figma notes?"}
  L2 -- "found" --> A
  L2 -- "no" --> L3{"Brain<br/>rules card, handbook, code map?"}
  L3 -- "found" --> A
  L3 -- "no" --> L4["Knowledge agent - Sonnet<br/>reads code, live lookups, 6 turns max"]
  L4 --> CF{"Confidence and kind?"}
  CF -- "high, fact" --> A
  CF -- "medium" --> AS["Use it, list as an assumption<br/>in the plan and PR"] --> A
  CF -- "low or product decision" --> U["Ask you<br/>batched, one message per item"]
  U --> A
  A --> LOG[("Write to decision log<br/>never asked again in this scope")]

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class Q,L1,L2,L3,A,AS,LOG,CF code
  class L4 sonnet
  class U you
```

---

## 11. CI fails on a PR the plugin raised

```mermaid
sequenceDiagram
  autonumber
  participant GH as GitHub
  participant P as Poller - code
  participant K as Kernel - code
  participant T as CI triage - code + Haiku
  participant FX as CI fixer - Sonnet
  participant SG as Standards guard - code
  participant Y as You in Teams
  P->>GH: checks for PR #140 head, every 60 s while running
  GH-->>P: Lint and Format failed
  P->>K: event ci_failed
  K->>K: KAN-45 mailbox, start job ci_fix
  K->>T: failed step, command, first error only
  alt caused by this PR
    T-->>FX: fix it
    FX->>FX: edit, run the same command locally
    FX->>SG: check docstrings and stray files
    SG-->>K: clean
    K->>GH: commit fix(scope) and push, no asking
    K->>P: watch the new head
    P-->>K: all checks green
    K->>Y: CI green on PR 140, fixed lint in 2 files
  else also fails on dev
    T-->>K: not this PR
    K->>Y: check is red on dev too, left alone
  else flaky or runner problem
    T-->>K: re-run the job once
  else needs a person - baseline, paid eval, secret
    T-->>K: report exactly what is needed
    K->>Y: needs you, never faked
  end
```

---

## 12. Two developers, two plugins, GitHub in the middle

```mermaid
sequenceDiagram
  autonumber
  actor S as Sneha
  participant SP as Sneha's plugin
  participant GH as GitHub
  participant EP as Eric's plugin
  actor E as Eric
  SP->>GH: open PR #140, request reviewer Eric, merge order in body
  EP->>GH: poll - new PR in project repo
  EP->>E: Sneha raised PR #140, say review PR 140
  E->>EP: review PR 140
  EP->>EP: reviewer agent - Sonnet
  EP->>E: 4 comments ready, post?
  E->>EP: post
  EP->>GH: post review comments
  SP->>GH: poll - comments added
  SP->>S: Eric left 4 comments, say resolve the comments
  S->>SP: resolve the comments
  SP->>SP: comment resolver - Sonnet, tests, standards
  SP->>GH: push, reply on each thread, re-request review
  EP->>GH: poll - new commits on PR you reviewed
  EP->>E: Sneha resolved 4 of 4, re-review?
  S->>SP: QA PR 140
  SP->>GH: create issues for product bugs, linked in PR
  EP->>E: 2 QA issues on PR 140
```

---

## 13. Review a ticket done long ago

```mermaid
flowchart TD
  M["review KAN-12"] --> F["find - code"]
  F --> S1["Jira development links"]
  F --> S2["GitHub PR search by key<br/>title, body, branch"]
  F --> S3["git log --all --grep KAN-12"]
  S1 --> PRS["PRs and commits found"]
  S2 --> PRS
  S3 --> PRS
  PRS --> MD["Merged change<br/>merge or squash commit range"]
  MD --> LATER["Later commits to the same files<br/>edits, reverts"]
  LATER --> AU["Auditor - Sonnet<br/>each criterion x merged diff x today's code"]
  AU --> V["Verdict per criterion<br/>met, partial, missing, regressed"]
  V --> MSG["One short message<br/>details on request"]
  MSG --> OFF{"you: follow up?"}
  OFF -- "create follow-up" --> JT["Jira ticket or GitHub issues"]
  OFF -- "no" --> DONE(["done - never comments on closed PRs unless asked"])

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class F,S1,S2,S3,PRS,MD,LATER,V,MSG,JT,DONE code
  class AU sonnet
  class M,OFF you
```

---

## 14. Finish my branch (adopt)

```mermaid
flowchart TD
  M["I am on feat/KAN-45/invites, finish it"] --> FE["Fetch, worktree on your branch<br/>your commits kept - code"]
  FE --> GA["Gap analysis - Sonnet<br/>ticket + criteria vs your diff"]
  GA --> PL["Plan only what is left"]
  PL --> G{"code: plan approval needed?"}
  G -- "yes" --> Y["One short message"] --> B
  G -- "no" --> B["Build on top of your commits<br/>tests, reviews, standards"]
  B --> PUSHED{"Did you push meanwhile?"}
  PUSHED -- "yes" --> RB["Rebase local work onto your commits"]
  RB --> CONF{"conflict?"}
  CONF -- "yes" --> STOP["Stop and tell you, never force"]
  CONF -- "no" --> P
  PUSHED -- "no" --> P["Normal push to your branch"]
  P --> HASPR{"PR exists?"}
  HASPR -- "yes" --> OPEN(["PR_OPEN continues"])
  HASPR -- "no" --> NEW["Raise the PR"] --> OPEN

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class FE,G,PUSHED,RB,CONF,P,HASPR,NEW,OPEN,STOP code
  class GA,PL,B sonnet
  class M,Y you
```

---

## 15. Connector health: Jira, GitHub, Figma always connected

```mermaid
flowchart TD
  CK["Every 5 min - code<br/>Jira myself, GitHub user, Figma me"] --> OK{"All reachable?"}
  OK -- "yes" --> CK
  OK -- "no" --> DOWN["connector_down event"]
  DOWN --> ALERT["Message at once:<br/>Jira disconnected, run aiw connect jira"]
  DOWN --> BLK["Jobs that need it: BLOCKED<br/>everything else keeps running"]
  ALERT --> REP["Repeat every 4 h in working hours<br/>while still down"]
  REP --> CK2{"Back?"}
  BLK --> CK2
  CK2 -- "no" --> REP
  CK2 -- "yes" --> UP["connector_up event"]
  UP --> RES["Blocked jobs resume on their own"]
  UP --> MSG["Message: Jira reconnected"]

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef you fill:#fbefd9,stroke:#a2600a,color:#17202b
  class CK,OK,DOWN,BLK,REP,CK2,UP,RES code
  class ALERT,MSG you
```

---

## 16. How one agent call is assembled (cost)

```mermaid
flowchart LR
  subgraph CALL["One agent call - blocks in this order"]
    direction LR
    B1["Role + tools<br/>about 4k - cached"] --> B2["Rules card + Brain<br/>about 3k - cached"]
    B2 --> B3["Item slice<br/>ticket, plan, contract,<br/>code note, spec cards<br/>about 5k - cached per item"]
    B3 --> B4["Step input<br/>diff, failure, findings<br/>about 3k - fresh"]
    B4 --> B5["Lookups during the turn<br/>15k max - capped"]
  end
  CALL --> R["Short structured result<br/>written to the work graph"]
  R --> NEXT["Next step reads only this result"]

  classDef code fill:#eceff3,stroke:#5b6675,color:#17202b
  classDef sonnet fill:#e3ecfa,stroke:#1f5fbf,color:#17202b
  class B1,B2,B3 code
  class B4,B5 sonnet
  class R,NEXT code
```
