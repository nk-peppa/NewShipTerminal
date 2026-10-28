# 固件本地交叉编译：Windows → aarch64（zig + MinGW 宿主链接器）
#
# 为什么能在 Windows 上编：
#   固件依赖 100% 纯 Rust（flate2 用 rust_backend，不碰 zlib；没有 libudev 之类的 C 库），
#   所以只需要两样东西：
#     · 宿主 C 链接器 —— 编 serde_derive 这类 proc-macro（MinGW）
#     · aarch64 链接器 —— zig 自带，连 glibc sysroot 一起打包
#
# 用法：
#   .\firmware\build-local.ps1
#   .\firmware\build-local.ps1 -TargetDir D:\usv-target
#
# 产物：desktop\dist\firmware\usv-edge-<ver>-aarch64.tar.gz
#       客户端「选择固件包并升级」直接选这个文件。
#
# 注意：源码路径含空格和单引号（OneDrive 目录名），MinGW 的 ld 会把
#       "-Wl,<带空格的 .def 路径>" 拆错，所以 target 目录必须落在无空格路径下。

[CmdletBinding()]
param(
  [string]$TargetDir = 'C:\usv-target',
  [string]$MingwBin = ''
)

$ErrorActionPreference = 'Continue'

$fwDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $fwDir
$outDir = Join-Path $repoRoot 'desktop\dist\firmware'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'

function Say($m) { Write-Host "[build] $m" }
function Fail($m) { Write-Host "[build] x $m" -ForegroundColor Red; exit 1 }

if (-not $MingwBin) {
  $gcc = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Recurse -Filter 'x86_64-w64-mingw32-gcc.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($gcc) { $MingwBin = $gcc.Directory.FullName }
}
if (-not $MingwBin -or -not (Test-Path $MingwBin)) {
  Fail '找不到 MinGW。装一个：winget install -e --id BrechtSanders.WinLibs.POSIX.MSVCRT'
}
if (-not (Test-Path (Join-Path $cargoBin 'cargo-zigbuild.exe'))) {
  Fail "缺少 cargo-zigbuild，放到 $cargoBin 下（GitHub: rust-cross/cargo-zigbuild releases）"
}
if (-not (Test-Path (Join-Path $cargoBin 'zig.cmd'))) {
  Fail "缺少 zig.cmd。先 python -m pip install ziglang，再在 $cargoBin 放一个调用 zig.exe 的 zig.cmd"
}

$env:PATH = "$MingwBin;$cargoBin;$env:PATH"
$env:CARGO_TARGET_DIR = $TargetDir

Say "交叉编译 aarch64（target dir: $TargetDir）..."
Push-Location $fwDir
& (Join-Path $cargoBin 'cargo.exe') zigbuild --release --target aarch64-unknown-linux-gnu
$code = $LASTEXITCODE
Pop-Location
if ($code -ne 0) { Fail '编译失败，见上面的输出' }

$bin = Join-Path $TargetDir 'aarch64-unknown-linux-gnu\release\usv-edge'
if (-not (Test-Path $bin)) { Fail "找不到产物 $bin" }

# 打包布局与 scripts/make-package.sh 保持一致
$ver = (Select-String -Path (Join-Path $fwDir 'Cargo.toml') -Pattern '^version *= *"(.+)"' | Select-Object -First 1).Matches[0].Groups[1].Value
$stage = Join-Path $fwDir 'dist\stage'
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
Copy-Item $bin (Join-Path $stage 'usv-edge')

$binSha = (Get-FileHash (Join-Path $stage 'usv-edge') -Algorithm SHA256).Hash.ToLower()
$builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$manifest = [ordered]@{
  version       = $ver
  arch          = 'aarch64'
  binary_sha256 = $binSha
  built_at      = $builtAt
  min_client    = 1
} | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $stage 'manifest.json'), $manifest, (New-Object Text.UTF8Encoding $false))

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
$pkg = Join-Path $outDir "usv-edge-$ver-aarch64.tar.gz"
if (Test-Path $pkg) { Remove-Item $pkg -Force }
# 用 Node 打包而不是 tar：Windows 的 bsdtar 不支持 --mode，会把 usv-edge 打成 0666，
# 固件解包后没有执行位 → systemd 203/EXEC → 白升级一次（2026-10-28 真机踩过）。
& node (Join-Path $fwDir 'tools\pack-tgz.mjs') $stage $pkg
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $pkg)) { Fail '打包失败' }

Say ''
Write-Host '[build] OK' -ForegroundColor Green
Write-Host ("        包：$pkg  ({0} KB)" -f [math]::Round((Get-Item $pkg).Length / 1KB))
Write-Host '        下一步：客户端点「选择固件包并升级」，选这个文件'