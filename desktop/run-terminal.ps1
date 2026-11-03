<#
  run-terminal.ps1 — 启动器：自检依赖 → 按需安装 → 自动更新 → 构建（仅开发树）→ 启动

  同一份脚本适用于两种布局（脚本所在目录必须含 package.json / dist / tools / algo）：
    开发树     desktop\run-terminal.ps1             有 src\，源码比产物新时自动构建
    部署快照   release 分支根目录\run-terminal.ps1   无 src\，直接跑已构建的产物

  参数
    -Check      只体检，不安装不修改（退出码 0=可用 / 1=有硬性失败）
    -Fix        安装/修复依赖后退出，不启动
    -Sim        先拉起假船端再启动
    -Reinstall  强制重装 node_modules
    -NoUpdate   跳过自动更新
    -Remote     更新源（remote 名或 URL），默认 origin，也可用 USV_UPDATE_REMOTE
    -UpdateOnly 只做自检 + 自动更新，不装依赖、不构建、不启动
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Fix,
  [switch]$Sim,
  [switch]$Reinstall,
  [switch]$NoUpdate,
  [string]$Remote,
  [switch]$UpdateOnly,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs
)

$ErrorActionPreference = 'Continue'
$appRoot = $PSScriptRoot
Set-Location $appRoot

$updateModuleLoaded = $false
$updateModule = Join-Path $appRoot 'tools\launcher-update.ps1'
if (Test-Path $updateModule) {
  . $updateModule
  $updateModuleLoaded = $true
}

$TOTAL = 5
$script:nOk = 0
$script:nWarn = 0
$script:nFail = 0

function Step([int]$i, [string]$msg) { Write-Host "[$i/$TOTAL] $msg" -ForegroundColor Cyan }
function Ok([string]$m)   { Write-Host "       OK    $m" -ForegroundColor Green;  $script:nOk++ }
function Warn([string]$m) { Write-Host "       WARN  $m" -ForegroundColor Yellow; $script:nWarn++ }
function Fail([string]$m) { Write-Host "       FAIL  $m" -ForegroundColor Red;    $script:nFail++ }
function Note([string]$m) { Write-Host "             $m" -ForegroundColor DarkGray }

# 装完 Node / Git 后当前会话的 PATH 不会刷新，必须按已知安装位置显式找一遍
function Resolve-Tool([string]$exe, [string[]]$candidates) {
  $cmd = Get-Command $exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
  return $null
}
function Add-ToPath([string]$dir) {
  if ($dir -and (Test-Path $dir) -and ($env:PATH -notlike "*$dir*")) { $env:PATH = "$dir;$env:PATH" }
}
function Get-JsonField([string]$file, [string]$field) {
  if (-not (Test-Path $file)) { return $null }
  try { return (Get-Content $file -Raw -Encoding UTF8 | ConvertFrom-Json).$field } catch { return $null }
}
function Get-AppVersion {
  $bi = $null
  if (-not $script:buildInfoStale) {
    $bi = Get-JsonField (Join-Path $appRoot 'build-info.json') 'version'
  }
  $pkg = Get-JsonField (Join-Path $appRoot 'package.json') 'version'
  if ($bi -and $pkg -and ([string]$bi -ne [string]$pkg)) {
    $key = "$bi/$pkg"
    if ($script:versionMismatch -ne $key) {
      $script:versionMismatch = $key
      Warn "build-info.json 版本 $bi 与 package.json $pkg 不一致；按产物版本显示"
    }
  }
  $v = if ($bi) { $bi } else { $pkg }
  if (-not $v) { $v = '?' }
  return [string]$v
}
function Get-AppCommit {
  if ($script:buildInfoStale) { return 'stale' }
  $c = Get-JsonField (Join-Path $appRoot 'build-info.json') 'sourceCommit'
  if (-not $c) { return $null }
  $s = [string]$c
  if ($s.Length -gt 7) { return $s.Substring(0, 7) }
  return $s
}
function Get-AppDirty {
  return ((Get-JsonField (Join-Path $appRoot 'build-info.json') 'sourceDirty') -eq $true)
}
# build-info.json 是被 gitignore 的构建产物：切分支后它可能仍指向上一棵树。
# 开发树里在显示任何版本号之前刷新它；部署快照里只读，不写自己的产物文件。
function Sync-BuildInfo {
  param([string]$GitExe, [string]$GitRoot, [switch]$CheckOnly)

  $script:buildInfoStale = $false
  if (-not (Test-Path (Join-Path $appRoot 'src'))) { return }

  $infoCommit = Get-JsonField (Join-Path $appRoot 'build-info.json') 'sourceCommit'
  $head = $null
  if ($GitExe -and $GitRoot) {
    $head = ((& $GitExe -C $GitRoot rev-parse HEAD 2>$null) -join '').Trim()
  }
  $stale = ($infoCommit -and $head -and ([string]$infoCommit -ne $head))

  if ($CheckOnly) {
    if ($stale) {
      $script:buildInfoStale = $true
      $short = [string]$infoCommit
      if ($short.Length -gt 7) { $short = $short.Substring(0, 7) }
      Note "build-info.json 指向 $short，与当前 HEAD 不一致（-Check 只读，不刷新）"
    }
    return
  }

  $builder = Join-Path $appRoot 'tools\build-info.mjs'
  if (-not $nodeExe -or -not (Test-Path $builder)) { return }
  & $nodeExe $builder 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { Warn 'build-info.json 刷新失败，版本显示可能不准' }
}
function Show-Banner {
  $ver = Get-AppVersion
  $sha = Get-AppCommit
  $tag = if (-not $sha) { $ver }
         elseif ($sha -eq 'stale') { "$ver (stale)" }
         elseif (Get-AppDirty) { "$ver ($sha, dirty)" }
         else { "$ver ($sha)" }
  Write-Host ''
  Write-Host "  USV Terminal $tag" -ForegroundColor White
  Write-Host ''
}

