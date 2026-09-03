#Requires -Version 7.0
<#
  activate-login.ps1 - Strip the GitHub token env vars Codex may inject so that
  GitHub CLI (and therefore git) always uses the single credential saved by
  `gh auth login` (stored in the OS keyring).

  Why: Codex can inject GH_TOKEN / GITHUB_TOKEN into the environment. If a token
  env var is present, gh prefers it over your own login, which can surprise git
  push or ./publish.ps1. This script removes those env vars for this session and
  then shows which account is active.

  Run it once at the start of any terminal where you will use git push or
  ./publish.ps1:
    pwsh .\activate-login.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

foreach ($name in 'GH_TOKEN', 'GITHUB_TOKEN') {
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
Write-Host '[ok] removed GH_TOKEN / GITHUB_TOKEN for this session' -ForegroundColor Cyan

$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
if ($ghCommand) {
  $gh = $ghCommand.Source
} else {
  $gh = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
}

if (-not (Test-Path -LiteralPath $gh)) {
  throw "未找到 GitHub CLI：$gh"
}
& $gh --version | Out-Null
if ($LASTEXITCODE -ne 0) {
  throw "GitHub CLI 无法运行：$gh"
}

& $gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
  throw 'gh 未登录。请先运行 gh auth login。'
}

Write-Host '[ok] 已切换为单一 GitHub CLI 登录，可安全执行 git push 或 .\publish.ps1' -ForegroundColor Green