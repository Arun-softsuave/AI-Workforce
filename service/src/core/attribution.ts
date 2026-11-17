/**
 * HARD CONSTRAINT: nothing that leaves this machine may say or imply that Claude / AI / AI Workforce did the work.
 * Applies to commit messages and authors, branch names, PR titles and bodies, Jira comments, and code/comments in the diff.
 * Enforced in three places: agents are told (system prompts), outgoing text is sanitised, and the diff is checked before
 * approval and again before publishing – a hit sends the change back to the implementer or blocks the publish.
 */
export const ATTRIBUTION_PATTERNS: RegExp[] = [
  // whole phrases first, so "(prepared by AI Workforce)" is removed completely
  /\b(generated|written|created|prepared|authored|produced|drafted|made)\s+(by|with|using)\s+(the\s+)?(ai[\s-]*workforce|claude(\s*code)?|anthropic)\b/i,
  /\bclaude(\s*code)?\b/i,
  /\banthropic\b/i,
  /\bai[\s-]*workforce\b/i,
  /co-authored-by:[^\n]*(claude|anthropic|\bai\b|bot)/i,
  /\b(generated|written|created|prepared|authored|produced|drafted)\s+(by|with|using)\s+(an?\s+)?(ai|a\.i\.|llm|gpt|chatgpt|copilot|assistant|bot|claude)\b/i,
  /\bai[\s-](generated|written|assisted|authored)\b/i,
  /🤖/u,
];

export function attributionHits(text: string): string[] {
  const hits = new Set<string>();
  for (const re of ATTRIBUTION_PATTERNS) {
    const m = re.exec(text);
    if (m) hits.add(m[0]);
  }
  return [...hits];
}

/** Remove attribution from outgoing text: whole lines that mention it are dropped; inline mentions are cut out. */
export function stripAttribution(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => !/co-authored-by:/i.test(l) || !attributionHits(l).length);
  const cleaned = lines.map((l) => {
    if (!attributionHits(l).length) return l;
    let out = l;
    for (const re of ATTRIBUTION_PATTERNS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"), "");
    out = out.replace(/\(\s*\)|\[\s*\]/g, "").replace(/\s{2,}/g, " ").replace(/\s+([.,;:])/g, "$1").trim();
    return /^[\s\-_*.,;:|]*$/.test(out) ? null : out;
  }).filter((l): l is string => l !== null);
  return cleaned.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Added lines in a unified diff that contain attribution (paths under .ai-workforce/ are ignored – they never leave). */
export function attributionInDiff(diff: string): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) { file = raw.replace(/^\+\+\+ (b\/)?/, ""); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++") || file.startsWith(".ai-workforce/")) continue;
    if (attributionHits(raw.slice(1)).length) out.push({ file, line: raw.slice(1).trim().slice(0, 120) });
  }
  return out;
}

export const NO_ATTRIBUTION_RULE =
  "HARD RULE: never mention Claude, Anthropic, AI, an assistant, a bot or \"AI Workforce\" as the author of anything – not in code, " +
  "comments, docstrings, commit messages, branch names, PR titles/descriptions, test names or Jira text. Never add Co-Authored-By trailers " +
  "or \"generated with/by\" notes. Write everything as the developer's own work.";
