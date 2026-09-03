#Requires -Version 7.0
<#
  publish.ps1 - Create a public repository, publish a branch, and open a PR.

  Authentication is intentionally unified through GitHub CLI:
    1. Install GitHub CLI (`gh`).
    2. Run `gh auth login` once.
    3. Run `gh auth setup-git` once.

  The script deliberately ignores GH_TOKEN and GITHUB_TOKEN while it runs, so
  Git, gh, and this script all use the same credential stored by GitHub CLI.

  Preview safely before changing anything:
    pwsh .\publish.ps1 -CreateRepo -OpenPr -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Owner = 'rvvrvrv',
  [string]$Repo = 'xdu-autoselect',
  [string]$Branch,
  [string]$Base = 'main',
  [string]$Message = 'feat: update',
  [string]$Title,
  [string]$Description = '选课系统',
  [switch]$CreateRepo,
  [switch]$OpenPr
)

$ErrorActionPreference = 'Stop'
$preview = [bool]$WhatIfPreference

if (-not $Branch) { $Branch = 'feat/' + (Get-Date -Format 'MMdd-HHmm') }
if (-not $Title) { $Title = "${Repo}: $Message" }

$ghCommand = Get-Command gh -ErrorAction SilentlyContinue
if ($ghCommand) {
  $ghPath = $ghCommand.Source
} else {
  $installedGh = Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'
  if (-not (Test-Path -LiteralPath $installedGh)) {
    throw '未找到 GitHub CLI。请安装 gh 后执行 gh auth login。'
  }
  $ghPath = $installedGh
}

function Format-ExternalCommand {
  param([string]$Command, [string[]]$Arguments)

  $renderedArguments = $Arguments | ForEach-Object {
    if ($_ -match '\s') { '"' + $_.Replace('"', '\"') + '"' } else { $_ }
  }
  "$Command $($renderedArguments -join ' ')"
}

function Invoke-Gh {
  param([string[]]$Arguments)

  if ($preview) {
    Write-Output "[DRY RUN] $(Format-ExternalCommand -Command 'gh' -Arguments $Arguments)"
    return
  }

  & $ghPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "gh 命令失败：$(Format-ExternalCommand -Command 'gh' -Arguments $Arguments)"
  }
}

function Invoke-Git {
  param([string[]]$Arguments)

  if ($preview) {
    Write-Output "[DRY RUN] $(Format-ExternalCommand -Command 'git' -Arguments $Arguments)"
    return
  }

  & git @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "git 命令失败：$(Format-ExternalCommand -Command 'git' -Arguments $Arguments)"
  }
}

