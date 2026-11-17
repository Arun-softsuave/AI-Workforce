import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/** Must be imported FIRST by every test file: isolates all state in a temp AIW_HOME. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-test-"));
process.env.AIW_HOME = home;
process.env.AIW_SECRETS = "memory";
process.env.AIW_DISABLE_DESKTOP = "1";
process.env.AIW_BROWSER ??= "no-browser-in-tests";        // the ticket report is saved as HTML, no PDF printing
process.env.AIW_DISABLE_FILE_SHARE = "1";
process.env.AIW_NO_DOCKER = "1";                           // tests never start Docker
process.env.AIW_PLAYBOOKS = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "..", "playbooks");

export const testHome = home;

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A real git repo with a bare "origin" so fetch/rebase/push are exercised for real. */
export function makeRepo(name = "payment-service"): { repo: string; origin: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aiw-repo-"));
  const origin = path.join(base, `${name}.git`);
  const repo = path.join(base, name);
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", origin]);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "dev@example.com");
  sh(repo, "config", "user.name", "Dev");
  fs.mkdirSync(path.join(repo, "src", "services"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# Payment service\n\nHandles payments and refunds through Stripe.\n");
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name, scripts: { test: "node -e \"process.exit(0)\"" }, dependencies: { express: "^4", stripe: "^14" } }, null, 2));
  fs.writeFileSync(path.join(repo, "src", "services", "refund.ts"), "import { stripe } from './stripe';\nexport async function refund(paymentId: string) {\n  return stripe.refunds.create({ payment_intent: paymentId });\n}\n");
  fs.writeFileSync(path.join(repo, "src", "services", "stripe.ts"), "export const stripe: any = {};\n");
  fs.writeFileSync(path.join(repo, "src", "app.ts"), "import { refund } from './services/refund';\nconst app: any = {};\napp.post('/payments/:id/refund', (req: any) => refund(req.params.id));\n");
  sh(repo, "add", "-A");
  sh(repo, "commit", "-q", "-m", "initial");
  sh(repo, "remote", "add", "origin", origin);
  sh(repo, "push", "-q", "origin", "main");
  return { repo, origin };
}

export async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 20_000, everyMs = 50): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
