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

    def candles(self, symbol, interval, limit=1000, end=None):
        if end:  # старая история не меняется — её не кэшируем, она нужна редко
            return self.market.candles(symbol, interval, limit, end)
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


# Что владелец меняет в админке (хранится в базе владельца, ключ "admin")
ADMIN_LIMITS = {"max_users": (int, 1, 1000), "demo_start_usdt": (float, 100.0, 1_000_000.0)}
ADMIN_FLAGS = ("registration_open", "notify_new_users")
SEEN_EVERY = 60  # last_seen пишется не чаще раза в минуту
DAY = 86400


class Users:
    def __init__(self, owner_cfg: Config, market, base_dir: Path, notifier_for=None, on_new_user=None,
                 admin_store: Store | None = None):
        """market — публичные данные (CachedMarket); notifier_for(chat_id) — уведомления в чат пользователя;
        admin_store — база владельца, где лежат настройки админки и список заблокированных."""
        self.cfg, self.market, self.dir = owner_cfg, market, Path(base_dir)
        self.notifier_for = notifier_for or (lambda chat_id: None)
        self.on_new_user = on_new_user or (lambda bot, total: None)
        self.admin_store = admin_store
        self.bots: dict[str, Bot] = {}
        self.seen: dict[str, float] = {}
        self.lock = threading.RLock()
        self.dir.mkdir(parents=True, exist_ok=True)
        for db in sorted(self.dir.glob("*.db")):
            if db.stem.isdigit():
                try:
                    self._open(db.stem)
                except Exception:
                    log.exception("демо-счёт %s не открылся", db.stem)

    # --- настройки админки ----------------------------------------------------
    def settings(self) -> dict:
        saved = self.admin_store.get("admin", {}) if self.admin_store else {}
        return {"registration_open": saved.get("registration_open", self.cfg.public_demo),
                "notify_new_users": saved.get("notify_new_users", False),
                "max_users": saved.get("max_users", self.cfg.max_users),
                "demo_start_usdt": saved.get("demo_start_usdt", self.cfg.paper_start_usdt)}

    def update_settings(self, changes: dict) -> dict:
        out = {}
        for key, value in changes.items():
            if key in ADMIN_LIMITS:
                kind, lo, hi = ADMIN_LIMITS[key]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
                    raise ValueError(f"{key}: от {lo:g} до {hi:g}")
                if kind is int and value != int(value):
                    raise ValueError(f"{key}: нужно целое число")
                out[key] = kind(value)
            elif key in ADMIN_FLAGS:
                if not isinstance(value, bool):
                    raise ValueError(f"{key}: нужно да или нет")
                out[key] = value
            else:
                raise ValueError(f"настройку «{key}» менять нельзя")
        if self.admin_store is not None:
            self.admin_store.set("admin", {**(self.admin_store.get("admin", {})), **out})
        return self.settings()

    def blocked(self) -> set[str]:
        return set(self.admin_store.get("blocked", [])) if self.admin_store else set()

    def closed_reason(self, user_id) -> str:
        """Почему новый пользователь не получил демо-счёт."""
        if str(user_id) in self.blocked():
            return "Доступ к демо-счёту закрыт."
        if not self.settings()["registration_open"]:
            return "Регистрация новых демо-счетов сейчас закрыта."
        return "Демо-счета сейчас закончились — попробуйте позже."

    # --- счета --------------------------------------------------------------
    def _config(self, user_id: str, start_usdt: float | None = None) -> Config:
        # стратегия и её значения по умолчанию — как у владельца; счёт — бумажный, бот торгует сам
        return replace(self.cfg, env="paper", mode="auto", api_key="", api_secret="", capital_usdt=0.0,
                       telegram_chat_id=user_id, db_path=str(self.dir / f"{user_id}.db"), account="demo",
                       coins=list(self.cfg.coins), paper_start_usdt=start_usdt or self.cfg.paper_start_usdt)

    def _open(self, user_id: str, start_usdt: float | None = None) -> Bot:
        cfg = self._config(user_id, start_usdt)
        store = Store(cfg.db_path)
        notifier: Notifier | None = self.notifier_for(user_id)
        bot = Bot(cfg, PaperExchange(self.market, store, cfg.paper_start_usdt), store, notifier)
        self.bots[user_id] = bot
        return bot

    def get(self, user_id, profile: dict | None = None, create: bool = False) -> Bot | None:
        """Бот пользователя; create=True — открыть демо-счёт, если его ещё нет (и регистрация открыта, есть место).
        Заблокированным — None."""
        user_id = str(user_id)
        if not user_id.isdigit() or user_id == str(self.cfg.telegram_chat_id) or user_id in self.blocked():
            return None
        with self.lock:
            bot = self.bots.get(user_id)
            if bot or not create:
                if bot:
                    self._touch(bot, profile)
                return bot
            opts = self.settings()
            if not opts["registration_open"] or len(self.bots) >= opts["max_users"]:
                return None
            bot = self._open(user_id, opts["demo_start_usdt"])
            total = len(self.bots)
        bot.store.set("joined_at", int(time.time()))
        self._touch(bot, profile)
        bot.notify(WELCOME.format(usdt=bot.cfg.paper_start_usdt))
        self.on_new_user(bot, total)
        self._start_first_scan(bot)
        return bot

    def _touch(self, bot: Bot, profile: dict | None) -> None:
        """Последний вход и имя — для админки; пишем не чаще раза в минуту."""
        uid = bot.cfg.telegram_chat_id
        t = time.time()
        if t - self.seen.get(uid, 0) < SEEN_EVERY:
            return
        self.seen[uid] = t
        bot.store.set("last_seen", int(t))
        if profile:
            bot.store.set("profile", _profile(profile))

    def _start_first_scan(self, bot: Bot) -> None:
        # сразу посмотреть рынок, чтобы в приложении были сигналы, а не пустота до следующей свечи
        threading.Thread(target=self._first_scan, args=(bot,), name=f"user-{bot.cfg.telegram_chat_id}",
                         daemon=True).start()

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

    # --- действия админа ------------------------------------------------------
    def _drop(self, user_id: str) -> Bot | None:
        with self.lock:
            bot = self.bots.pop(user_id, None)
        if bot:
            with bot.lock:
                bot.store.close()
            Path(bot.cfg.db_path).unlink(missing_ok=True)
        return bot

    def reset(self, user_id: str) -> str:
        """Новый демо-счёт с нуля: позиции, сделки и настройки стираются, профиль и дата регистрации остаются."""
        user_id = str(user_id)
        old = self.bots.get(user_id)
        if old is None:
            raise KeyError(user_id)
        keep = {k: old.store.get(k) for k in ("profile", "joined_at", "last_seen")}
        self._drop(user_id)
        with self.lock:
            bot = self._open(user_id, self.settings()["demo_start_usdt"])
        for k, v in keep.items():
            if v is not None:
                bot.store.set(k, v)
        bot.notify("🔄 Демо-счёт сброшен: " + WELCOME.format(usdt=bot.cfg.paper_start_usdt).removeprefix("👋 Демо-счёт открыт: "))
        self._start_first_scan(bot)
        return "Счёт сброшен"

    def delete(self, user_id: str) -> str:
        if self._drop(str(user_id)) is None:
            raise KeyError(user_id)
        return "Счёт удалён"

    def set_blocked(self, user_id: str, blocked: bool) -> str:
        user_id = str(user_id)
        if not user_id.isdigit():
            raise KeyError(user_id)
        ids = self.blocked()
        ids = ids | {user_id} if blocked else ids - {user_id}
        if self.admin_store is not None:
            self.admin_store.set("blocked", sorted(ids))
        bot = self.bots.get(user_id)
        if bot and blocked:
            bot.pause("доступ закрыт администратором")
        elif bot and bot.paused == "доступ закрыт администратором":
            bot.resume()
        return "Заблокирован" if blocked else "Разблокирован"

    def broadcast(self, text: str, sleep: float = 0.05) -> int:
        """Сообщение всем незаблокированным пользователям (в фоне); возвращает, скольким отправляется."""
        text = text.strip()
        if not text:
            raise ValueError("пустое сообщение")
        if len(text) > 3500:
            raise ValueError("слишком длинное сообщение (до 3500 символов)")
        blocked = self.blocked()
        targets = [b for b in self.all() if b.cfg.telegram_chat_id not in blocked]

        def run() -> None:
            for b in targets:
                try:
                    b.notifier.send("📣 " + text)  # в журнал счёта не пишем
                except Exception:
                    log.warning("рассылка: %s не получил сообщение", b.cfg.telegram_chat_id)
                time.sleep(sleep)  # Telegram: не больше ~30 сообщений в секунду

        threading.Thread(target=run, name="broadcast", daemon=True).start()
        return len(targets)

    # --- данные для админки ---------------------------------------------------
    def rows(self) -> list[dict]:
        blocked = self.blocked()
        out = []
        for b in self.all():
            try:
                eq = b.equity()["total"]
            except Exception:  # нет цены — покажем без капитала
                eq = None
            trades = b.store.trades(1000)
            start = b.cfg.paper_start_usdt
            p = b.store.get("profile") or {}
            out.append({
                "id": b.cfg.telegram_chat_id, "name": p.get("name", ""), "username": p.get("username", ""),
                "joined_at": b.store.get("joined_at"), "last_seen": b.store.get("last_seen"),
                "equity": eq, "start": start, "pnl_pct": (eq / start - 1) * 100 if eq is not None else None,
                "positions": len(b.store.positions()), "trades": len(trades),
                "wins": sum(1 for t in trades if t["pnl_usdt"] > 0),
                "mode": b.mode, "paused": b.paused, "blocked": b.cfg.telegram_chat_id in blocked,
            })
        out.sort(key=lambda r: -(r["joined_at"] or 0))
        return out

    def stats(self, rows: list[dict] | None = None, days: int = 30) -> dict:
        rows = self.rows() if rows is None else rows
        t = time.time()
        joined = [r["joined_at"] for r in rows if r["joined_at"]]
        seen = [r["last_seen"] for r in rows if r["last_seen"]]
        today = int(t // DAY)
        per_day = [{"day": (today - k) * DAY, "count": 0} for k in range(days - 1, -1, -1)]
        for j in joined:
            k = days - 1 - (today - int(j // DAY))
            if 0 <= k < days:
                per_day[k]["count"] += 1
        return {
            "total": len(rows), "new_day": sum(1 for j in joined if t - j < DAY),
            "new_week": sum(1 for j in joined if t - j < 7 * DAY),
            "active_day": sum(1 for s in seen if t - s < DAY), "active_week": sum(1 for s in seen if t - s < 7 * DAY),
            "profitable": sum(1 for r in rows if (r["pnl_pct"] or 0) > 0),
            "losing": sum(1 for r in rows if (r["pnl_pct"] or 0) < 0),
            "blocked": len(self.blocked()), "signups": per_day,
        }

    def daily_line(self) -> str | None:
        """Строка в ежедневную сводку владельца — вместо сообщения о каждом новом пользователе."""
        s = self.stats()
        if not s["total"]:
            return None
        return f"Демо-счетов: {s['total']} (+{s['new_day']} за сутки), заходили за сутки: {s['active_day']}"

    def summary(self) -> str:
        rows = self.rows()
        if not rows:
            return "Демо-счетов пока нет."
        lines = [f"Демо-счетов: {len(rows)} из {self.settings()['max_users']}"]
        for r in rows[:20]:
            name = r["name"] or r["id"]
            eq = f"{r['equity']:,.2f} USDT" if r["equity"] is not None else "—"
            lines.append(f"• {name}{' @' + r['username'] if r['username'] else ''}: {eq}, позиций {r['positions']}")
        return "\n".join(lines)


def _profile(user: dict) -> dict:
    name = " ".join(x for x in (user.get("first_name"), user.get("last_name")) if x)
    return {"name": name, "username": user.get("username") or ""}
