#!/usr/bin/env bash
# Автообновление: раз в час (таймер tradetrust-update.timer) проверяет новую версию и ставит её.
# Если образ не изменился, бот не перезапускается. Отключить: systemctl disable --now tradetrust-update.timer
set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="${TRADETRUST_BRANCH:-main}"
# docker-compose.yml и этот скрипт — из репозитория; .env и данные бота git не трогает
git fetch -q origin "$BRANCH" && git checkout -q -B "$BRANCH" "origin/$BRANCH" || echo "код не обновлён"

before=$(docker compose images -q bot 2>/dev/null || true)
docker compose pull -q bot
docker compose up -d bot
after=$(docker compose images -q bot 2>/dev/null || true)
if [ "$before" != "$after" ]; then
  echo "бот обновлён: ${before:-нет} → $after"
  docker image prune -f >/dev/null  # старые образы занимают место на диске
else
  echo "новой версии нет"
fi

# нагрузка сервера по сервисам для админки бота (ставится один раз, дальше ничего не меняет)
[ -x deploy/host-stats-install.sh ] && deploy/host-stats-install.sh || true
