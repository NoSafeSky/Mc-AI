param(
  [switch]$SkipUnit,
  [switch]$NoStartBot,
  [switch]$NoResetLog,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

if (-not $SkipUnit) {
  Write-Host "Running targeted unit tests for checklist..."
  node --test `
    test/objective_manager.test.js `
    test/craft_executor.test.js `
    test/gather_expansion.test.js `
    test/gather_tool_gate.test.js `
    test/goal_compiler.test.js `
    test/planner_stopall.test.js `
    test/assistant_queue.test.js
  if ($LASTEXITCODE -ne 0) {
    throw "Targeted checklist unit tests failed."
  }
}

Write-Host "Running live checklist validation..."
$args = @("scripts/run-checklist-live.js")
if ($NoStartBot) { $args += "--no-start-bot" }
if ($NoResetLog) { $args += "--no-reset-log" }
if ($DryRun) { $args += "--dry-run" }

node @args
if ($LASTEXITCODE -ne 0) {
  throw "Live checklist validation failed."
}

Write-Host "Checklist suite completed."
