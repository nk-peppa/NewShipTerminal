<#
  run-terminal.ps1 — 启动器：自检依赖 → 按需安装 → 自动更新 → 构建（仅开发树）→ 启动

  同一份脚本适用于两种布局（脚本所在目录必须含 package.json / dist / tools / algo）：
    开发树     desktop\run-terminal.ps1             有 src\，源码比产物新时自动构建
    部署快照   release 分支根目录\run-terminal.ps1   无 src\，直接跑已构建的产物

  参数
    -Check      只体检不启动（退出码 0=可用 / 1=有硬性失败）
    -Sim        先拉起假船端再启动
    -Reinstall  强制重装 node_modules
    -NoUpdate   跳过自动更新
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Sim,
  [switch]$Reinstall,
  [switch]$NoUpdate,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$AppArgs
)

$ErrorActionPreference = 'Continue'
$appRoot = $PSScriptRoot
Set-Location $appRoot

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
  $v = Get-JsonField (Join-Path $appRoot 'build-info.json') 'version'
  if (-not $v) { $v = Get-JsonField (Join-Path $appRoot 'package.json') 'version' }
  if (-not $v) { $v = '?' }
  return [string]$v
}
function Get-AppCommit {
  $c = Get-JsonField (Join-Path $appRoot 'build-info.json') 'sourceCommit'
  if (-not $c) { return $null }
  $s = [string]$c
  if ($s.Length -gt 7) { return $s.Substring(0, 7) }
  return $s
}
function Show-Banner {
  $ver = Get-AppVersion
  $sha = Get-AppCommit
  $tag = if ($sha) { "$ver ($sha)" } else { $ver }
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
if (-not $gitExe) {
  Note '跳过自动更新（未安装 git）'
} elseif (-not $gitRoot) {
  Note '不在 git 工作树内，跳过自动更新'
} elseif ($NoUpdate) {
  Note '已指定 -NoUpdate，跳过自动更新'
} else {
  $branch = ((& $gitExe -C $gitRoot rev-parse --abbrev-ref HEAD 2>$null) -join '').Trim()
  if ($branch -ne 'release') {
    Note "当前分支 $branch（非部署分支），跳过自动更新"
  } else {
    $oldVer = Get-AppVersion
    & $gitExe -C $gitRoot fetch --quiet --prune origin release 2>$null
    $localSha  = ((& $gitExe -C $gitRoot rev-parse HEAD 2>$null) -join '').Trim()
    $remoteSha = ((& $gitExe -C $gitRoot rev-parse origin/release 2>$null) -join '').Trim()
    if ($localSha -and $remoteSha -and ($localSha -ne $remoteSha)) {
      & $gitExe -C $gitRoot reset --hard origin/release 2>&1 | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $didUpdate = $true
        Ok "已更新 $oldVer → $(Get-AppVersion)"
      } else {
        Warn '更新失败（工作树可能有冲突），继续使用当前版本'
      }
    } elseif ($remoteSha) {
      Ok "已是最新 $oldVer"
    } else {
      Warn '读取远端 release 失败，继续使用当前版本'
    }
  }
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
  if ($needBuild -and $npmExe) {
    & $npmExe run build
    if ($LASTEXITCODE -ne 0) { Fail '构建失败' } else { Ok 'dist 已重新生成' }
  } elseif (Test-Path $mainJs) {
    Ok 'dist 是最新的'
  }
}

# ============ 5. 启动 ============
Write-Host ''
if ($Check) {
  $verdict = if ($script:nFail -gt 0) { '不可用' } else { '可用' }
  Write-Host "  体检：$verdict（$script:nOk 通过 / $script:nWarn 警告 / $script:nFail 失败）"
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
