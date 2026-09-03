#Requires -Version 7.0
<#
  publish.ps1 - One-shot automation: create public repo + push branch + open PR for xdu-autoselect.

  Prereqs (choose ONE):
    * Install GitHub CLI and run `gh auth login`  (auto-requests repo / read:org / workflow)
    * OR set env var GH_TOKEN to a classic PAT (requires `repo` scope) -- only needed when gh is absent.

  Usage examples:
    pwsh .\publish.ps1 -Owner rvvrvrv -Repo xdu-autoselect -Base main -CreateRepo -OpenPr
    pwsh .\publish.ps1                                              # use defaults below
#>
param(
  [string]$Owner = "rvvrvrv",
  [string]$Repo  = "xdu-autoselect",
  [string]$Branch,
  [string]$Base  = "main",
  [string]$Message = "feat: update",
  [string]$Title,
  [string]$Description = "选课系统",
  [switch]$CreateRepo,
  [switch]$OpenPr
)

$ErrorActionPreference = "Stop"
if (-not $Branch) { $Branch = "feat/" + (Get-Date -Format "MMdd-HHmm") }
if (-not $Title)  { $Title  = "$Repo: $Message" }

$gh = Get-Command gh -ErrorAction SilentlyContinue
$Token = $env:GH_TOKEN
if (-not $gh -and -not $Token) {
  throw "缺少凭证：请安装 GitHub CLI 并运行 gh auth login；或设置环境变量 GH_TOKEN（classic PAT，需 repo scope）。"
}

function Invoke-Api {
  param([string]$Method,[string]$Uri,[System.Collections.IDictionary]$Body)
  $h = @{ Accept = "application/vnd.github+json"; "User-Agent" = "publish.ps1" }
  if ($Token) { $h.Authorization = "Bearer $Token" }
  $p = @{ Method = $Method; Uri = $Uri; Headers = $h; ContentType = "application/json" }
  if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 5) }
  Invoke-RestMethod @p
}

# 1) ensure public repo
try {
  Invoke-Api GET "https://api.github.com/repos/$Owner/$Repo" | Out-Null
  Write-Host "[ok] repo exists: $Owner/$Repo" -ForegroundColor Green
} catch {
  if (-not $CreateRepo) { throw "仓库不存在，请加 -CreateRepo 以自动创建。" }
  Write-Host "[..] creating public repo $Owner/$Repo ..." -ForegroundColor Cyan
  Invoke-Api POST "https://api.github.com/user/repos" @{ name=$Repo; public=$true; description=$Description } | Out-Null
  Start-Sleep -Seconds 3
  Write-Host "[ok] repo created: $Owner/$Repo" -ForegroundColor Green
}

# 2) wire origin
$url = "https://github.com/$Owner/$Repo.git"
$cur = git remote get-url origin 2>$null
if ($cur -and $cur -ne $url) { git remote set-url origin $url }
elseif (-not $cur) { git remote add origin $url }
Write-Host "[ok] origin -> $url" -ForegroundColor Green

# 3) branch + commit + push
git checkout -B $Branch | Out-Null
git add -A
if (-not (git diff --cached --quiet)) {
  git commit -m $Message
  Write-Host "[ok] committed: $Message" -ForegroundColor Green
} else {
  Write-Host "[ok] nothing to commit, skip" -ForegroundColor Yellow
}
git push -u origin $Branch
Write-Host "[ok] pushed origin/$Branch" -ForegroundColor Green

# 4) open / reuse PR
if ($OpenPr) {
  if ($gh) {
    gh pr create --repo "$Owner/$Repo" --base $Base --head $Branch --title $Title --body $Message 2>$null
    $u = gh pr view --repo "$Owner/$Repo" --branch $Branch --json url -q .url 2>$null
    if ($u) { Write-Host "[ok] PR: $u" -ForegroundColor Green } else { Write-Warning "PR 可能已存在，或 gh 未识别分支：$Branch" }
  } else {
    $q = [uri]::EscapeDataString("$Owner:$Branch")
    $existing = try { Invoke-Api GET "https://api.github.com/repos/$Owner/$Repo/pulls?head=$q" } catch { $null }
    $pr = if ($existing) { $existing | Select-Object -First 1 } else {
      Invoke-Api POST "https://api.github.com/repos/$Owner/$Repo/pulls" @{ title=$Title; head=$Branch; base=$Base; body=$Message }
    }
    Write-Host "[ok] PR: $($pr.html_url)" -ForegroundColor Green
  }
}