# ============ 1. Node.js ============
Step 1 'Node.js'
$nodeExe = Resolve-Tool 'node' @("$env:ProgramFiles\nodejs\node.exe")
if (-not $nodeExe) {
  if ($Check) {
    Fail '未找到 node'
  } else {
    Warn '未找到 Node.js，尝试用 winget 安装 LTS（会弹一次 UAC）...'
    $winget = Resolve-Tool 'winget' @()
    if ($winget) {
      & $winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
      Add-ToPath "$env:ProgramFiles\nodejs"
      $nodeExe = Resolve-Tool 'node' @("$env:ProgramFiles\nodejs\node.exe")
    } else {
      Note '本机没有 winget'
    }
    if (-not $nodeExe) {
      Fail 'Node.js 仍未就绪'
      Note '手动安装：winget install -e --id OpenJS.NodeJS.LTS'
      Note '或下载：  https://nodejs.org/en/download'
      Read-Host '按回车退出' | Out-Null
      exit 2
    }
  }
}
if ($nodeExe) {
  $nodeVer = (& $nodeExe -v) -replace '^v', ''
  $nodeMajor = [int](($nodeVer -split '\.')[0])
  if ($nodeMajor -lt 18) { Fail "node $nodeVer 过旧（需 >= 18）" } else { Ok "node $nodeVer" }
}
$npmExe = Resolve-Tool 'npm.cmd' @("$env:ProgramFiles\nodejs\npm.cmd")
if ($npmExe) { Ok "npm $(& $npmExe -v)" } else { Fail '未找到 npm（应随 Node.js 一起安装）' }

# ============ 2. Git 与自动更新 ============
Step 2 'Git 与自动更新'
$gitExe = Resolve-Tool 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
if (-not $gitExe) {
  if ($Check) {
    Warn '未找到 git（部署机上自动更新不可用，不影响运行）'
  } else {
    Warn '未找到 git，尝试用 winget 安装（会弹一次 UAC）...'
    $winget = Resolve-Tool 'winget' @()
    if ($winget) {
      & $winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
      Add-ToPath "$env:ProgramFiles\Git\cmd"
      $gitExe = Resolve-Tool 'git' @("$env:ProgramFiles\Git\cmd\git.exe")
    }
  }
}

