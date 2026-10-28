#!/bin/sh
# 采样 CPU 温度 / 频率 / 负载 / 服务进程 CPU 占用
# 用法：
#   sh scripts/thermal-sample.sh            # 单次
#   sh scripts/thermal-sample.sh 60 5       # 60 秒，每 5 秒一次
set -e

DURATION=${1:-0}
INTERVAL=${2:-5}
SERVICE=${SERVICE:-usv-edge}

read_temp() {
  for z in /sys/class/thermal/thermal_zone*/temp; do
    [ -e "$z" ] || continue
    t=$(cat "$z" 2>/dev/null) || continue
    # 只取看起来像 milli-degree 的（>1000）
    [ "$t" -gt 1000 ] 2>/dev/null && { echo "$t"; return; }
  done
  echo 0
}

read_freqs() {
  f=""
  for c in /sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq; do
    [ -e "$c" ] || continue
    f="$f $(( $(cat "$c") / 1000 ))"
  done
  echo "$f"
}

sample() {
  temp=$(read_temp)
  temp_c=$(awk -v t="$temp" 'BEGIN{printf "%.1f", t/1000}')
  load=$(awk '{print $1", "$2", "$3}' /proc/loadavg)
  freqs=$(read_freqs)
  if command -v systemctl >/dev/null 2>&1; then
    cpu=$(ps -o %cpu= -p "$(pgrep -f "opt/usv/current/usv-edge" | head -1)" 2>/dev/null | tr -d ' ')
  else
    cpu="?"
  fi
  pid=$(pgrep -f "opt/usv/current/usv-edge" | head -1)
  mem=$(ps -o rss= -p "$pid" 2>/dev/null | awk '{printf "%.1f", $1/1024}')

  printf '%s  temp=%sC  load=%s  freqMHz=%s  cpu%%=%s  rss=%sMB\n' \
    "$(date +%H:%M:%S)" "$temp_c" "$load" "$freqs" "${cpu:-?}" "${mem:-?}"
}

echo "== 采样开始（温度/负载/频率/${SERVICE} 占用）=="
if [ "$DURATION" = "0" ]; then
  sample
else
  end=$(( $(date +%s) + DURATION ))
  while [ "$(date +%s)" -lt "$end" ]; do
    sample
    sleep "$INTERVAL"
  done
fi
