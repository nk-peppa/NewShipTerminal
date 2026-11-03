<#
  tools/launcher-update.ps1 — update-source probing and release fast-forward.

  Dot-sourced by run-terminal.ps1 (no param block on purpose: the caller keeps its
  own $Remote). Can also be run directly for diagnostics:

    powershell -NoProfile -File tools\launcher-update.ps1 -Root . -Remote origin
    powershell -NoProfile -File tools\launcher-update.ps1 -Root . -Remote origin -Apply

  Design rules:
    * Never report "up to date" when the remote could not be reached.
    * Compare the remote SHA from `git ls-remote` (read-only), not a possibly stale
      remote-tracking ref.
    * Only reset the tree when it is the `release` deployment snapshot; a dev tree
      is never rewritten.
#>

function Get-UsvGitExe {
  $cmd = Get-Command git -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $programFiles = $env:ProgramFiles
  if (-not $programFiles) { $programFiles = 'C:\Program Files' }
  $candidates = @(
    (Join-Path $programFiles 'Git\cmd\git.exe'),
    (Join-Path $programFiles 'Git\bin\git.exe'),
    'C:\Program Files (x86)\Git\cmd\git.exe'
  )
  foreach ($c in $candidates) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  return $null
}

function Test-UsvTcpEndpoint {
  param([string]$Value, [int]$TimeoutMs = 400)
  if (-not $Value) { return $false }
  $s = $Value.Trim()
  if (-not $s) { return $false }

  $hostName = $null
  $port = 80
  if ($s -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
    try { $u = [Uri]$s } catch { return $false }
    $hostName = $u.Host
    if ($u.Port -gt 0) { $port = $u.Port }
  } else {
    $parts = $s -split ':'
    $hostName = $parts[0]
    if ($parts.Count -gt 1 -and $parts[1]) {
      try { $port = [int]$parts[1] } catch { $port = 0 }
    }
  }
  if (-not $hostName -or $port -le 0) { return $false }

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $iar = $client.BeginConnect($hostName, $port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

# Clears HTTP(S)/ALL_PROXY for this process only when the proxy is a local endpoint
# that is no longer listening (the usual stale-proxy failure on this workstation).
# Remote proxies are left untouched so a slow link is never mistaken for a dead one.
function Clear-UsvDeadProxyEnv {
  $dead = @()
  foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY')) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if (-not $value) { continue }
    $probe = $value.Trim()
    if ($probe -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
      try { $probeHost = ([Uri]$probe).Host } catch { $probeHost = '' }
    } else {
      $probeHost = ($probe -split ':')[0]
    }
    $isLocal = ($probeHost -in @('127.0.0.1', 'localhost', '::1', '0.0.0.0'))
    if (-not $isLocal) { continue }
    if (-not (Test-UsvTcpEndpoint -Value $value)) {
      [Environment]::SetEnvironmentVariable($name, $null)
      $dead += $name
    }
  }
  return $dead
}

# Never block the launcher on a credential dialog.
function Initialize-UsvGitEnv {
  if (-not $env:GIT_TERMINAL_PROMPT) { $env:GIT_TERMINAL_PROMPT = '0' }
  if (-not $env:GCM_INTERACTIVE) { $env:GCM_INTERACTIVE = 'Never' }
}

function Invoke-UsvGit {
  param(
    [string]$GitExe,
    [string]$WorkDir,
    [string[]]$Arguments,
    [switch]$BypassProxy
  )
  $prefix = @()
  if ($BypassProxy) { $prefix = @('-c', 'http.proxy=', '-c', 'https.proxy=') }
  $raw = & $GitExe @prefix -C $WorkDir @Arguments 2>&1
  $code = $LASTEXITCODE
  $text = (@($raw) | ForEach-Object { "$_" }) -join "`n"
  return [pscustomobject]@{ Code = $code; Text = $text.Trim() }
}

function Get-UsvShortSha {
  param([string]$Sha)
  if (-not $Sha) { return '?' }
  if ($Sha.Length -le 7) { return $Sha }
  return $Sha.Substring(0, 7)
}

<#
  Resolves the update source and the remote `release` SHA.
  Returns an object with:
    ok, error, gitRoot, branch, detached, branchIsRelease,
    remoteUrl, trackingName, localSha, remoteSha, localShort, remoteShort,
    upToDate, proxyCleared, detail
#>
function Get-UpdateStatus {
  param(
    [string]$Root = '.',
    [string]$Remote = 'origin',
    [string]$GitExe = ''
  )

  $result = [pscustomobject]@{
    ok             = $false
    error          = $null
    gitRoot        = $null
    branch         = $null
    detached       = $false
    branchIsRelease= $false
    remoteUrl      = $null
    trackingName   = 'origin'
    localSha       = $null
    remoteSha      = $null
    localShort     = '?'
    remoteShort    = '?'
    upToDate       = $false
    proxyCleared   = @()
    detail         = $null
  }

  if (-not $Remote) { $Remote = 'origin' }
  if (-not $GitExe) { $GitExe = Get-UsvGitExe }
  Initialize-UsvGitEnv
  if (-not $GitExe) {
    $result.error = '未找到 git（装一个：winget install -e --id Git.Git）'
    return $result
  }

  $top = Invoke-UsvGit -GitExe $GitExe -WorkDir $Root -Arguments @('rev-parse', '--show-toplevel')
  if ($top.Code -ne 0 -or -not $top.Text) {
    $result.error = '不在 git 工作树内'
    $result.detail = $top.Text
    return $result
  }
  $result.gitRoot = ($top.Text -replace '/', '\')

  $branchRes = Invoke-UsvGit -GitExe $GitExe -WorkDir $result.gitRoot -Arguments @('rev-parse', '--abbrev-ref', 'HEAD')
  if ($branchRes.Code -eq 0) { $result.branch = $branchRes.Text }

  $headRes = Invoke-UsvGit -GitExe $GitExe -WorkDir $result.gitRoot -Arguments @('rev-parse', 'HEAD')
  if ($headRes.Code -eq 0) {
    $result.localSha = $headRes.Text
    $result.localShort = Get-UsvShortSha $result.localSha
  }
  $result.detached = ($result.branch -eq 'HEAD')
  $result.branchIsRelease = ($result.branch -eq 'release')

  $urlRes = Invoke-UsvGit -GitExe $GitExe -WorkDir $result.gitRoot -Arguments @('remote', 'get-url', $Remote)
  if ($urlRes.Code -eq 0 -and $urlRes.Text) {
    $urlLines = @($urlRes.Text -split "`n" | Where-Object { $_.Trim() })
    $result.remoteUrl = if ($urlLines.Count -gt 0) { $urlLines[0].Trim() } else { $urlRes.Text }
    $result.trackingName = $Remote
  } elseif ($Remote -match '://' -or $Remote -match '^[^\\/]+@[^:]+:') {
    $result.remoteUrl = $Remote
    $result.trackingName = 'usv-update'
  } else {
    $result.error = "git remote '$Remote' 不存在（用 git remote -v 查看）"
    return $result
  }

  $result.proxyCleared = @(Clear-UsvDeadProxyEnv)

  $ls = Invoke-UsvGit -GitExe $GitExe -WorkDir $result.gitRoot -Arguments @('ls-remote', '--heads', $Remote, 'refs/heads/release')
  if ($ls.Code -ne 0) {
    $ls = Invoke-UsvGit -GitExe $GitExe -WorkDir $result.gitRoot -Arguments @('ls-remote', '--heads', $Remote, 'refs/heads/release') -BypassProxy
    if ($ls.Code -eq 0) { $result.detail = '已绕过 http.proxy 重试' }
  }
  if ($ls.Code -ne 0) {
    $result.error = '无法连接更新源'
    $result.detail = $ls.Text
    return $result
  }

  $remoteSha = $null
  foreach ($line in ($ls.Text -split "`n")) {
    $cols = ($line.Trim() -split '\s+')
    if ($cols.Count -ge 2 -and $cols[1] -eq 'refs/heads/release') {
      $remoteSha = $cols[0]
      break
    }
  }
  if (-not $remoteSha) {
    $result.error = "更新源 $($result.remoteUrl) 上没有 release 分支"
    return $result
  }

  $result.remoteSha = $remoteSha
  $result.remoteShort = Get-UsvShortSha $remoteSha
  $result.upToDate = ($result.localSha -eq $remoteSha)
  $result.ok = $true
  return $result
}

<#
  Applies the update when the tree is the `release` snapshot (or detached).
  Returns: { action, detail, newSha, newShort } with action one of
    updated | detached-updated | up-to-date | not-release | error |
    fetch-failed | reset-failed
#>
function Invoke-Update {
  param(
    [string]$Root = '.',
    [string]$Remote = 'origin',
    [string]$GitExe = '',
    $Status = $null
  )

  $res = [pscustomobject]@{ action = 'error'; detail = ''; newSha = $null; newShort = '?' }
  if (-not $Status) { $Status = Get-UpdateStatus -Root $Root -Remote $Remote -GitExe $GitExe }
  if (-not $Status.ok) {
    $res.detail = "$($Status.error) $($Status.detail)".Trim()
    return $res
  }
  if ($Status.upToDate) { $res.action = 'up-to-date'; return $res }
  if (-not $Status.branchIsRelease -and -not $Status.detached) {
    $res.action = 'not-release'
    $res.detail = $Status.branch
    return $res
  }
  if (-not $GitExe) { $GitExe = Get-UsvGitExe }
  if (-not $GitExe) { $res.detail = '未找到 git'; return $res }
  Initialize-UsvGitEnv

  $refspec = "+refs/heads/release:refs/remotes/$($Status.trackingName)/release"
  $fetch = Invoke-UsvGit -GitExe $GitExe -WorkDir $Status.gitRoot -Arguments @('fetch', '--quiet', $Remote, $refspec)
  if ($fetch.Code -ne 0) {
    $fetch = Invoke-UsvGit -GitExe $GitExe -WorkDir $Status.gitRoot -Arguments @('fetch', '--quiet', $Remote, $refspec) -BypassProxy
  }
  if ($fetch.Code -ne 0) {
    $res.action = 'fetch-failed'
    $res.detail = $fetch.Text
    return $res
  }

  $target = "refs/remotes/$($Status.trackingName)/release"
  $applyArgs = if ($Status.branchIsRelease) {
    @('reset', '--hard', $target)
  } else {
    @('checkout', '-B', 'release', $target)
  }
  $apply = Invoke-UsvGit -GitExe $GitExe -WorkDir $Status.gitRoot -Arguments $applyArgs
  if ($apply.Code -ne 0) {
    $res.action = 'reset-failed'
    $res.detail = $apply.Text
    return $res
  }

  $head = Invoke-UsvGit -GitExe $GitExe -WorkDir $Status.gitRoot -Arguments @('rev-parse', 'HEAD')
  if ($head.Code -eq 0) {
    $res.newSha = $head.Text
    $res.newShort = Get-UsvShortSha $head.Text
  }
  $res.action = if ($Status.detached) { 'detached-updated' } else { 'updated' }
  return $res
}

# ---------------------------------------------------------------- direct CLI
if ($MyInvocation.InvocationName -ne '.') {
  $argRoot = (Get-Location).Path
  $argRemote = 'origin'
  $argApply = $false
  for ($i = 0; $i -lt $args.Count; $i++) {
    switch ($args[$i]) {
      '-Root'   { $i++; $argRoot = $args[$i] }
      '-Remote' { $i++; $argRemote = $args[$i] }
      '-Apply'  { $argApply = $true }
    }
  }

  $st = Get-UpdateStatus -Root $argRoot -Remote $argRemote
  if ($st.proxyCleared.Count -gt 0) {
    Write-Host "proxy: 已忽略不可达的 $($st.proxyCleared -join ', ')" -ForegroundColor Yellow
  }
  if (-not $st.ok) {
    Write-Host "update: 不可用 — $($st.error) $($st.detail)" -ForegroundColor Red
    exit 1
  }
  Write-Host "branch:  $($st.branch)"
  Write-Host "remote:  $($st.remoteUrl)"
  Write-Host "local:   $($st.localShort)"
  Write-Host "remote:  $($st.remoteShort)"
  if ($st.upToDate) {
    Write-Host 'update:  已是最新' -ForegroundColor Green
    exit 0
  }
  if (-not $st.branchIsRelease -and -not $st.detached) {
    Write-Host "update:  远端有新提交，但当前分支是 $($st.branch)，不是部署快照（未修改）" -ForegroundColor Yellow
    exit 0
  }
  if (-not $argApply) {
    Write-Host 'update:  有可用更新（加 -Apply 才会执行）' -ForegroundColor Yellow
    exit 0
  }
  $r = Invoke-Update -Root $argRoot -Remote $argRemote -Status $st
  if ($r.action -eq 'updated' -or $r.action -eq 'detached-updated') {
    Write-Host "update:  已更新 $($st.localShort) → $($r.newShort)" -ForegroundColor Green
    exit 0
  }
  Write-Host "update:  失败（$($r.action)） $($r.detail)" -ForegroundColor Red
  exit 1
}
