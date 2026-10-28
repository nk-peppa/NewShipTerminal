#!/bin/sh
# 在船端 Orange Pi 上一键准备 Rust 工具链 + 编译 + 跑协议单测。
# 用法：sh scripts/bootstrap-pi.sh
set -e

echo "== env =="
uname -m
. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"
echo "cores: $(nproc)  mem: $(free -m | awk '/Mem:/{print $2"MB"}')"
df -h / | tail -1

for t in cc gcc make; do
  if ! command -v "$t" >/dev/null 2>&1; then echo "WARN: $t not found (apt install -y build-essential)"; fi
done

if ! command -v cargo >/dev/null 2>&1; then
  echo "== installing rustup (minimal, ~300MB) =="
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs -o /tmp/rustup.sh || {
      echo "ERROR: cannot reach static.rust-lang.org"; exit 3; }
  elif command -v wget >/dev/null 2>&1; then
    wget -q https://sh.rustup.rs -O /tmp/rustup.sh || {
      echo "ERROR: cannot reach static.rust-lang.org"; exit 3; }
  else
    echo "ERROR: neither curl nor wget"; exit 3
  fi
  sh /tmp/rustup.sh -y --profile minimal --default-toolchain stable --no-modify-path
fi

export PATH="$HOME/.cargo/bin:$PATH"
echo "== versions =="
rustc --version
cargo --version

cd "$(dirname "$0")/.."
echo "== build (release) =="
cargo build --release 2>&1 | tail -25

echo "== protocol tests =="
cargo test --release 2>&1 | tail -30

echo "== artifact =="
ls -lh target/release/usv-edge 2>/dev/null || true
echo "== done =="