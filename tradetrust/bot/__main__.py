"""Запуск бота: python -m tradetrust.bot (настройки — из переменных окружения, см. .env.example)."""
from __future__ import annotations

import logging
import time

from . import api
from .bybit import BybitClient, BybitExchange
from .config import Config
from .engine import Bot, next_bar_close
from .paper import PaperExchange
from .store import Store
from .telegram import Telegram

log = logging.getLogger("tradetrust.bot")
RECONCILE_SECONDS = 60


def build(cfg: Config) -> Bot:
    store = Store(cfg.db_path)
    if cfg.env == "paper":
        client = BybitClient("mainnet", base_url=cfg.base_url or None)  # только публичные данные
        exchange = PaperExchange(BybitExchange(client), store, cfg.paper_start_usdt)
    else:
        client = BybitClient(cfg.env, cfg.api_key, cfg.api_secret, base_url=cfg.base_url or None)
        exchange = BybitExchange(client)
    client.sync_time()
    notifier = Telegram(cfg.telegram_token, cfg.telegram_chat_id, cfg.webapp_url) if cfg.telegram_token else None
    bot = Bot(cfg, exchange, store, notifier)
    if notifier:
        notifier.start(bot)
    # HTTP нужен и мини-приложению (вход по подписи Telegram), и Android-приложению (по API_TOKEN)
    api.serve(bot, cfg.api_token, cfg.api_port, cfg.telegram_token, cfg.telegram_chat_id)
    return bot


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = Config.from_env()
    bot = build(cfg)
    if cfg.env != "paper":
        bot.ex.balance("USDT")  # проверка ключа сразу при старте, а не при первой сделке
    names = {"paper": "бумажный счёт", "demo": "демо-счёт Bybit", "testnet": "тестовая сеть Bybit",
             "mainnet": "РЕАЛЬНЫЙ счёт Bybit"}
    bot.notify(f"🤖 TradeTrust запущен: {names[cfg.env]}, режим {bot.mode}, монет {len(cfg.coins)}.\n/help — команды")

    bot.reconcile()
    bot.on_candle_close()  # если сервер перезапускался — обработать последнюю закрытую свечу
    next_close = next_bar_close()
    last_error, last_error_at = "", 0.0
    while True:
        time.sleep(RECONCILE_SECONDS)
        try:
            bot.reconcile()
            if time.time() >= next_close:
                bot.on_candle_close()
                next_close = next_bar_close()
        except Exception as exc:
            log.exception("main loop")
            # одна и та же ошибка (например, биржа недоступна) — не чаще раза в час
            if str(exc) != last_error or time.time() - last_error_at > 3600:
                bot.notify(f"⚠️ Ошибка: {exc}")
                last_error, last_error_at = str(exc), time.time()


if __name__ == "__main__":
    main()
