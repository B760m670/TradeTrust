#!/usr/bin/env bash
# Установка TradeTrust-бота на Ubuntu/Debian.
#   curl -fsSL https://raw.githubusercontent.com/B760m670/TradeTrust/main/deploy/install.sh | sudo bash
# Повторный запуск обновляет бота, настройки (.env) сохраняются.
#
# Уживается с тем, что уже работает на сервере: порты 80/443 не занимает. Если там уже есть
# Caddy (сайт, панель VPN), бот добавляется в него отдельным блоком — с резервной копией
# и проверкой конфигурации. Образ скачивается готовым, на сервере ничего не собирается.
set -euo pipefail

REPO="https://github.com/B760m670/TradeTrust.git"
BRANCH="${TRADETRUST_BRANCH:-main}"
DIR="/opt/tradetrust"

say() { printf '\n\033[1;34m%s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1" v </dev/tty; echo >/dev/tty; printf '%s' "$v"; }

[ "$(id -u)" -eq 0 ] || { echo "Запустите через sudo"; exit 1; }

if ! command -v docker >/dev/null 2>&1; then
  say "Ставлю Docker…"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$DIR/.git" ]; then
  say "Обновляю код…"
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q -B "$BRANCH" "origin/$BRANCH"
else
  say "Скачиваю код…"
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi
cd "$DIR"

say "Проверяю доступ к Bybit с этого сервера…"
code=$(curl -s -o /dev/null -w '%{http_code}' -m 15 https://api.bybit.com/v5/market/time || true)
if [ "$code" != "200" ]; then
  echo "⚠️  api.bybit.com ответил $code. Возможно, хостер в стране, которую Bybit блокирует."
  echo "   Бот не сможет торговать с этого сервера, пока доступа нет."
fi

if [ ! -f .env ]; then
  say "Настройка (.env)"
  cp .env.example .env
  set_env() { python3 - "$1" "$2" <<'PY'
import sys, re, pathlib
key, val = sys.argv[1], sys.argv[2]
p = pathlib.Path(".env"); s = p.read_text()
line = f"{key}={val}"
s = re.sub(rf"^{key}=.*$", lambda m: line, s, flags=re.M) if re.search(rf"^{key}=", s, re.M) else s + f"\n{line}\n"
p.write_text(s)
PY
  }

  echo "Где торговать?"
  echo "  1) paper   — бумажный счёт на реальных ценах, без ключей (для проверки)"
  echo "  2) demo    — демо-счёт Bybit (ненастоящие деньги)"
  echo "  3) mainnet — РЕАЛЬНЫЕ деньги"
  case "$(ask 'Выбор [1]: ')" in
    2) env=demo ;; 3) env=mainnet ;; *) env=paper ;;
  esac
  set_env BYBIT_ENV "$env"
  if [ "$env" != paper ]; then
    echo "Создайте API-ключ на Bybit: права только «Spot — Trade» (без вывода!), привязка к IP этого сервера."
    set_env BYBIT_API_KEY "$(ask 'API Key: ')"
    set_env BYBIT_API_SECRET "$(ask_secret 'API Secret (не отображается): ')"
    cap=$(ask 'Сколько USDT отдать боту (Enter — весь свободный USDT): ')
    [ -n "$cap" ] && set_env BOT_CAPITAL_USDT "$cap"
  fi

  echo "Режим: 1) только сигналы  2) с подтверждением (рекомендую)  3) автоматически"
  case "$(ask 'Выбор [2]: ')" in
    1) set_env MODE signals ;; 3) set_env MODE auto ;; *) set_env MODE confirm ;;
  esac

  echo "Telegram: создайте бота у @BotFather и вставьте токен — через него работают уведомления и мини-приложение."
  tg=$(ask 'Токен: ')
  if [ -n "$tg" ]; then
    set_env TELEGRAM_TOKEN "$tg"
    chat=""
    while [ -z "$chat" ]; do
      ask 'Напишите своему боту в Telegram /start, подождите пару секунд и нажмите Enter… ' >/dev/null
      chat=$(curl -s "https://api.telegram.org/bot$tg/getUpdates" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except ValueError:
    data = {}
if not data.get("ok"):
    print("ERR:" + str(data.get("description", "нет ответа от Telegram")))
else:
    ids = [u["message"]["chat"]["id"] for u in data.get("result", []) if "message" in u]
    print(ids[-1] if ids else "")')
      case "$chat" in
        ERR:*) echo "❌ Telegram не принял токен (${chat#ERR:}). Проверьте токен и запустите установку снова."; exit 1 ;;
        "") echo "Пока не вижу сообщения. Убедитесь, что пишете именно этому боту." ;;
        *) echo "✅ chat id: $chat" ;;
      esac
    done
    set_env TELEGRAM_CHAT_ID "$chat"
  fi

  ip=$(curl -s -m 10 https://api.ipify.org || true)
  set_env API_TOKEN "$(openssl rand -hex 24)"
  echo "Адрес мини-приложения. Можно свой поддомен (например bot.example.com — его A-запись должна"
  echo "указывать на этот сервер) или Enter — бесплатный адрес ${ip//./-}.sslip.io без настройки DNS."
  domain=$(ask "Адрес [${ip//./-}.sslip.io]: ")
  domain=${domain#https://}; domain=${domain%%/*}
  [ -z "$domain" ] && [ -n "$ip" ] && domain="${ip//./-}.sslip.io"
  [ -n "$domain" ] && set_env DOMAIN "$domain"
  chmod 600 .env
fi

env_get() { grep -m1 "^$1=" .env | cut -d= -f2- || true; }
port_busy() { ss -Htln "sport = :$1" | grep -q .; }
is_ours() { docker compose ps -q bot 2>/dev/null | grep -q . && docker compose port bot 8080 2>/dev/null | grep -q ":$1$"; }

# Внутренний порт бота (только 127.0.0.1): берём первый свободный, начиная с 8090.
BOT_PORT=$(env_get BOT_PORT)
if [ -z "$BOT_PORT" ]; then
  BOT_PORT=8090
  while port_busy "$BOT_PORT"; do BOT_PORT=$((BOT_PORT + 1)); done
  printf '\nBOT_PORT=%s\n' "$BOT_PORT" >> .env
elif port_busy "$BOT_PORT" && ! is_ours "$BOT_PORT"; then
  echo "❌ Порт $BOT_PORT (BOT_PORT в .env) занят другим процессом. Укажите свободный и запустите снова."
  exit 1
fi
DOMAIN=$(env_get DOMAIN)

PROFILE=""
CADDYFILE=/etc/caddy/Caddyfile
if systemctl is-active --quiet caddy && [ -f "$CADDYFILE" ] && [ -n "$DOMAIN" ]; then
  if grep -q "# tradetrust-begin" "$CADDYFILE"; then
    echo "Caddy уже настроен для бота."
  else
    say "На сервере работает Caddy — добавлю в него адрес бота"
    block=$(printf '\n# tradetrust-begin (TradeTrust bot, добавлено установщиком)\n%s {\n\treverse_proxy 127.0.0.1:%s\n}\n# tradetrust-end\n' "$DOMAIN" "$BOT_PORT")
    echo "В конец $CADDYFILE будет добавлено:"; echo "$block"
    case "$(ask 'Добавить? [Y/n]: ')" in n|N|н|Н) echo "Пропускаю. Настройте прокси на 127.0.0.1:$BOT_PORT вручную."; block="" ;; esac
    if [ -n "$block" ]; then
      backup="$CADDYFILE.bak-tradetrust-$(date +%Y%m%d-%H%M%S)"
      cp "$CADDYFILE" "$backup"
      printf '%s\n' "$block" >> "$CADDYFILE"
      if caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/tradetrust-caddy.log 2>&1; then
        systemctl reload caddy
        echo "✅ Caddy перезагружен. Резервная копия: $backup"
      else
        cp "$backup" "$CADDYFILE"
        echo "❌ Caddy не принял конфигурацию — вернул как было. Подробности: /tmp/tradetrust-caddy.log"
        echo "   Бот запустится, но мини-приложение будет недоступно, пока не настроите прокси на 127.0.0.1:$BOT_PORT."
      fi
    fi
  fi
elif ! port_busy 80 && ! port_busy 443; then
  PROFILE="--profile caddy"  # чистый сервер — свой Caddy с HTTPS
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
    ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
  fi
else
  echo "⚠️  Порты 80/443 заняты не Caddy. Бот слушает 127.0.0.1:$BOT_PORT — выведите его наружу"
  echo "   своим веб-сервером по HTTPS на адрес $DOMAIN (для мини-приложения нужен HTTPS)."
fi

say "Скачиваю и запускаю бота…"
if ! docker compose pull -q bot; then
  avail_mb=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ "$avail_mb" -lt 1500 ]; then
    echo "❌ Не удалось скачать готовый образ, а для сборки на месте мало памяти (свободно ${avail_mb} МБ)."
    echo "   Сборка может задеть другие сервисы на сервере. Попробуйте позже или напишите мне."
    exit 1
  fi
  docker compose build bot
