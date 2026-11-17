# AI Workforce – local install (Windows). Safe to re-run.
#   powershell -ExecutionPolicy Bypass -File D:\ai-workforce\scripts\install.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$service = Join-Path $root "service"

Write-Host "1/4 Checking Node.js and git..."
$nodeVersion = (node --version) -replace "v", ""
if ([version]$nodeVersion -lt [version]"22.13.0") { throw "Node.js 22.13+ is required (found $nodeVersion)" }
git --version | Out-Null

Write-Host "2/4 Installing dependencies and building the service..."
Push-Location $service
npm ci --no-audit --no-fund
npm run build
Pop-Location

Write-Host "3/4 Adding the 'aiw' command to your user PATH..."
$bin = Join-Path $root "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $bin })) {
  [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $bin), "User")
  Write-Host "   Added $bin (open a new terminal to use 'aiw')."
} else { Write-Host "   Already on PATH." }

Write-Host "4/4 Registering the plugin with Claude Code..."
if (Get-Command claude -ErrorAction SilentlyContinue) {
  claude plugin marketplace add $root
  claude plugin install ai-workforce@ai-workforce-local
} else {
  Write-Host "   Claude Code CLI not found. Inside Claude Code run:"
  Write-Host "     /plugin marketplace add $root"
  Write-Host "     /plugin install ai-workforce@ai-workforce-local"
}

Write-Host ""
Write-Host "Done. Restart Claude Code, then run /ai-workforce:aiw-setup (or 'aiw setup') to start onboarding."
