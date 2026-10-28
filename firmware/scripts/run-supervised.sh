#!/bin/sh
# 模拟 systemd Restart=always：始终从 <dir>/current 启动，
# 这样 OTA 切换软链后，重启即运行新版本。
# 用法：sh scripts/run-supervised.sh /tmp/usv-ota --dry-run --port 19527 ...
set -e

DIR=${1:-/tmp/usv-ota}
shift || true

if [ ! -e "$DIR/current/usv-edge" ]; then
  echo "缺少 $DIR/current/usv-edge，请先运行 setup-dev-ota.sh" >&2
  exit 2
fi

while true; do
  "$DIR/current/usv-edge" "$@"
  code=$?
  echo "[supervisor] exit=$code，1s 后重启"
  sleep 1
done
