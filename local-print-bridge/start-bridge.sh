#!/usr/bin/env bash
# Cafe POS — Local Print Bridge / LAN Print Hub cho macOS, Linux & Raspberry Pi
# Cho phép toàn bộ iPad / Android Tablet trong quán in im lặng không hộp thoại (ESC/POS + TSPL2 + RJ11)

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[LOI] Chua cai dat Node.js (>= 18). Tren Raspberry Pi/Ubuntu, chay:"
  echo "      curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

echo "=============================================================="
echo "  CAFE POS — LAN & CLOUD PRINT HUB (macOS / Linux / Raspberry Pi)"
echo "  Dang khoi dong Local Print Bridge tai cong ${PRINT_BRIDGE_PORT:-9100}..."
echo "=============================================================="
exec node bridge-server.js
