"""Демо-счета для всех: любой пользователь Telegram получает своего бота на бумажном счёте.

У каждого — своя база (users/<telegram id>.db), свои настройки, позиции и уведомления в его чат.
Стратегия та же, что у владельца, деньги виртуальные: PAPER_START_USDT (1000 USDT).
Цены и свечи — общие для всех: берутся с Bybit один раз и раздаются из кэша.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import replace
from pathlib import Path

from .config import Config
from .engine import Bot, Notifier
from .paper import PaperExchange
from .store import Store

log = logging.getLogger("tradetrust.users")

WELCOME = ("👋 Демо-счёт открыт: {usdt:,.0f} виртуальных USDT.\n"
           "Бот торгует на нём сам — по той же стратегии и по тем же ценам Bybit, что и на настоящем счёте. "
           "Настоящие деньги не используются. Сделки, сигналы и итоги — в приложении и здесь, в чате.")


class CachedMarket:
    """Публичные данные биржи с коротким кэшем: сто демо-счетов на закрытии свечи — один запрос на монету."""

    def __init__(self, market, candles_ttl: float = 120.0, price_ttl: float = 5.0):
        self.market = market
        self.candles_ttl, self.price_ttl = candles_ttl, price_ttl
        self.cache: dict[tuple, tuple[float, object]] = {}
        self.lock = threading.Lock()

    def _get(self, key: tuple, ttl: float, load):
        with self.lock:
            hit = self.cache.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        value = load()
        with self.lock:
            self.cache[key] = (time.time(), value)
        return value

    def candles(self, symbol, interval, limit=1000):
        return self._get(("candles", symbol, interval, limit), self.candles_ttl,
                         lambda: self.market.candles(symbol, interval, limit))

    def last_price(self, symbol):
        return self._get(("price", symbol), self.price_ttl, lambda: self.market.last_price(symbol))

    def instrument(self, symbol):
        return self._get(("instrument", symbol), 86400, lambda: self.market.instrument(symbol))

    def recent_trades(self, symbol):
        return self._get(("trades", symbol), 2.0, lambda: self.market.recent_trades(symbol))

    def holdings(self):  # у публичного рынка счёта нет
        return {}


class Users:
    def __init__(self, owner_cfg: Config, market, base_dir: Path, notifier_for=None, on_new_user=None):
        """market — публичные данные (CachedMarket); notifier_for(chat_id) — уведомления в чат пользователя."""
        self.cfg, self.market, self.dir = owner_cfg, market, Path(base_dir)
        self.notifier_for = notifier_for or (lambda chat_id: None)
        self.on_new_user = on_new_user or (lambda bot, total: None)
        self.bots: dict[str, Bot] = {}
        self.lock = threading.RLock()
        self.dir.mkdir(parents=True, exist_ok=True)
        for db in sorted(self.dir.glob("*.db")):
            if db.stem.isdigit():
                try:
                    self._open(db.stem)
                except Exception:
                    log.exception("демо-счёт %s не открылся", db.stem)

    def _config(self, user_id: str) -> Config:
        # стратегия и её значения по умолчанию — как у владельца; счёт — бумажный, бот торгует сам
        return replace(self.cfg, env="paper", mode="auto", api_key="", api_secret="", capital_usdt=0.0,
                       telegram_chat_id=user_id, db_path=str(self.dir / f"{user_id}.db"), account="demo",
                       coins=list(self.cfg.coins))

    def _open(self, user_id: str) -> Bot:
        cfg = self._config(user_id)
        store = Store(cfg.db_path)
        notifier: Notifier | None = self.notifier_for(user_id)
        bot = Bot(cfg, PaperExchange(self.market, store, cfg.paper_start_usdt), store, notifier)
        self.bots[user_id] = bot
        return bot

    def get(self, user_id, profile: dict | None = None, create: bool = False) -> Bot | None:
        """Бот пользователя; create=True — открыть демо-счёт, если его ещё нет (и есть место)."""
        user_id = str(user_id)
        if not user_id.isdigit() or user_id == str(self.cfg.telegram_chat_id):
            return None
        with self.lock:
            bot = self.bots.get(user_id)
            if bot or not create:
                if bot and profile:
                    bot.store.set("profile", _profile(profile))
                return bot
            if len(self.bots) >= self.cfg.max_users:
                return None
            bot = self._open(user_id)
            total = len(self.bots)
        if profile:
            bot.store.set("profile", _profile(profile))
        bot.store.set("joined_at", int(time.time()))
        bot.notify(WELCOME.format(usdt=bot.cfg.paper_start_usdt))
        self.on_new_user(bot, total)
        # сразу посмотреть рынок, чтобы в приложении были сигналы, а не пустота до следующей свечи
        threading.Thread(target=self._first_scan, args=(bot,), name=f"user-{user_id}", daemon=True).start()
        return bot

    @staticmethod
    def _first_scan(bot: Bot) -> None:
        try:
            bot.on_candle_close()
            bot.record_equity()
        except Exception:
            log.exception("первая проверка рынка для демо-счёта")

    def all(self) -> list[Bot]:
        with self.lock:
            return list(self.bots.values())

    def summary(self) -> str:
        bots = self.all()
        if not bots:
            return "Демо-счетов пока нет."
        lines = [f"Демо-счетов: {len(bots)} из {self.cfg.max_users}"]
        for b in sorted(bots, key=lambda b: -b.store.get("joined_at", 0))[:20]:
            p = b.store.get("profile") or {}
            name = p.get("name") or b.cfg.telegram_chat_id
            lines.append(f"• {name}{' @' + p['username'] if p.get('username') else ''}: "
                         f"{b.equity()['total']:,.2f} USDT, позиций {len(b.store.positions())}")
        return "\n".join(lines)


def _profile(user: dict) -> dict:
    name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x)
    return {"name": name, "username": user.get("username") or ""}
