/**
 * Questions with options, shown in Teams the way Claude Code shows choices:
 *
 *   ❓ **Question**
 *   The ticket says "limit the upload size" but gives no number.
 *
 *   1️⃣  10 MB   ⭐ recommended
 *
 *   2️⃣  25 MB
 *
 *   ↩️ Reply with a number, or write your own answer.
 *
 * Agents return { question, options[] } with the recommended option FIRST. Older agents (and tests) may still
 * return plain strings; those become questions without options.
 */
export interface Question { question: string; options: string[] }

/** Choices for an approval. The number the user types maps to the action. */
export const APPROVAL_CHOICES: Record<string, string[]> = {
  implement_plan: ["Approve the plan and build it", "Change something (tell me what)", "Cancel this task"],
  create_pr: ["Raise the PR", "Change something (tell me what)", "Cancel this task"],
  confirm_requirements: ["Confirm and plan it", "Change something (tell me what)", "Cancel this request"],
  post_jira_comment: ["Post it to Jira", "Change something (tell me what)", "Cancel this task"],
  post_review: ["Post all the comments to the PR", "Change something (tell me what)", "Don't post – cancel this review"],
  push_fixes: ["Push the fixes and post the replies", "Change something (tell me what)", "Don't push – cancel"],
  create_issues: ["Create the issue drafts and post the QA report", "Change something (tell me what)", "Don't post anything"],
};
export const approvalChoices = (action: string) => APPROVAL_CHOICES[action] ?? ["Approve", "Change something (tell me what)", "Cancel this task"];

export const QUESTION_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question", "options"],
    additionalProperties: false,
  },
};

export function normaliseQuestions(raw: unknown, max = 4): Question[] {
  if (!Array.isArray(raw)) return [];
  const out: Question[] = [];
  for (const q of raw) {
    if (typeof q === "string" && q.trim()) out.push({ question: q.trim(), options: [] });
    else if (q && typeof q === "object" && typeof (q as any).question === "string" && (q as any).question.trim()) {
      const opts = Array.isArray((q as any).options) ? (q as any).options.filter((o: unknown) => typeof o === "string" && o.trim()).map((o: string) => o.trim()) : [];
      out.push({ question: (q as any).question.trim(), options: opts.slice(0, 4) });
    }
  }
  return out.slice(0, max);
}

export const questionTexts = (qs: unknown) => normaliseQuestions(qs, 10).map((q) => q.question);

/** "1️⃣" … "9️⃣", then "**10.**" – easy to see in a chat. */
export const optionNumber = (i: number) => (i < 9 ? `${i + 1}️⃣` : `**${i + 1}.**`);
/** "1️⃣" typed or pasted back by the user means "1". */
export const plainNumbers = (text: string) => text.replace(/(\d)️?⃣/g, "$1");

/** Options, one per block (a blank line between them gives a visible gap in Teams); the recommended one is marked. */
function optionBlocks(options: string[]): string[] {
  return options.map((o, i) => `${optionNumber(i)}  ${o}${i === 0 && options.length > 1 ? "   ⭐ recommended" : ""}`);
}

export function formatQuestions(qs: Question[]): string {
  if (!qs.length) return "";
  const blocks: string[] = [];
  qs.forEach((q, i) => {
    blocks.push(`❓ **${qs.length > 1 ? `Question ${i + 1} of ${qs.length}` : "Question"}**\n${q.question}`);
    blocks.push(...optionBlocks(q.options));
  });
  const anyOptions = qs.some((q) => q.options.length);
  if (qs.length > 1) blocks.push(anyOptions ? `↩️ Reply with one number per question, in order (e.g. "${qs.map(() => 1).join(", ")}"), or write your own answers.` : "↩️ Reply with your answers.");
  else blocks.push(anyOptions ? "↩️ Reply with a number, or write your own answer." : "↩️ Reply with your answer.");
  return blocks.join("\n\n");
}

/** Extra reply forms for some approvals (shown under the numbered choices). */
const CHOICE_HINTS: Record<string, string> = {
  post_review: "You can also reply:\n- post 1, 3 – post only those comments\n- drop 2 – remove comment 2\n- change 2: <new text> – rewrite comment 2",
  create_issues: "You can also reply:\n- create 1, 3 – only those issues (plus the report)\n- create all – every product bug\n- report only – the QA report, no issues",
  push_fixes: "Or tell me what to change, e.g. \"for comment 2 disagree – the field is required by the API\".",
};

export function formatChoices(action: string): string {
  return [
    "**What would you like to do?**",
    ...approvalChoices(action).map((c, i) => `${optionNumber(i)}  ${c}`),
    CHOICE_HINTS[action] ?? "",
    "↩️ Reply with a number, or just write what you want changed.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Turn the user's reply into the answer text the agents see.
 *  - one question:  "2" -> option 2; "25 mb" -> that option; anything else -> their own words
 *  - several:       "1, 3" -> option 1 for Q1 and option 3 for Q2; anything else -> their own words for all
 * A number that matches no option is never guessed – the user is asked again.
 */
export function resolveReply(qs: Question[], reply: string): { ok: true; answer: string } | { ok: false; message: string } {
  const text = plainNumbers(reply).trim();
  if (!text) return { ok: false, message: "Please include your answer." };
  if (!qs.length) return { ok: true, answer: text };
  const pick = (q: Question, token: string): string | undefined => {
    const t = token.trim().replace(/[.)]$/, "");
    if (/^\d+$/.test(t)) { const n = Number(t); return n >= 1 && n <= q.options.length ? q.options[n - 1] : undefined; }
    return q.options.find((o) => o.toLowerCase() === t.toLowerCase() || o.toLowerCase().split(/\s[–-]\s/)[0] === t.toLowerCase());
  };
  const isNumberList = /^\d+(\s*[,;/ ]\s*\d+)*$/.test(text);
  if (qs.length === 1) {
    const q = qs[0];
    const chosen = pick(q, text);
    if (chosen) return { ok: true, answer: `${q.question} → ${chosen}` };
    if (isNumberList) return { ok: false, message: q.options.length ? `Please reply with a number from 1 to ${q.options.length}, or write your own answer.` : "Please write your answer in words." };
    return { ok: true, answer: `${q.question} → ${text}` };
  }
  const parts = text.split(/\s*[,;\n]\s*|\s+(?=\d+\s*$)/).filter(Boolean);
  if (isNumberList || parts.every((p) => /^\d+$/.test(p.trim()))) {
    const nums = text.split(/[^\d]+/).filter(Boolean);
    if (nums.length !== qs.length) return { ok: false, message: `There are ${qs.length} questions – reply with ${qs.length} numbers in order (e.g. "${qs.map(() => 1).join(", ")}"), or write your answers.` };
    const chosen = qs.map((q, i) => pick(q, nums[i]));
    const bad = chosen.findIndex((c) => !c);
    if (bad >= 0) return { ok: false, message: `Question ${bad + 1} has options 1 to ${qs[bad].options.length}. Please reply again.` };
    return { ok: true, answer: qs.map((q, i) => `${q.question} → ${chosen[i]}`).join("\n") };
  }
  return { ok: true, answer: `${qs.map((q) => q.question).join(" / ")} → ${text}` };
}
