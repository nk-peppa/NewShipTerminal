#!/bin/sh
# 启动失败看门狗：把推到一半/推坏的新版本切回上一版。
#
# 由 usv-edge.service 的 OnFailure= 拉起，即 systemd 判定「60 秒内 4 次起不来」
# 之后。刻意放在 Rust 之外：要防的正是「新二进制一行代码都跑不了」，
# 那种情况它自己没有任何机会回滚自己。
#
# 只依赖 sh + coreutils/sed，禁止调用 current/usv-edge（新版本此时不可信）。
#
# 用法：由 systemd 调用，也可手动执行 —— sh /opt/usv/bin/rollback.sh

BASE=${USV_BASE:-/opt/usv}
MARK="$BASE/rollback.json"
STAMP="$BASE/.rollback-last"
RETRY_GAP=300

log() { echo "[rollback] $*"; }

# 从 rollback.json 里取 "prev":"<ver>"（Pi 上不一定有 jq，用 sed）
read_prev() {
  sed -n 's/.*"prev"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$MARK" 2>/dev/null | head -1
}

restart_service() {
  systemctl reset-failed usv-edge >/dev/null 2>&1 || true
  systemctl restart usv-edge >/dev/null 2>&1 || true
}

# 原子切换：先建 .current.tmp 软链，再 mv -Tf 换上去。
# 与 ota.rs 的 switch_current() 用同一套手法，断电只会是旧或新，不会有中间态。
switch_to() {
  ln -sfn "releases/$1" "$BASE/.current.tmp" || return 1
  mv -Tf "$BASE/.current.tmp" "$BASE/current" || return 1
  return 0
}

if [ -f "$MARK" ]; then
  PREV=$(read_prev)
  if [ -n "$PREV" ] && [ -f "$BASE/releases/$PREV/usv-edge" ]; then
    CUR=$(readlink "$BASE/current" 2>/dev/null)
    log "新版本启动失败（当前 $CUR），回滚到 $PREV"
    # OTA 解包时可能丢可执行位（noexec 挂载、非 root 解包），这里补一下再切
    [ -x "$BASE/releases/$PREV/usv-edge" ] || chmod +x "$BASE/releases/$PREV/usv-edge" 2>/dev/null || true
    if switch_to "$PREV"; then
      rm -f "$MARK"
      restart_service
      log "已切回 $PREV 并重启；旧版本目录保留，可再次回滚"
      exit 0
    fi
    log "切换失败，保留当前版本（需要人工介入）"
    exit 1
  fi
  log "回滚标记无效（prev='$PREV'），丢弃标记"
  rm -f "$MARK"
fi

# 走到这里说明没有 OTA 标记 —— 是跟升级无关的崩溃循环（配置写错、硬件没接好）。
# 不能无限重启：5 分钟内只重试一次，避免刷爆 journal 和 SD 卡。
NOW=$(date +%s)
LAST=0
if [ -f "$STAMP" ]; then
  LAST=$(cat "$STAMP" 2>/dev/null)
  case "$LAST" in ''|*[!0-9]*) LAST=0 ;; esac
fi
if [ $((NOW - LAST)) -lt "$RETRY_GAP" ]; then
  log "非 OTA 故障，距上次重试不足 ${RETRY_GAP}s，保持 failed 等人工介入"
  exit 0
fi
echo "$NOW" > "$STAMP"
log "非 OTA 故障，重试一次"
restart_service