$didUpdate = $false
# 开发树里 .git 在仓库根、脚本在 desktop\，所以用 rev-parse 定位，不能直接看 $appRoot\.git
$gitRoot = $null
if ($gitExe) {
  $gitRoot = ((& $gitExe -C $appRoot rev-parse --show-toplevel 2>$null) -join '').Trim()
  if ($gitRoot) { $gitRoot = $gitRoot -replace '/', '\' }
}

# 切分支后 build-info.json 可能仍指向上一棵树；先校正版本来源，再显示任何版本号
Sync-BuildInfo -GitExe $gitExe -GitRoot $gitRoot -CheckOnly:$Check

if (-not $gitExe) {
  Note '跳过自动更新（未安装 git）'
} elseif (-not $gitRoot) {
  Note '不在 git 工作树内，跳过自动更新'
} elseif ($NoUpdate) {
  Note '已指定 -NoUpdate，跳过自动更新'
} elseif (-not $updateModuleLoaded) {
  Note '缺少 tools\launcher-update.ps1，跳过自动更新'
} else {
  $remoteName = if ($Remote) { $Remote } elseif ($env:USV_UPDATE_REMOTE) { $env:USV_UPDATE_REMOTE } else { 'origin' }
  $oldVer = Get-AppVersion
  $status = Get-UpdateStatus -Root $appRoot -Remote $remoteName -GitExe $gitExe
  if ($status.proxyCleared.Count -gt 0) {
    Note "已忽略不可达的代理：$($status.proxyCleared -join ', ')"
  }
  if ($status.error) {
    # 只有确认拿到远端 SHA 才允许说“已是最新”；这里一律按失败报告
    Warn "无法连接更新源 $remoteName：$($status.error)"
    $detail = ([string]$status.detail).Trim()
    if ($detail) { Note $detail }
    Note '检查网络 / 代理（HTTP_PROXY）与 git 凭证；git remote -v 应指向预期仓库'
  } elseif ($status.upToDate) {
    Ok "已是最新 $oldVer ($($status.localShort)) · 更新源 $($status.remoteUrl)"
  } elseif (-not $status.branchIsRelease -and -not $status.detached) {
    Note "更新源 $($status.remoteUrl) · release 最新 $($status.remoteShort) · 本地 $($status.branch)@$($status.localShort)"
    Note "当前分支 $($status.branch) 不是部署快照，已跳过自动更新（开发树请用 git pull）"
  } else {
    $result = Invoke-Update -Root $appRoot -Remote $remoteName -GitExe $gitExe -Status $status
    if ($result.action -eq 'updated' -or $result.action -eq 'detached-updated') {
      $didUpdate = $true
      Sync-BuildInfo -GitExe $gitExe -GitRoot $gitRoot
      Ok "已更新 $oldVer → $(Get-AppVersion)（$($status.localShort) → $($result.newShort)）"
    } else {
      Warn "自动更新失败（$($result.action)）：$($result.detail)"
      Note '继续使用当前版本；修好更新源后可重试'
    }
  }
}

if ($UpdateOnly) {
  Write-Host ''
  if ($didUpdate) { Write-Host '  仅更新：已应用最新 release' -ForegroundColor DarkGray }
  else { Write-Host '  仅更新：没有应用更新' -ForegroundColor DarkGray }
  if ($script:nFail -gt 0) { exit 1 } else { exit 0 }
}

# ============ 3. 依赖 ============
Step 3 '依赖 (node_modules)'
$lockFile   = Join-Path $appRoot 'package-lock.json'
$stampFile  = Join-Path $appRoot '.deps-ok'
$electronExe = Join-Path $appRoot 'node_modules\electron\dist\electron.exe'

$lockHash = ''
if (Test-Path $lockFile) { $lockHash = (Get-FileHash $lockFile -Algorithm SHA256).Hash }
$stamp = ''
if (Test-Path $stampFile) { $stamp = ((Get-Content $stampFile -Raw -ErrorAction SilentlyContinue) -join '').Trim() }

$needInstall = $Reinstall -or (-not (Test-Path (Join-Path $appRoot 'node_modules'))) -or ($lockHash -and $lockHash -ne $stamp)

if ($Check) {
  # 纯诊断：不落任何改动
  if ($needInstall) { Warn '依赖未安装或已过期（启动时会自动 npm ci）' }
  if (Test-Path $electronExe) {
    $mb = [math]::Round((Get-Item $electronExe).Length / 1MB)
    Ok "electron.exe ${mb} MB"
  } else {
    Warn 'electron 运行时未解压（启动时会自动补装）'
  }
} else {
  if ($needInstall -and $npmExe) {
    Write-Host '       npm ci ...' -ForegroundColor DarkGray
    & $npmExe ci
    if ($LASTEXITCODE -ne 0) { Warn 'npm ci 失败，尝试 npm install'; & $npmExe install }
  }

  # npm 11 会拦 postinstall：包已装好但 electron.exe 不存在
  if (-not (Test-Path $electronExe)) {
    $installJs = Join-Path $appRoot 'node_modules\electron\install.js'
    if (Test-Path $installJs) {
      Warn 'electron 运行时缺失（npm 拦截了 postinstall），正在解压 ...'
      & $nodeExe $installJs
      if (-not (Test-Path $electronExe)) {
        Warn '直连失败，改用镜像重试 ...'
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
        & $nodeExe $installJs
      }
    }
  }
  if (Test-Path $electronExe) {
    $mb = [math]::Round((Get-Item $electronExe).Length / 1MB)
    Ok "electron.exe ${mb} MB"
    if ($lockHash) { [System.IO.File]::WriteAllText($stampFile, $lockHash) }
  } else {
    Fail 'electron 运行时不可用'
    Note '手动执行：node node_modules\electron\install.js'
  }
}

# ============ 4. 构建（仅开发树） ============
Step 4 '构建'
$srcDir  = Join-Path $appRoot 'src'
$mainJs  = Join-Path $appRoot 'dist\main\index.js'
if (-not (Test-Path $srcDir)) {
  if (Test-Path $mainJs) { Ok '部署快照：使用已构建产物' } else { Fail '缺少 dist\main\index.js，产物不完整' }
} else {
  $needBuild = $Reinstall -or (-not (Test-Path $mainJs))
  if (-not $needBuild) {
    $newest = Get-ChildItem $srcDir -Recurse -File |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest -and ($newest.LastWriteTime -gt (Get-Item $mainJs).LastWriteTime)) {
      Note '源码比产物新'
      $needBuild = $true
    }
  }
  if ($needBuild -and $Check) {
    Warn 'dist 落后于源码（-Check 只读，不构建）'
  } elseif ($needBuild -and $npmExe) {
    & $npmExe run build
    if ($LASTEXITCODE -ne 0) { Fail '构建失败' } else { Ok 'dist 已重新生成' }
  } elseif ($needBuild) {
    Fail '缺少 npm，无法构建'
  } elseif (Test-Path $mainJs) {
    Ok 'dist 是最新的'
  }
}

