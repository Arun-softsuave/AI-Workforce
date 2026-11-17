/**
 * Pre-approval and pre-push secret scan over ADDED lines of a unified diff.
 * Rules follow common gitleaks-style patterns; any hit blocks the approval request.
 */
const RULES: { id: string; re: RegExp }[] = [
  { id: "aws-access-key", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { id: "stripe-live-key", re: /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/ },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "private-key", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "generic-secret-assignment", re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i },
];

export interface SecretFinding { rule: string; file: string; line: string }

export function scanDiff(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let file = "";
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) { file = raw.replace(/^\+\+\+ (b\/)?/, ""); continue; }
    if (!raw.startsWith("+") || raw.startsWith("+++")) continue;
    const line = raw.slice(1);
    if (/example|placeholder|dummy|changeme|<your/i.test(line)) continue;
    for (const r of RULES) {
      if (r.re.test(line)) { findings.push({ rule: r.id, file, line: line.trim().slice(0, 12) + "…" }); break; }
    }
  }
  return findings;
}