# Codex may inject a connector token. Do not let it override the user's gh login.
$savedTokenEnvironment = @{}
foreach ($name in 'GITHUB_TOKEN', 'GH_TOKEN') {
  $savedTokenEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

try {
  $repoRef = "${Owner}/${Repo}"
  $remoteUrl = "https://github.com/${Owner}/${Repo}.git"

  if ($preview) {
    Invoke-Gh @('auth', 'status', '--hostname', 'github.com')
    Invoke-Gh @('repo', 'view', $repoRef)
    if ($CreateRepo) {
      Write-Output "[DRY RUN] if repository is missing: $(Format-ExternalCommand -Command 'gh' -Arguments @('repo', 'create', $repoRef, '--public', '--description', $Description))"
    }
  } else {
    Invoke-Gh @('auth', 'status', '--hostname', 'github.com') | Out-Null
    & $ghPath repo view $repoRef 2>$null
    $repoExists = $LASTEXITCODE -eq 0
    if (-not $repoExists) {
      if (-not $CreateRepo) {
        throw "仓库 $repoRef 不存在；如需自动创建，请加 -CreateRepo。"
      }
      Invoke-Gh @('repo', 'create', $repoRef, '--public', '--description', $Description) | Out-Null
      Write-Host "[ok] repo created: $repoRef" -ForegroundColor Green
    } else {
      Write-Host "[ok] repo exists: $repoRef" -ForegroundColor Green
    }
  }

  if ($preview) {
    Invoke-Git @('remote', 'get-url', 'origin')
    Write-Output "[DRY RUN] set origin to $remoteUrl when it is missing or points elsewhere"
  } else {
    $currentOrigin = & git remote get-url origin 2>$null
    if ($LASTEXITCODE -eq 0 -and $currentOrigin -ne $remoteUrl) {
      Invoke-Git @('remote', 'set-url', 'origin', $remoteUrl) | Out-Null
    } elseif ($LASTEXITCODE -ne 0) {
      Invoke-Git @('remote', 'add', 'origin', $remoteUrl) | Out-Null
    }
    Write-Host "[ok] origin -> $remoteUrl" -ForegroundColor Green
  }

  if ($preview) {
    Invoke-Git @('show-ref', '--verify', '--quiet', "refs/heads/$Branch")
    Write-Output "[DRY RUN] switch to existing branch '$Branch', or create it from the current commit"
  } else {
    & git show-ref --verify --quiet "refs/heads/$Branch"
    if ($LASTEXITCODE -eq 0) {
      Invoke-Git @('switch', $Branch) | Out-Null
    } else {
      Invoke-Git @('switch', '--create', $Branch) | Out-Null
    }
  }

  if ($preview) {
    Invoke-Git @('add', '-A')
    Write-Output "[DRY RUN] commit staged changes with message: $Message"
    Invoke-Git @('push', '--set-upstream', 'origin', $Branch)
  } else {
    Invoke-Git @('add', '-A') | Out-Null
    & git diff --cached --quiet
    if ($LASTEXITCODE -eq 1) {
      Invoke-Git @('commit', '--message', $Message) | Out-Null
      Write-Host "[ok] committed: $Message" -ForegroundColor Green
    } elseif ($LASTEXITCODE -ne 0) {
      throw '无法检查暂存区状态。'
    } else {
      Write-Host '[ok] nothing to commit, skip' -ForegroundColor Yellow
    }
    Invoke-Git @('push', '--set-upstream', 'origin', $Branch) | Out-Null
    Write-Host "[ok] pushed origin/$Branch" -ForegroundColor Green
  }

  if ($OpenPr) {
    $headRef = "${Owner}:${Branch}"
    $encodedHeadRef = [uri]::EscapeDataString($headRef)
    $pullsEndpoint = "repos/${Owner}/${Repo}/pulls?head=${encodedHeadRef}&state=open&per_page=1"
    if ($preview) {
      Invoke-Gh @('api', '--method', 'GET', $pullsEndpoint)
      Write-Output "[DRY RUN] if no PR exists: $(Format-ExternalCommand -Command 'gh' -Arguments @('api', '--method', 'POST', "repos/${Owner}/${Repo}/pulls", '-f', "title=$Title", '-f', "head=$Branch", '-f', "base=$Base", '-f', "body=$Message"))"
    } else {
      $existingPr = & $ghPath api --method GET $pullsEndpoint --jq '.[0].html_url'
      if ($LASTEXITCODE -ne 0) {
        throw '无法查询已有 Pull Request。'
      }
      if ($existingPr) {
        Write-Host "[ok] PR: $existingPr" -ForegroundColor Green
      } else {
        $createdPr = & $ghPath api --method POST "repos/${Owner}/${Repo}/pulls" -f "title=$Title" -f "head=$Branch" -f "base=$Base" -f "body=$Message" --jq '.html_url'
        if ($LASTEXITCODE -ne 0 -or -not $createdPr) {
          throw 'PR 已创建，但无法读取链接。'
        }
        Write-Host "[ok] PR: $createdPr" -ForegroundColor Green
      }
    }
  }
} finally {
  foreach ($name in 'GITHUB_TOKEN', 'GH_TOKEN') {
    [Environment]::SetEnvironmentVariable($name, $savedTokenEnvironment[$name], 'Process')
  }
}