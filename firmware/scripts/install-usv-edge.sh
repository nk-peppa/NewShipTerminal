#!/bin/sh
# 安装/更新 systemd 服务（开机自启 + 崩溃自动重启）
#
# 用法（firmware 目录内）：
#   sh scripts/install-usv-edge.sh                 # 实机档：9527/9528/9530 + 真实 PWM + 真实雷达
#   sh scripts/install-usv-edge.sh --dry-run-profile
#                                                  # 调试档：19527/19528/19530 + HAL mock + 模拟雷达
#                                                  # （可与旧服务并存，切端口给桌上联调用）
#   sh scripts/install-usv-edge.sh --no-start      # 只装不启（配合 reboot 做冷启动验证）
#   sh scripts/install-usv-edge.sh --units-only    # 只装 unit + 回滚看门狗，不动二进制与 current
#   ARGS="--port 9527 ..." sh scripts/install-usv-edge.sh
#                                                  # 显式指定，覆盖档位默认值
set -e

BASE=/opt/usv
CONF="$BASE/config/usv-edge.json"
UNIT=/etc/systemd/system/usv-edge.service
DEFAULTS=/etc/default/usv-edge
START=1
UNITS_ONLY=0
DRY_PROFILE=0

for a in "$@"; do
  [ "$a" = "--no-start" ] && START=0
  [ "$a" = "--units-only" ] && UNITS_ONLY=1
  [ "$a" = "--dry-run-profile" ] && DRY_PROFILE=1
done

cd "$(dirname "$0")/.."

# 回滚保险的四项自检。任何一项 FAIL 都意味着「坏推送会永久失联」。
# 注意：必须放在 if 里调用 grep，否则 set -e 会把 grep 的 1 当致命错误。
verify_watchdog() {
  ok=1
  if grep -q '^OnFailure=.*usv-edge-rollback\.service' "$UNIT" 2>/dev/null; then
    echo '  [PASS] unit 含 OnFailure=usv-edge-rollback.service'
  else
    echo '  [FAIL] unit 缺 OnFailure= —— systemd 不会调回滚脚本'
    ok=0
  fi
  if [ -f /etc/systemd/system/usv-edge-rollback.service ]; then
    echo '  [PASS] usv-edge-rollback.service 已安装'
  else
    echo '  [FAIL] usv-edge-rollback.service 缺失'
    ok=0
  fi
  if [ -x "$BASE/bin/rollback.sh" ]; then
    echo '  [PASS] '"$BASE"'/bin/rollback.sh 可执行'
  else
    echo '  [FAIL] '"$BASE"'/bin/rollback.sh 缺失或不可执行'
    ok=0
  fi
  if systemctl show -p OnFailure usv-edge.service 2>/dev/null | grep -q 'usv-edge-rollback'; then
    echo '  [PASS] systemd 已加载 OnFailure（daemon-reload 生效）'
  else
    echo '  [FAIL] systemd 尚未加载 OnFailure —— 跑一次 systemctl daemon-reload'
    ok=0
  fi
  echo "  启动失败判定：$(systemctl show -p StartLimitBurst usv-edge.service 2>/dev/null || echo '未知')"
  return $((1 - ok))
}

if [ "$UNITS_ONLY" = "1" ]; then
  # 只更新 systemd 单元与回滚看门狗：不动 releases/、不动 current、不重启服务。
  # 用于「先给船上装好保险，再 OTA 推新版本」这种顺序。
  echo "== 只安装 unit 与回滚看门狗 =="
  install -m 644 scripts/usv-edge.service "$UNIT"
  install -m 644 scripts/usv-edge-rollback.service /etc/systemd/system/usv-edge-rollback.service
  mkdir -p "$BASE/bin"
  install -m 755 scripts/rollback.sh "$BASE/bin/rollback.sh"
  systemctl daemon-reload
  echo "当前版本：$(readlink "$BASE/current" 2>/dev/null || echo '(无软链)')"
  echo "== 自检 =="
  verify_watchdog || { echo "!! 保险未装好，先别推 OTA"; exit 1; }
  echo "== 保险就绪：现在可以安全 OTA =="
  exit 0
fi

if [ ! -x target/release/usv-edge ]; then
  echo "缺少 target/release/usv-edge，请先 cargo build --release" >&2
  exit 2
fi

VER=$(sed -n 's/^version *= *"\(.*\)"/\1/p' Cargo.toml | head -1)
# 两档默认参数。实机档必须带 --config：不传的话固件会退回内置默认值
# （dry_run=true → HAL=mock + 模拟雷达），表现为「端口对但船不动」，
# 这个坑在 2026-10-28 真机上踩过一次。
if [ "$DRY_PROFILE" = "1" ]; then
  ARGS=${ARGS:---dry-run --port 19527 --udp-port 19528 --ota-port 19530 --ota-dir $BASE}
else
  ARGS=${ARGS:---config $CONF --port 9527 --udp-port 9528 --ota-port 9530 --ota-dir $BASE}
fi

echo "== 安装版本 $VER =="
mkdir -p "$BASE/releases/$VER"
install -m 755 target/release/usv-edge "$BASE/releases/$VER/usv-edge"
ln -sfn "releases/$VER" "$BASE/current"

echo "== 写入 unit 与启动参数 =="
install -m 644 scripts/usv-edge.service "$UNIT"
install -m 644 scripts/usv-edge-rollback.service /etc/systemd/system/usv-edge-rollback.service
mkdir -p "$BASE/bin"
install -m 755 scripts/rollback.sh "$BASE/bin/rollback.sh"
printf 'USV_ARGS="%s"\n' "$ARGS" > "$DEFAULTS"
echo "USV_ARGS=$ARGS"
case "$ARGS" in
  *--dry-run*)
    echo "档位：调试（HAL=mock，不驱动真实 PWM）" ;;
  *--config*)
    if [ -f "$CONF" ]; then
      echo "档位：实机（配置 $CONF）"
      if grep -q '"dry_run"[[:space:]]*:[[:space:]]*true' "$CONF"; then
        echo "!! 但 $CONF 里 hardware.dry_run 是 true —— 仍然不会驱动 PWM"
      fi
    else
      echo "!! 缺少 $CONF —— 固件会退回内置默认值（dry_run=true），船不会动"
    fi ;;
  *)
    echo "!! 既没有 --config 也没有 --dry-run：固件将使用内置默认值（dry_run=true）" ;;
esac
echo "回滚看门狗：/etc/systemd/system/usv-edge-rollback.service -> $BASE/bin/rollback.sh"

systemctl daemon-reload
systemctl enable usv-edge >/dev/null
echo "已设为开机自启：$(systemctl is-enabled usv-edge)"

echo "== 回滚保险自检 =="
verify_watchdog || echo "!! 保险未装好（升级前请先跑 --units-only 排查）"

if [ "$START" = "1" ]; then
  systemctl restart usv-edge
  sleep 1
  systemctl --no-pager --lines=8 status usv-edge || true
else
  echo "未启动（--no-start）。重启后会自动拉起。"
fi

cat <<EOF

---- 常用命令 ----
查看状态 : systemctl status usv-edge --no-pager
实时日志 : journalctl -u usv-edge -f
本次启动 : systemctl restart usv-edge
关闭自启 : systemctl disable --now usv-edge
EOF
