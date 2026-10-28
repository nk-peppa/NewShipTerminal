#!/bin/sh
# 打包固件：编译 → 生成 manifest → 产出 usv-edge-<ver>-<arch>.tar.gz
# 用法（Pi 上，firmware 目录内）：sh scripts/make-package.sh
set -e

cd "$(dirname "$0")/.."
cargo build --release 2>&1 | tail -3

VER=$(sed -n 's/^version *= *"\(.*\)"/\1/p' Cargo.toml | head -1)
ARCH=$(uname -m)
OUT=dist
STAGE="$OUT/stage"

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp target/release/usv-edge "$STAGE/usv-edge"
chmod 755 "$STAGE/usv-edge"

BIN_SHA=$(sha256sum "$STAGE/usv-edge" | awk '{print $1}')
BUILT_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat > "$STAGE/manifest.json" <<EOF
{
  "version": "$VER",
  "arch": "$ARCH",
  "binary_sha256": "$BIN_SHA",
  "built_at": "$BUILT_AT",
  "min_client": 1
}
EOF

PKG="$OUT/usv-edge-$VER-$ARCH.tar.gz"
tar -czf "$PKG" -C "$STAGE" .

echo "---- package ----"
ls -lh "$PKG"
echo "sha256(package) = $(sha256sum "$PKG" | awk '{print $1}')"
echo "path = $(pwd)/$PKG"
