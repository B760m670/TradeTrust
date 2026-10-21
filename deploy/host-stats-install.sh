#!/usr/bin/env bash
# Ставит (или обновляет) сбор нагрузки сервера для админки: раз в минуту deploy/host_stats.py пишет
# botdata/host_stats.json. Вызывается из install.sh и update.sh; повторный запуск ничего не меняет.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)"
command -v python3 >/dev/null 2>&1 || exit 0
mkdir -p "$DIR/botdata"

service="[Unit]
Description=TradeTrust: нагрузка сервера для админки

[Service]
Type=oneshot
Nice=10
ExecStart=/usr/bin/env python3 $DIR/deploy/host_stats.py $DIR/botdata/host_stats.json"
timer="[Unit]
Description=TradeTrust: нагрузка сервера раз в минуту

[Timer]
OnBootSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target"

changed=0
put() {  # put <файл> <содержимое>: пишет, только если отличается
  if [ "$(cat "$1" 2>/dev/null)" != "$2" ]; then
    printf '%s\n' "$2" > "$1"
    changed=1
  fi
}
put /etc/systemd/system/tradetrust-stats.service "$service"
put /etc/systemd/system/tradetrust-stats.timer "$timer"
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  echo "сбор нагрузки сервера для админки: включён"
fi
systemctl enable --now tradetrust-stats.timer >/dev/null 2>&1 || true
