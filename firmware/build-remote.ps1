# 固件远程构建：Windows 上改代码 → Pi 上编译打包 → 取回 tar.gz
#
# 为什么不在 Windows 本地编译：
#   本机只有 VS 18 Insiders 的编译器，没有 Windows 10/11 SDK 库（kernel32.lib 等），
#   MSVC 链接不了；也没有 MinGW（缺 dlltool/liblto_plugin）。
#   所以固件始终在 Pi 上原生编译 —— 这也是 OTA 一直用的方式，不影响一键升级。
#
# 用法（在仓库根目录或 firmware 目录下均可）：
#   .\firmware\build-remote.ps1
#   .\firmware\build-remote.ps1 -Host USVneo
#
# 产物：desktop\dist\firmware\usv-edge-<ver>-<arch>.tar.gz
#       客户端「选择固件包并升级」直接选这个文件。

[CmdletBinding()]
param(
  [string]$SshHost = 'USVneo',
  [string]$RemoteDir = '/root/firmware',
  [switch]$SkipSync
)

# 外部命令（ssh/scp）把警告写到 stderr，用 Stop 会被误判成异常；
# 这里统一用 Continue，并逐个检查 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'

$fwDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $fwDir
$outDir = Join-Path $repoRoot 'desktop\dist\firmware'

function Say($msg) { Write-Host "[build] $msg" }
function Fail($msg) { Write-Host "[build] ✗ $msg" -ForegroundColor Red; exit 1 }

# 1. 连通性
Say "检查 $SshHost 可达性…"
$probe = & ssh -o BatchMode=yes -o ConnectTimeout=6 $SshHost 'echo ok' 2>&1
if ($LASTEXITCODE -ne 0 -or ($probe -notmatch 'ok')) {
  Fail "连不上 $SshHost。先确认 Pi 上电、网络同网段、免密登录可用：`n         ssh $SshHost`n         $probe"
}
Say "已连接"

# 2. 同步源码（只传需要的东西，避免把 target/ 送上去）
if (-not $SkipSync) {
  Say '同步源码到 Pi…'
  $files = @('Cargo.toml', 'Cargo.lock')
  foreach ($f in $files) {
    if (Test-Path (Join-Path $fwDir $f)) {
      & scp -q (Join-Path $fwDir $f) "${SshHost}:${RemoteDir}/" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "上传 $f 失败" }
    }
  }
  & ssh -o BatchMode=yes $SshHost "mkdir -p ${RemoteDir}/src ${RemoteDir}/scripts" 2>&1 | Out-Null
  # 逐文件传，避免 -r 把 .git / target 带上去
  foreach ($sub in @('src', 'scripts', 'config')) {
    $dir = Join-Path $fwDir $sub
    if (-not (Test-Path $dir)) { continue }
    & ssh $SshHost "mkdir -p ${RemoteDir}/${sub}" 2>&1 | Out-Null
    Get-ChildItem -LiteralPath $dir -File -Recurse | ForEach-Object {
      $rel = $_.FullName.Substring($dir.Length + 1) -replace '\\', '/'
      $destDir = "${RemoteDir}/${sub}"
      if ($rel -match '/') {
        $sub2 = $rel.Substring(0, $rel.LastIndexOf('/'))
        & ssh $SshHost "mkdir -p ${destDir}/${sub2}" 2>&1 | Out-Null
      }
      & scp -q $_.FullName "${SshHost}:${destDir}/${rel}" 2>&1 | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "上传 $sub/$rel 失败" }
    }
  }
  # .sh 必须是 LF，否则 Pi 上会报 "set: Illegal option -"。
  # 在本地规范化后再上传，比在远端 sed 更可靠。
  $shDir = Join-Path $fwDir 'scripts'
  if (Test-Path $shDir) {
    Get-ChildItem -LiteralPath $shDir -File -Filter *.sh | ForEach-Object {
      $txt = [IO.File]::ReadAllText($_.FullName) -replace "`r`n", "`n"
      [IO.File]::WriteAllText($_.FullName, $txt, (New-Object Text.UTF8Encoding $false))
    }
  }
  $chmodCmd = 'chmod +x ' + $RemoteDir + '/scripts/*.sh'
  & ssh $SshHost $chmodCmd 2>&1 | Out-Null
  Say '源码已同步'
}

# 3. 远程编译 + 打包
Say 'Pi 上编译并打包（首次约 1~2 分钟）…'
$pkgLine = & ssh -o BatchMode=yes $SshHost "cd ${RemoteDir} && sh scripts/make-package.sh 2>&1 | tail -6" 2>&1
$pkgLine | ForEach-Object { Write-Host "    $_" }
if ($LASTEXITCODE -ne 0) { Fail '远程编译失败，见上面的输出' }

$pkgPath = ($pkgLine | Select-String -Pattern 'path = (\S+)' | Select-Object -First 1)
if (-not $pkgPath) { Fail '没解析到包路径' }
$remotePkg = $pkgPath.Matches[0].Groups[1].Value
Say "产物：$remotePkg"

# 4. 取回本地
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$leaf = Split-Path -Leaf $remotePkg
$localPkg = Join-Path $outDir $leaf
Say "取回 $leaf …"
& scp -q "${SshHost}:${remotePkg}" $localPkg 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Fail '下载失败' }

$size = [math]::Round((Get-Item $localPkg).Length / 1KB)
Say ''
Write-Host "[build] ✓ 完成" -ForegroundColor Green
Write-Host "        包：$localPkg  ($size KB)"
Write-Host '        下一步：客户端点「选择固件包并升级」，选这个文件'