# 构建被跳过时 dist 仍是旧的，但 build-info.json 也必须对应当前 HEAD
if (-not $Check) {
  Sync-BuildInfo -GitExe $gitExe -GitRoot $gitRoot
}

# ============ 5. 启动 ============
Write-Host ''
if ($Check -or $Fix) {
  Note "版本 $(Get-AppVersion) ($(Get-AppCommit))"
  $verdict = if ($script:nFail -gt 0) { '不可用' } else { '可用' }
  $mode = if ($Check) { '体检' } else { '修复' }
  Write-Host "  ${mode}：$verdict（$script:nOk 通过 / $script:nWarn 警告 / $script:nFail 失败）"
  if ($script:nFail -gt 0) { exit 1 } else { exit 0 }
}
if ($script:nFail -gt 0) {
  Write-Host '  存在硬性失败，无法启动。按回车退出。' -ForegroundColor Red
  Read-Host | Out-Null
  exit 1
}

Show-Banner
if ($didUpdate) { Write-Host '  （本次启动前已自动更新）' -ForegroundColor DarkGray }

if ($Sim) {
  Step 5 '启动（模拟器）'
  Write-Host '       拉起假船端：12m 池 + 4 障碍' -ForegroundColor DarkGray
  Start-Process -FilePath $nodeExe -ArgumentList (Join-Path $appRoot 'tools\sim-boat.cjs') | Out-Null
  Start-Sleep -Seconds 2
} else {
  Step 5 '启动'
}
Write-Host '       船端发现 UDP 9528（自动）· 控制 TCP 9527 · 固件 OTA 9530' -ForegroundColor DarkGray
Write-Host ''

& $electronExe . @AppArgs
$code = $LASTEXITCODE
if ($code -ne 0) {
  Write-Host ''
  Write-Host "  终端退出码 $code" -ForegroundColor Yellow
  Read-Host '按回车退出' | Out-Null
}
exit $code