fi
# shellcheck disable=SC2086
docker compose $PROFILE up -d
sleep 10
docker compose logs --tail 20 bot
if [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$(docker compose ps -aq bot)" 2>/dev/null)" != "true 0" ]; then
  echo
  echo "❌ Бот не запустился — причина в логах выше. Исправьте настройки: nano $DIR/.env,"
  echo "   затем: cd $DIR && docker compose up -d --force-recreate bot"
  exit 1
fi

say "Включаю автообновление (раз в час)…"
cat > /etc/systemd/system/tradetrust-update.service <<UNIT
[Unit]
Description=TradeTrust: обновить бота, если вышла новая версия
After=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/deploy/update.sh
UNIT
# в :35 — подальше от закрытия 4ч свечей (00, 04, 08… UTC), когда бот принимает решения
cat > /etc/systemd/system/tradetrust-update.timer <<'UNIT'
[Unit]
Description=TradeTrust: проверка обновлений раз в час

[Timer]
OnCalendar=*-*-* *:35:00
RandomizedDelaySec=120

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now tradetrust-update.timer >/dev/null

API_TOKEN=$(env_get API_TOKEN)
say "Готово."
echo "Логи:        cd $DIR && docker compose logs -f bot"
echo "Настройки:   nano $DIR/.env, затем: cd $DIR && docker compose up -d"
echo "Обновление:  автоматически раз в час (журнал: journalctl -u tradetrust-update)"
echo "             отключить: systemctl disable --now tradetrust-update.timer"
if [ -n "${DOMAIN:-}" ]; then
  echo
  echo "Мини-приложение: откройте своего бота в Telegram — кнопка «Открыть» слева от поля ввода"
  echo "  (или команда /app). Адрес: https://$DOMAIN"
  echo "  Первый запуск: сертификат HTTPS выпускается около минуты."
  echo
  echo "Android-приложение (вкладка «Бот»): адрес https://$DOMAIN, токен $API_TOKEN"
fi
