"""Запуск бота: python -m tradetrust.bot (настройки — из переменных окружения, см. .env.example)."""
from __future__ import annotations

import logging
import time
from pathlib import Path

from dataclasses import replace

from . import admin, api
from .accounts import REAL_TAG, Accounts, TaggedNotifier, check_key
from .bybit import BybitClient, BybitExchange
from .config import Config
from .engine import Bot, next_bar_close
from .paper import PaperExchange
from .store import Store
from .telegram import Telegram
from .users import CachedMarket, Users

log = logging.getLogger("tradetrust.bot")
RECONCILE_SECONDS = 60


def connect_real(cfg: Config, notifier) -> tuple[Bot | None, str]:
    """Реальный счёт владельца, если его ключ задан в .env: (бот, почему не подключился)."""
    if not cfg.has_real:
        return None, ""
    real_cfg = replace(cfg, env="mainnet", api_key=cfg.real_api_key, api_secret=cfg.real_api_secret,
                       base_url=cfg.real_base_url, real_api_key="", real_api_secret="", account="real",
                       db_path=str(Path(cfg.db_path).resolve().parent / "real.db"), coins=list(cfg.coins),
                       mode="confirm", capital_usdt=0.0, bot_enabled=False)
    client = BybitClient("mainnet", real_cfg.api_key, real_cfg.api_secret, base_url=real_cfg.base_url or None)
    try:
        client.sync_time()
        error, warn = check_key(client.key_info())
        if error:
            raise ValueError(error)
        exchange = BybitExchange(client)
        exchange.balance("USDT")
    except Exception as exc:
        log.exception("реальный счёт")
        return None, str(exc)[:300]
    real = Bot(real_cfg, exchange, Store(real_cfg.db_path), TaggedNotifier(notifier, REAL_TAG) if notifier else None)
    if warn:
        real.notify(f"⚠️ {warn}")
    return real, ""


def build(cfg: Config) -> tuple[Accounts, Users | None]:
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
    # публичные данные основного рынка, общие для всех: графики владельца и цены демо-счетов пользователей
    market = CachedMarket(BybitExchange(BybitClient("mainnet", base_url=cfg.base_url or None)))
    if cfg.env != "mainnet":
        bot.market = market
    accounts = Accounts(bot, *connect_real(cfg, notifier))
    users = None
    if notifier:
        # демо-счета: цены основного рынка Bybit, общие для всех и из кэша. Регистрацию новых
        # открывает PUBLIC_DEMO, дальше — переключатель в админке
        def new_user(user_bot: Bot, total: int) -> None:
            if not users.settings()["notify_new_users"]:
                return  # по умолчанию — только строкой в ежедневной сводке и в админке
            p = user_bot.store.get("profile") or {}
            who = (p.get("name") or user_bot.cfg.telegram_chat_id) + (f" @{p['username']}" if p.get("username") else "")
            bot.notify(f"👤 Новый демо-счёт: {who}. Всего {total}.")

        users = Users(cfg, market, Path(cfg.db_path).resolve().parent / "users", notifier.for_chat, new_user,
                      admin_store=store)
        bot.report_extras.append(users.daily_line)
    if notifier:
        notifier.start(bot, users, accounts)
    # HTTP нужен и мини-приложению (вход по подписи Telegram), и Android-приложению (по API_TOKEN)
    api.serve(bot, cfg.api_token, cfg.api_port, cfg.telegram_token, cfg.telegram_chat_id, users=users,
              telegram=notifier, accounts=accounts)
    return accounts, users


def tick(bots: list[Bot], candle_closed: bool) -> None:
    """Один проход цикла по всем счетам: стопы, закрытие свечи, сводка. Ошибка одного демо-счёта не мешает другим."""
    for b in bots:
        try:
            b.reconcile()
            if candle_closed:
                b.on_candle_close()
            b.maybe_daily_report()
        except Exception:
            log.exception("демо-счёт %s", b.cfg.telegram_chat_id)


class OwnerErrors:
    """Ошибки на счетах владельца — в Telegram, но одна и та же (например, биржа недоступна) не чаще раза в час."""

    def __init__(self):
        self.last: dict[str, tuple[str, float]] = {}

    def run(self, bot: Bot, step) -> bool:
        try:
            step()
            return True
        except Exception as exc:
            log.exception("счёт %s", bot.cfg.account)
            text, at = self.last.get(bot.cfg.account, ("", 0.0))
            if str(exc) != text or time.time() - at > 3600:
                bot.notify(f"⚠️ Ошибка: {exc}")
                self.last[bot.cfg.account] = (str(exc), time.time())
            return False


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger().addHandler(admin.ERRORS)  # последние ошибки — в админке
    cfg = Config.from_env()
    accounts, users = build(cfg)
    bot = accounts.main
    if cfg.env != "paper":
        bot.ex.balance("USDT")  # проверка ключа сразу при старте, а не при первой сделке
    names = {"paper": "бумажный счёт", "demo": "демо-счёт Bybit", "testnet": "тестовая сеть Bybit",
             "mainnet": "РЕАЛЬНЫЙ счёт Bybit"}
    demo = f", демо-счетов пользователей: {len(users.all())}" if users is not None else ""
    real = ("\n💰 Реальный счёт подключён" + ("" if accounts.real.enabled else ", бот на нём выключен")
            if accounts.real else f"\n❗ Реальный счёт не подключился: {accounts.real_error}" if accounts.real_error else "")
    bot.notify(f"🤖 TradeTrust запущен: {names[cfg.env]}, режим {bot.mode}, монет {len(cfg.coins)}{demo}.{real}"
               "\n/help — команды")

    errors = OwnerErrors()
    for b in accounts.all():
        errors.run(b, b.reconcile)
        errors.run(b, b.on_candle_close)  # если сервер перезапускался — обработать последнюю закрытую свечу
        b.record_equity()
    if users is not None:
        tick([b for b in users.all() if b.cfg.telegram_chat_id not in users.blocked()], True)
    next_close = next_bar_close()
    while True:
        time.sleep(RECONCILE_SECONDS)
        closed, done = time.time() >= next_close, True
        for b in accounts.all():
            errors.run(b, b.reconcile)
            if closed:
                done = errors.run(b, b.on_candle_close) and done
            errors.run(b, b.maybe_daily_report)
        if users is not None:
            blocked = users.blocked()
            tick([b for b in users.all() if b.cfg.telegram_chat_id not in blocked], closed)
        if closed and done:  # не вышло — повторим через минуту
            next_close = next_bar_close()


if __name__ == "__main__":
    main()
