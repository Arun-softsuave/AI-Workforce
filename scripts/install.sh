#!/usr/bin/env sh
# AI Workforce – local install (macOS / Linux). Safe to re-run.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "1/4 Checking Node.js and git..."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<13)){console.error("Node.js 22.13+ required");process.exit(1)}'
git --version >/dev/null
echo "2/4 Installing dependencies and building the service..."
(cd "$ROOT/service" && npm ci --no-audit --no-fund && npm run build)
echo "3/4 Linking the 'aiw' command into ~/.local/bin ..."
mkdir -p "$HOME/.local/bin" && ln -sf "$ROOT/bin/aiw" "$HOME/.local/bin/aiw"
echo "4/4 Registering the plugin with Claude Code..."
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace add "$ROOT" && claude plugin install ai-workforce@ai-workforce-local
else
  echo "   In Claude Code run: /plugin marketplace add $ROOT  then  /plugin install ai-workforce@ai-workforce-local"
fi
echo "Done. Restart Claude Code, then run /ai-workforce:aiw-setup (or 'aiw setup')."
