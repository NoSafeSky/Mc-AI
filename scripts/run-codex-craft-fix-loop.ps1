param(
  [int]$Iterations = 1,
  [string]$Model = "",
  [string]$RepoRoot = "C:\Projects\mc-ai-bot",
  [string]$PromptFile = "scripts/codex-craft-fix-prompt.md",
  [switch]$JsonEvents,
  [switch]$UnsafeNoSandbox
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($Iterations -lt 1) {
  throw "Iterations must be >= 1."
}

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if (-not $codexCmd) {
  throw "Codex CLI not found in PATH. Install/login first."
}

Set-Location $RepoRoot

if (-not (Test-Path $PromptFile)) {
  throw "Prompt file not found: $PromptFile"
}

$runsRoot = Join-Path $RepoRoot "memory\codex-runs"
New-Item -ItemType Directory -Path $runsRoot -Force | Out-Null

for ($i = 1; $i -le $Iterations; $i++) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $runDir = Join-Path $runsRoot "$timestamp-iter$i"
  New-Item -ItemType Directory -Path $runDir -Force | Out-Null

  $lastMessageFile = Join-Path $runDir "last-message.txt"
  $stdoutFile = Join-Path $runDir "stdout.log"
  $eventsFile = Join-Path $runDir "events.jsonl"

  $prompt = Get-Content -Raw $PromptFile
  $prompt += "`n`nRun context:`n- Iteration: $i / $Iterations`n- Timestamp: $timestamp`n- Focus: crafting reliability`n"

  $args = @(
    "exec",
    "--cd", $RepoRoot,
    "-o", $lastMessageFile
  )

  if (-not [string]::IsNullOrWhiteSpace($Model)) {
    $args += @("--model", $Model)
  }

  if ($UnsafeNoSandbox) {
    $args += "--dangerously-bypass-approvals-and-sandbox"
  } else {
    $args += "--full-auto"
  }

  if ($JsonEvents) {
    $args += "--json"
  }

  $args += "-"

  Write-Host "=== Codex craft fix iteration $i/$Iterations ==="
  Write-Host "Run directory: $runDir"

  if ($JsonEvents) {
    $prompt | & codex @args 2>&1 | Tee-Object -FilePath $eventsFile
  } else {
    $prompt | & codex @args 2>&1 | Tee-Object -FilePath $stdoutFile
  }

  Write-Host "Saved last message: $lastMessageFile"
}

Write-Host "All iterations completed."
