#!/usr/bin/env bash
# Установка TradeTrust-бота на Ubuntu/Debian.
#   curl -fsSL https://raw.githubusercontent.com/B760m670/TradeTrust/main/deploy/install.sh | sudo bash
# Повторный запуск обновляет код и перезапускает бота, настройки (.env) сохраняются.
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
    ask 'Напишите своему боту в Telegram /start и нажмите Enter… ' >/dev/null
    chat=$(curl -s "https://api.telegram.org/bot$tg/getUpdates" | python3 -c '
import json, sys
ups = json.load(sys.stdin).get("result", [])
ids = [u["message"]["chat"]["id"] for u in ups if "message" in u]
print(ids[-1] if ids else "")')
    [ -z "$chat" ] && chat=$(ask 'Не нашёл сообщение. Введите chat id вручную: ')
    set_env TELEGRAM_CHAT_ID "$chat"
  fi

  ip=$(curl -s -m 10 https://api.ipify.org || true)
  set_env API_TOKEN "$(openssl rand -hex 24)"
  [ -n "$ip" ] && set_env DOMAIN "${ip//./-}.sslip.io"
  chmod 600 .env
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q active; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

say "Запускаю…"
docker compose up -d --build
sleep 5
docker compose logs --tail 20 bot

DOMAIN=$(grep -m1 '^DOMAIN=' .env | cut -d= -f2-)
API_TOKEN=$(grep -m1 '^API_TOKEN=' .env | cut -d= -f2-)
say "Готово."
echo "Логи:        cd $DIR && docker compose logs -f bot"
echo "Настройки:   nano $DIR/.env, затем: docker compose up -d"
echo "Обновление:  повторно запустите этот скрипт"
if [ -n "${DOMAIN:-}" ]; then
  echo
  echo "Мини-приложение: откройте своего бота в Telegram — кнопка «Открыть» слева от поля ввода"
  echo "  (или команда /app). Адрес: https://$DOMAIN"
  echo "  Первый запуск: сертификат HTTPS выпускается ~1 минуту; порты 80 и 443 должны быть открыты у хостера."
  echo
  echo "Android-приложение (вкладка «Бот»): адрес https://$DOMAIN, токен $API_TOKEN"
fi
