#!/bin/sh
# 在开发机上搭一个「最小可用」的 OTA 目录，便于在没有 systemd 服务时演练升级：
#   <dir>/releases/<ver>/usv-edge
#   <dir>/current -> releases/<ver>
# 用法：sh scripts/setup-dev-ota.sh [dir] [binary] [version]
set -e

DIR=${1:-/tmp/usv-ota}
BIN=${2:-target/release/usv-edge}
VER=${3:-0.2.0}

mkdir -p "$DIR/releases/$VER"
cp "$BIN" "$DIR/releases/$VER/usv-edge"
chmod 755 "$DIR/releases/$VER/usv-edge"
ln -sfn "releases/$VER" "$DIR/current"

echo "dir      = $DIR"
echo "current  -> $(readlink "$DIR/current")"
ls -l "$DIR/releases/$VER/usv-edge"

cat <<EOF

下一步（模拟 systemd Restart=always，注意必须从 current 启动）：
  while true; do
    $DIR/current/usv-edge --dry-run --port 19527 --udp-port 19528 --ota-port 19530 --ota-dir $DIR
    echo "[supervisor] 进程退出，1s 后重启"
    sleep 1
  done
EOF
