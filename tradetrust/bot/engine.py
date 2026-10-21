"""Логика бота: сигналы на закрытии 4ч свечи, размер позиции, лимиты, исполнение, сверка с биржей.

Правила те же, что в бэктесте (tradetrust/backtest.py): вход по пересечению EMA вверх,
стоп entry − atr_mult × ATR, выход при EMA fast < EMA slow или по стопу.
Бот управляет только позициями, которые открыл сам; остальные монеты на счёте не трогает.
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Protocol

import pandas as pd

from .. import backtest as bt
from ..indicators import btc_regime, sma
from ..research import COINS
from .config import Config
from .store import Position, Proposal, Store, now

log = logging.getLogger("tradetrust.bot")
BAR_SECONDS = 4 * 3600


class Notifier(Protocol):
    def send(self, text: str, buttons: list[list[tuple[str, str]]] | None = None) -> int | None: ...
    def edit(self, message_id: int, text: str) -> None: ...


class LogNotifier:
    def send(self, text, buttons=None):
        log.info("NOTIFY: %s", text)
        return None

    def edit(self, message_id, text):
        log.info("EDIT %s: %s", message_id, text)


@dataclass
class Plan:
    qty: Decimal
    price: float
    stop: float
    risk_usdt: float


def fmt(x: float) -> str:
    return f"{x:,.1f}" if x >= 1000 else f"{x:.4g}"


# Что владелец может менять из мини-приложения, и в каких границах. Параметры самой системы
# (EMA, ATR) — только в .env: на них построены проверки на истории.
LIMITS: dict[str, tuple[type, float, float]] = {
    "risk_pct": (float, 0.1, 3.0),
    "max_positions": (int, 1, 25),
    "max_position_pct": (float, 5.0, 50.0),
    "max_total_risk_pct": (float, 1.0, 10.0),
    "daily_loss_limit_pct": (float, 1.0, 10.0),
    "capital_usdt": (float, 0.0, 10_000_000.0),
    "proposal_ttl_min": (int, 15, 240),
    "report_hour_utc": (int, 0, 23),
    "trend_days": (int, 30, 160),  # 160 дней — столько 4ч свечей (1000) отдаёт биржа за раз
    "btc_days": (int, 20, 200),
}
FLAGS = ("btc_filter", "daily_report", "trend_filter")
EDITABLE = (*LIMITS, *FLAGS, "coins")
LABELS = {
    "risk_pct": "риск на сделку, %", "max_positions": "позиций максимум", "max_position_pct": "в одной монете, %",
    "max_total_risk_pct": "общий риск, %", "daily_loss_limit_pct": "дневной лимит убытка, %",
    "capital_usdt": "капитал бота, USDT", "proposal_ttl_min": "предложение действует, мин",
    "btc_filter": "пауза, когда BTC падает", "btc_days": "средняя BTC, дней", "coins": "монеты",
    "daily_report": "ежедневный отчёт", "report_hour_utc": "время отчёта (UTC), ч",
    "trend_filter": "только монеты в росте", "trend_days": "рост за, дней",
}
# Версия 2 стратегии (21.10.2026): маленький риск на все монеты + фильтр долгосрочного тренда.
# Обоснование и цифры — README, «Портфель целиком», scripts/portfolio_study.py.
STRATEGY_V2 = {"risk_pct": 0.3, "max_positions": 25, "max_total_risk_pct": 10.0, "trend_filter": True}
OLD_DEFAULTS = {"risk_pct": 1.0, "max_positions": 5, "max_total_risk_pct": 5.0, "trend_filter": False}
# Версия 3 (21.10.2026): новые сделки — только когда биткоин выше своей 50-дневной средней.
# Обоснование — README, «Обстановка на рынке», scripts/context_study.py.
STRATEGY_V3 = {"btc_filter": True, "btc_days": 50}
OLD_V3 = {"btc_filter": False, "btc_days": 50}
MIGRATIONS = (
    (2, STRATEGY_V2, OLD_DEFAULTS, "по итогам проверки всего счёта на истории 2022–2026"),
    (3, STRATEGY_V3, OLD_V3, "по итогам проверки обстановки на рынке на истории 2022–2026: "
                             "новые сделки — только когда биткоин выше 50-дневной средней"),
)


def btc_trend(daily: pd.DataFrame, days: int, bar: pd.Timestamp) -> dict:
    """Биткоин к своей средней за days дней — как btc_regime на свече bar: по последнему дню, закрытому к её началу."""
    close = daily["close"]
    avg = sma(close, days)
    known = close.index + pd.Timedelta(days=1) <= bar
    if not known.any() or pd.isna(avg[known].iloc[-1]):
        return {"ok": False, "days": days, "error": "мало истории по BTC"}
    c, a = float(close[known].iloc[-1]), float(avg[known].iloc[-1])
    return {"ok": c > a, "price": c, "avg": a, "days": days}


def check_settings(changes: dict, current: dict, extra_coins: list[str] = ()) -> dict:
    """Проверяет изменения настроек; возвращает их в нужных типах или бросает ValueError.

    extra_coins — монеты из COINS в .env, которых нет в стандартном списке: их тоже можно выбирать.
    """
    allowed = [*COINS, *(c for c in extra_coins if c not in COINS)]
    out = {}
    for key, value in changes.items():
        if key in LIMITS:
            kind, lo, hi = LIMITS[key]
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{LABELS[key]}: нужно число")
            if kind is int and value != int(value):
                raise ValueError(f"{LABELS[key]}: нужно целое число")
            if not lo <= value <= hi:
                raise ValueError(f"{LABELS[key]}: от {lo:g} до {hi:g}")
            out[key] = kind(value)
        elif key in FLAGS:
            if not isinstance(value, bool):
                raise ValueError(f"{LABELS[key]}: нужно да или нет")
            out[key] = value
        elif key == "coins":
            if not isinstance(value, list) or not all(isinstance(c, str) for c in value):
                raise ValueError("монеты: нужен список")
            wanted = {c.strip().upper() for c in value}
            unknown = wanted - set(allowed)
            if unknown:
                raise ValueError(f"неизвестные монеты: {', '.join(sorted(unknown))}")
            if not wanted:
                raise ValueError("выберите хотя бы одну монету")
            out[key] = [c for c in allowed if c in wanted]
        else:
            raise ValueError(f"настройку «{key}» менять нельзя")
    merged = {**current, **out}
    if merged["max_total_risk_pct"] < merged["risk_pct"]:
        raise ValueError("общий риск не может быть меньше риска на сделку")
    return out


CHART_INTERVALS = ("1m", "5m", "15m", "1h", "4h", "1d", "1w")
STABLES = {"USDT", "USDC", "FDUSD", "DAI", "USDE"}
MODE_NAMES = {"signals": "только сигналы", "confirm": "с подтверждением", "auto": "автоматически"}


def _show(value) -> str:
    if isinstance(value, bool):
        return "вкл" if value else "выкл"
    if isinstance(value, list):
        return f"{len(value)} шт."
    return f"{value:g}".replace(".", ",")


class Bot:
    def __init__(self, cfg: Config, exchange, store: Store, notifier: Notifier | None = None):
        self.cfg, self.ex, self.store = cfg, exchange, store
        self.notifier = notifier or LogNotifier()
        self.lock = threading.RLock()
        self.params = bt.Params(fast=cfg.ema_fast, slow=cfg.ema_slow, atr_mult=cfg.atr_mult, risk=cfg.risk_pct / 100)
        self.defaults = self.settings()  # значения из .env — к ним возвращает «Сбросить»
        self.btc: dict | None = (self.store.get("last_scan") or {}).get("btc")  # биткоин к своей средней
        self.report_extras: list = []  # строки для ежедневной сводки от других частей (демо-счета — у владельца)
        saved = self.store.get("settings", {})
        try:
            self._apply(check_settings(saved, self.defaults, self.defaults["coins"]))
        except ValueError as exc:  # границы могли измениться в новой версии — тогда работаем по .env
            log.warning("сохранённые настройки не применены: %s", exc)
        self._migrate_strategy()

    def _migrate_strategy(self) -> None:
        """Один раз переводит уже работающего бота на новую версию стратегии — только те настройки,
        которые владелец не менял (совпадают со старыми значениями по умолчанию)."""
        version = self.store.get("strategy_version", 1)
        for target, new, old, source in MIGRATIONS:
            if version >= target:
                continue
            self.store.set("strategy_version", target)
            if not self.store.get("last_bar"):
                continue  # новая установка — значения по умолчанию уже новые
            current = self.settings()
            changes = {k: v for k, v in new.items() if current[k] == old[k] and current[k] != v}
            if changes:
                self.update_settings(changes, source)

    # --- настройки -----------------------------------------------------------
    def settings(self) -> dict:
        return {k: (list(v) if isinstance(v := getattr(self.cfg, k), list) else v) for k in EDITABLE}

    def _apply(self, values: dict) -> None:
        for key, value in values.items():
            setattr(self.cfg, key, value)
        self.params = replace(self.params, risk=self.cfg.risk_pct / 100)

    def update_settings(self, changes: dict, source: str = "из приложения") -> str:
        with self.lock:
            before = self.settings()
            values = check_settings(changes, before, self.defaults["coins"])
            if self.cfg.account == "real" and self.enabled and values.get("capital_usdt", 1) <= 0:
                raise ValueError("на реальном счёте у включённого бота должен быть задан капитал — "
                                 "иначе он будет торговать всем балансом")
            self._apply(values)
            after = self.settings()
            self.store.set("settings", {k: v for k, v in after.items() if v != self.defaults[k]})
            diff = [f"{LABELS[k]}: {_show(before[k])} → {_show(after[k])}" for k in EDITABLE if before[k] != after[k]]
            if not diff:
                return "Без изменений"
            self.notify(f"⚙️ Настройки изменены {source}\n" + "\n".join(diff))
            return "Настройки сохранены"

    def reset_settings(self) -> str:
        return self.update_settings(dict(self.defaults))

    def watched_coins(self) -> list[str]:
        """Монеты из настроек плюс те, где открыта позиция: выход по сигналу работает всегда."""
        held = [p.coin for p in self.store.positions() if p.coin not in self.cfg.coins]
        return [*self.cfg.coins, *held]

    # --- состояние ---------------------------------------------------------
    @property
    def mode(self) -> str:
        return self.store.get("mode", self.cfg.mode)

    def set_mode(self, mode: str) -> None:
        self.store.set("mode", mode)
        self.store.log(f"режим: {mode}")

    @property
    def paused(self) -> str | None:
        return self.store.get("paused")

    def pause(self, reason: str) -> None:
        self.store.set("paused", reason)
        self.store.log(f"пауза: {reason}", "warn")

    def resume(self) -> None:
        self.store.set("paused", None)
        self.store.log("пауза снята")

    @property
    def enabled(self) -> bool:
        """Бот торгует на этом счёте. Выключенный не открывает сделок и не шлёт сигналов,
        но уже открытые позиции ведёт до конца: стоп и выход по тренду."""
        return self.store.get("enabled", self.cfg.bot_enabled)

    def set_enabled(self, on: bool) -> str:
        if on == self.enabled:
            return "Бот уже включён" if on else "Бот уже выключен"
        if on and self.cfg.account == "real" and self.cfg.capital_usdt <= 0:
            raise ValueError("сначала задайте капитал бота — сколько USDT он может использовать на реальном счёте")
        self.store.set("enabled", on)
        if not on:
            for p in self.store.pending_proposals():
                if self.store.claim_proposal(p.id, "rejected"):
                    self._edit(p, f"❌ {p.coin}: бот выключен")
        if on:
            cap = f", капитал {self.cfg.capital_usdt:,.0f} USDT" if self.cfg.capital_usdt > 0 else ""
            self.notify(f"▶️ Бот включён: режим «{MODE_NAMES[self.mode]}»{cap}.")
            return "Бот включён"
        n = len(self.store.positions())
        tail = f" Открытые позиции ({n}) веду до конца: стоп и выход по тренду." if n else ""
        self.notify("⏹ Бот выключен: новых сделок и сигналов не будет." + tail)
        return "Бот выключен"

    def notify(self, text: str, buttons=None) -> int | None:
        self.store.log(text)
        try:
            return self.notifier.send(text, buttons)
        except Exception:  # уведомление не должно ломать торговлю
            log.exception("notify failed")
            return None

    def symbol(self, coin: str) -> str:
        return f"{coin}USDT"

    # --- капитал и риск ------------------------------------------------------
    def equity(self) -> dict:
        usdt = self.ex.balance("USDT")
        positions = self.store.positions()
        prices = {p.coin: self.ex.last_price(p.symbol) for p in positions}
        invested = sum(p.qty * prices[p.coin] for p in positions)
        unrealized = sum((prices[p.coin] - p.entry) * p.qty for p in positions)
        if self.cfg.capital_usdt > 0:
            total = self.cfg.capital_usdt + self.store.realized_since(0) + unrealized
            free = min(usdt, max(0.0, total - invested))
        else:
            total, free = usdt + invested, usdt
        return {"total": total, "free": free, "usdt": usdt, "invested": invested,
                "unrealized": unrealized, "prices": prices}

    def plan(self, coin: str, price: float, stop: float) -> tuple[Plan | None, str]:
        dist = price - stop
        if dist <= 0:
            return None, "цена ниже стопа"
        positions = self.store.positions()
        if len(positions) >= self.cfg.max_positions:
            return None, f"уже {len(positions)} позиций (лимит {self.cfg.max_positions})"
        eq = self.equity()
        open_risk = sum(max(0.0, (p.entry - p.stop) * p.qty) for p in positions)
        risk = min(eq["total"] * self.cfg.risk_pct / 100,
                   eq["total"] * self.cfg.max_total_risk_pct / 100 - open_risk)
        if risk <= 0:
            return None, "исчерпан лимит общего риска"
        qty = min(risk / dist,
                  eq["total"] * self.cfg.max_position_pct / 100 / price,
                  eq["free"] * 0.995 / price)  # запас на комиссию и движение цены
        inst = self.ex.instrument(self.symbol(coin))
        q = inst.floor_qty(qty)
        if q <= 0 or q * Decimal(str(price)) < inst.min_amount:
            return None, f"сумма меньше минимальной ({inst.min_amount} USDT), свободно {eq['free']:.2f} USDT"
        return Plan(q, price, stop, float(q) * dist), ""

    def daily_loss_hit(self) -> bool:
        day_start = int(pd.Timestamp.now(tz="UTC").normalize().timestamp())
        eq = self.equity()
        loss = self.store.realized_since(day_start) + min(0.0, eq["unrealized"])
        return loss <= -eq["total"] * self.cfg.daily_loss_limit_pct / 100

    # --- сигналы -------------------------------------------------------------
    def scan(self) -> dict[str, dict]:
        regime_src, self.btc = None, None
        if self.cfg.btc_filter:
            try:
                regime_src = self.ex.candles("BTCUSDT", "1d", 400)
            except Exception as exc:  # без биткоина не понять обстановку — новые входы пропускаем
                log.warning("scan BTC 1d: %s", exc)
                self.btc = {"ok": False, "days": self.cfg.btc_days, "error": f"нет данных по BTC ({exc})"}
        out = {}
        for coin in self.watched_coins():
            try:
                df = self.ex.candles(self.symbol(coin), "4h", 1000)
                regime = (btc_regime(regime_src, df.index, self.cfg.btc_days) if regime_src is not None
                          else pd.Series(False, index=df.index) if self.btc else None)
                data = bt.prepare(df, self.params, regime)
                last = data.iloc[-1]
                lookback = self.cfg.trend_days * 6  # 4ч свечей в сутках
                momentum = (float(last["close"] / data["close"].iloc[-1 - lookback] - 1)
                            if len(data) > lookback else None)
                out[coin] = {
                    "bar": int(data.index[-1].timestamp()), "price": float(last["close"]),
                    "atr": float(last["atr"]), "ema_fast": float(last["ema_fast"]), "ema_slow": float(last["ema_slow"]),
                    "cross_up": bool(last["cross_up"]), "trend_down": bool(last["trend_down"]),
                    "regime_ok": bool(last["regime_ok"]),
                    "momentum": momentum,
                    # без истории на всё окно монета не проходит фильтр: силу роста не проверить
                    "trend_ok": not self.cfg.trend_filter or (momentum is not None and momentum > 0),
                }
            except Exception as exc:
                log.warning("scan %s: %s", coin, exc)
                out[coin] = {"error": str(exc)}
        bars = [s["bar"] for s in out.values() if "bar" in s]
        if regime_src is not None and bars:
            self.btc = btc_trend(regime_src, self.cfg.btc_days, pd.Timestamp(max(bars), unit="s", tz="UTC"))
        return out

    def report_btc(self) -> None:
        """Сообщает, когда биткоин пересёк свою среднюю: бот сам ставит новые входы на паузу и снимает её."""
        b = self.btc
        prev = self.store.get("btc_ok")
        ok = None if b is None else b["ok"]
        self.store.set("btc_ok", ok)
        if ok is None or ok == prev or (prev is None and ok):
            return
        if ok:
            self.notify(f"🟢 Биткоин снова выше {b['days']}-дневной средней ({fmt(b['price'])} > {fmt(b['avg'])}): "
                        "рынок выправился, новые входы разрешены.")
        elif "error" in b:
            self.notify(f"⚠️ Новые входы на паузе: {b['error']}.")
        else:
            self.notify(f"🔴 Биткоин ниже {b['days']}-дневной средней ({fmt(b['price'])} < {fmt(b['avg'])}): "
                        "рынок в целом падает, ложных входов в такое время больше. Новые сделки на паузе, "
                        "открытые веду как обычно — стоп и выход по тренду.")

    def on_candle_close(self) -> None:
        """Обрабатывает последнюю закрытую 4ч свечу (один раз на свечу)."""
        with self.lock:
            signals = self.scan()
            bars = [s["bar"] for s in signals.values() if "bar" in s]
            if not bars:
                self.notify("⚠️ Не удалось загрузить свечи ни по одной монете")
                return
            bar = max(bars)
            self.store.set("signals", signals)
            if self.store.get("last_bar", 0) >= bar:
                return
            self.store.set("last_bar", bar)

            exits = [p.coin for p in self.store.positions() if signals.get(p.coin, {}).get("trend_down")]
            for coin in exits:
                self.close(coin, "signal")

            self.expire_proposals()
            if not self.enabled:  # выключенный бот только ведёт открытые позиции
                self.record_equity()
                self.record_scan(signals, bar, [], exits)
                return
            if self.mode != "signals" and not self.paused and self.daily_loss_hit():
                self.pause("дневной лимит убытка")
                self.notify(f"⛔ Дневной убыток достиг {self.cfg.daily_loss_limit_pct}% — новые сделки на паузе. "
                            "Снять: /resume")
            self.report_btc()
            entries = [(c, s) for c, s in signals.items()
                       if c in self.cfg.coins and s.get("cross_up") and s.get("regime_ok") and s.get("trend_ok", True)]
            held_back = [c for c, s in signals.items()
                         if c in self.cfg.coins and s.get("cross_up") and s.get("trend_ok", True) and not s.get("regime_ok")
                         and not self.store.position(c)]
            if held_back:
                self.notify(f"⏸ Сигнал на вход: {', '.join(held_back)} — пропускаю: {self.btc_reason()}.")
            for coin, s in entries:
                self.handle_entry_signal(coin, s)
            self.record_equity()
            self.record_scan(signals, bar, [c for c, _ in entries], exits, held_back)

    def btc_reason(self) -> str:
        b = self.btc or {}
        if "error" in b:
            return b["error"]
        return f"биткоин ниже {b.get('days', self.cfg.btc_days)}-дневной средней, рынок в целом падает"

    def entry_reason(self, s: dict) -> str:
        """Почему бот входит — коротко, для сообщения о сделке."""
        why = [f"EMA {self.cfg.ema_fast} пересекла EMA {self.cfg.ema_slow} снизу вверх"]
        if self.cfg.trend_filter and s.get("momentum") is not None:
            why.append(f"монета за {self.cfg.trend_days} дн. {s['momentum'] * 100:+.0f}%")
        if self.btc and self.btc.get("ok"):
            why.append(f"биткоин выше {self.btc['days']}-дневной средней")
        return "Почему: " + ", ".join(why) + "."

    def record_scan(self, signals: dict, bar: int, entries: list[str], exits: list[str],
                    held_back: list[str] = ()) -> None:
        """Итог проверки рынка — чтобы было видно, что бот работает, даже когда сделок нет."""
        ok = {c: s for c, s in signals.items() if c in self.cfg.coins and not s.get("error")}
        up = sum(1 for s in ok.values() if not s.get("trend_down"))
        scan = {"ts": now(), "bar": bar, "coins": len(ok), "up": up, "entries": entries, "exits": exits,
                "held_back": list(held_back), "btc": self.btc}
        self.store.set("last_scan", scan)
        found = f"вход: {', '.join(entries)}" if entries else "сигналов на вход нет"
        if held_back:
            found += f"; пропущено из-за BTC: {', '.join(held_back)}"
        if exits:
            found += f"; выход: {', '.join(exits)}"
        self.store.log(f"🔎 Проверка рынка: {len(ok)} монет, в росте {up}, {found}")

    # --- портфель: весь счёт, а не только часть бота ---------------------------
    def portfolio(self) -> dict:
        positions = {p.coin: p for p in self.store.positions()}
        assets = []
        for coin, h in self.ex.holdings().items():
            qty = h["qty"]
            if qty <= 0:
                continue
            if coin in STABLES:
                price = 1.0
            elif h.get("usd"):
                price = h["usd"] / qty
            else:
                try:
                    price = self.ex.last_price(self.symbol(coin))
                except Exception:  # монета без пары к USDT — покажем количество без цены
                    price = None
            value = qty * price if price is not None else None
            if value is not None and value < 0.01:
                continue  # пыль после сделок
            bot_qty = min(qty, positions[coin].qty) if coin in positions else 0.0
            assets.append({"coin": coin, "qty": qty, "price": price, "value": value, "bot_qty": bot_qty,
                           "stable": coin in STABLES})
        assets.sort(key=lambda a: -(a["value"] or 0))
        total = sum(a["value"] or 0 for a in assets)
        eq = self.equity()
        return {"total": total, "assets": assets, "updated_at": now(),
                "bot": {"capital": eq["total"], "invested": eq["invested"], "free": eq["free"]}}

    # --- капитал во времени и ежедневный отчёт ---------------------------------
    def record_equity(self) -> None:
        """Точка для графика капитала: после каждой 4ч свечи и при запуске."""
        try:
            self.store.add_equity(now(), round(self.equity()["total"], 2))
        except Exception:
            log.exception("record_equity")

    def daily_report_text(self) -> str:
        eq = self.equity()
        ts = now()
        day_ago = self.store.equity_before(ts - 86400)
        change = f" ({eq['total'] - day_ago:+,.2f} за сутки)" if day_ago is not None else ""
        lines = ["📊 Сводка за сутки", f"Капитал: {eq['total']:,.2f} USDT{change}"]
        closed = [t for t in self.store.trades(50) if t["closed_at"] >= ts - 86400]
        if closed:
            total = sum(t["pnl_usdt"] for t in closed)
            lines.append(f"Закрыто сделок: {len(closed)}, итог {total:+,.2f} USDT")
        positions = self.store.positions()
        if positions:
            lines.append(f"Открыто позиций: {len(positions)}")
            for p in positions:
                price = eq["prices"][p.coin]
                lines.append(f"  • {p.coin}: {(price - p.entry) * p.qty:+,.2f} USDT ({(price / p.entry - 1) * 100:+.1f}%), "
                             f"до стопа {(1 - p.stop / price) * 100:.1f}%")
        else:
            lines.append("Открытых позиций нет")
        signals = self.store.get("signals", {})
        ups = sum(1 for c, s in signals.items() if c in self.cfg.coins and not s.get("error") and not s.get("trend_down"))
        lines.append(f"Монет в росте: {ups} из {len(self.cfg.coins)}")
        b = (self.store.get("last_scan") or {}).get("btc")
        if b and "error" not in b:
            lines.append(f"Биткоин {'выше' if b['ok'] else 'ниже'} {b['days']}-дневной средней — "
                         f"{'новые входы разрешены' if b['ok'] else 'новые входы на паузе'}")
        state = "выключен" if not self.enabled else f"пауза ({self.paused})" if self.paused else "работает"
        lines.append(f"Режим: {MODE_NAMES.get(self.mode, self.mode)}, бот {state}")
        for extra in self.report_extras:
            try:
                line = extra()
            except Exception:
                log.exception("строка сводки")
                continue
            if line:
                lines.append(line)
        return "\n".join(lines)

    def maybe_daily_report(self, ts: float | None = None) -> bool:
        """Раз в сутки в выбранный час присылает сводку. Возвращает True, если отправил."""
        ts = time.time() if ts is None else ts
        day, hour = time.strftime("%Y-%m-%d", time.gmtime(ts)), time.gmtime(ts).tm_hour
        if not self.cfg.daily_report or hour != self.cfg.report_hour_utc or self.store.get("report_day") == day:
            return False
        if not self.enabled and not self.store.positions():
            return False  # бот выключен и ничего не ведёт — сводка не нужна
        self.store.set("report_day", day)
        try:
            self.notifier.send(self.daily_report_text())  # в журнал событий сводку не пишем
        except Exception:
            log.exception("daily report")
        return True

    def handle_entry_signal(self, coin: str, s: dict) -> None:
        price, stop = s["price"], s["price"] - self.cfg.atr_mult * s["atr"]
        reason = self.entry_reason(s)
        head = f"📈 ВХОД {coin} ~{fmt(price)}, стоп {fmt(stop)} (−{(1 - stop / price) * 100:.1f}%)\n{reason}"
        if self.mode == "signals":
            self.notify(head + "\nРежим «только сигналы» — сделку не открываю.")
            return
        if self.store.position(coin):
            return
        if any(p.coin == coin for p in self.store.pending_proposals()):
            return
        if self.paused:
            self.notify(f"{head}\nБот на паузе ({self.paused}) — пропускаю.")
            return
        plan, why = self.plan(coin, price, stop)
        if plan is None:
            self.notify(f"{head}\nНе открываю: {why}.")
            return
        if self.mode == "auto":
            self.open(coin, stop, ref_price=price, reason=reason)
            return
        prop = Proposal(id=uuid.uuid4().hex[:12], coin=coin, symbol=self.symbol(coin), price=price, stop=stop,
                        qty=float(plan.qty), risk_usdt=plan.risk_usdt, created_at=now(),
                        expires_at=now() + self.cfg.proposal_ttl_min * 60)
        self.store.save_proposal(prop)
        text = (f"{head}\nКупить {plan.qty} {coin} ≈ {float(plan.qty) * price:,.2f} USDT, "
                f"риск {plan.risk_usdt:,.2f} USDT.\nПредложение действует {self.cfg.proposal_ttl_min} мин.")
        prop.message_id = self.notify(text, [[("✅ Купить", f"buy:{prop.id}"), ("❌ Пропустить", f"skip:{prop.id}")]])
        self.store.save_proposal(prop)

    def expire_proposals(self) -> None:
        for p in self.store.pending_proposals():
            if p.expires_at <= now() and self.store.claim_proposal(p.id, "expired"):
                self._edit(p, f"⌛ Предложение по {p.coin} истекло")

    def _edit(self, p: Proposal, text: str, log_event: bool = True) -> None:
        if p.message_id:
            try:
                self.notifier.edit(p.message_id, text)
            except Exception:
                log.exception("edit failed")
        if log_event:
            self.store.log(text)

    def confirm(self, pid: str) -> str:
        with self.lock:
            p = self.store.proposal(pid)
            if p is None:
                return "Предложение не найдено"
            if p.expires_at <= now():
                if self.store.claim_proposal(pid, "expired"):
                    self._edit(p, f"⌛ Предложение по {p.coin} истекло")
                return "Предложение истекло"
            if not self.store.claim_proposal(pid, "confirmed"):
                return f"Уже обработано: {p.status}"
            if not self.enabled:
                self.store.set_proposal_status(pid, "failed")
                return "Бот выключен"
            if self.paused:
                self.store.set_proposal_status(pid, "failed")
                return f"Бот на паузе: {self.paused}"
            result = self.open(p.coin, p.stop, ref_price=p.price)
            self.store.set_proposal_status(pid, "confirmed" if result.startswith("✅") else "failed")
            self._edit(p, result, log_event=not result.startswith("✅"))  # успешную покупку уже записал open()
            return result

    def reject(self, pid: str) -> str:
        p = self.store.proposal(pid)
        if p and self.store.claim_proposal(pid, "rejected"):
            self._edit(p, f"❌ {p.coin}: пропущено")
            return "Пропущено"
        return "Уже обработано"

    # --- исполнение ------------------------------------------------------------
    def open(self, coin: str, stop: float, ref_price: float, reason: str = "") -> str:
        with self.lock:
            if self.store.position(coin):
                return f"По {coin} уже есть позиция"
            sym = self.symbol(coin)
            price = self.ex.last_price(sym)
            if price <= stop * 1.002:
                return f"❗ {coin}: цена {fmt(price)} уже у стопа {fmt(stop)} — не покупаю"
            if price > ref_price + 0.5 * (ref_price - stop):
                return f"❗ {coin}: цена ушла вверх до {fmt(price)} (сигнал {fmt(ref_price)}) — не догоняю"
            plan, why = self.plan(coin, price, stop)
            if plan is None:
                return f"❗ {coin}: {why}"
            inst = self.ex.instrument(sym)
            try:
                fill = self.ex.market_buy(sym, coin, plan.qty)
            except Exception as exc:
                self.store.log(f"покупка {coin} не прошла: {exc}", "error")
                return f"❗ {coin}: покупка не прошла: {exc}"

            qty = inst.floor_qty(min(fill.qty, self.ex.balance(coin)))
            trigger = inst.stop_price(stop)
            try:
                stop_id = self.ex.place_stop(sym, qty, trigger)
            except Exception as exc:
                # без стопа позицию не держим
                self.store.log(f"стоп {coin} не поставился: {exc}", "error")
                try:
                    sell = self.ex.market_sell(sym, qty)
                    return (f"❗ {coin}: стоп не поставился ({exc}), позицию сразу продал по {fmt(sell.avg_price)}")
                except Exception as exc2:
                    self.pause(f"{coin} без стопа")
                    return (f"🆘 {coin}: куплено {qty}, но стоп не поставился ({exc}) и продать не удалось ({exc2}). "
                            "Бот на паузе — поставьте стоп вручную в приложении Bybit!")
            pos = Position(coin, sym, float(qty), fill.avg_price, float(trigger), stop_id, now(), fill.order_id,
                           (fill.avg_price - float(trigger)) * float(qty))
            self.store.save_position(pos)
            text = (f"✅ Куплено {qty} {coin} по {fmt(fill.avg_price)} (≈{float(qty) * fill.avg_price:,.2f} USDT). "
                    f"Стоп {fmt(float(trigger))}, риск {pos.risk_usdt:,.2f} USDT" + (f"\n{reason}" if reason else ""))
            if self.mode == "auto":
                self.notify(text)  # notify() сам пишет событие
            else:
                self.store.log(text)
            return text

    def close(self, coin: str, reason: str) -> str:
        with self.lock:
            p = self.store.position(coin)
            if p is None:
                return f"Позиции по {coin} нет"
            inst = self.ex.instrument(p.symbol)
            self.ex.cancel_stop(p.symbol, p.stop_order_id)
            state, stop_fill = self.ex.stop_state(p.symbol, p.stop_order_id)
            if state == "filled":  # стоп успел сработать до отмены
                return self._closed(p, stop_fill.avg_price, "stop", stop_fill.fee_usdt)
            qty = inst.floor_qty(min(p.qty, self.ex.balance(coin)))
            price = self.ex.last_price(p.symbol)
            if qty * Decimal(str(price)) < inst.min_amount:
                self.store.close_position(p, price, f"{reason}/остаток")
                msg = f"ℹ️ {coin}: остаток {qty} меньше минимальной суммы ордера — позицию снял с учёта"
                self.notify(msg)
                return msg
            try:
                fill = self.ex.market_sell(p.symbol, qty)
            except Exception as exc:
                # продать не вышло — возвращаем стоп, чтобы позиция не осталась без защиты
                p.stop_order_id = self.ex.place_stop(p.symbol, qty, inst.stop_price(p.stop))
                self.store.save_position(p)
                msg = f"❗ {coin}: продажа не прошла ({exc}). Стоп восстановлен."
                self.notify(msg)
                return msg
            return self._closed(p, fill.avg_price, reason, fill.fee_usdt)

    def _closed(self, p: Position, exit_price: float, reason: str, fee: float) -> str:
        res = self.store.close_position(p, exit_price, reason, fee)
        label = {"signal": "выход по сигналу", "stop": "сработал стоп", "manual": "закрыто вручную"}.get(reason, reason)
        r = f", {res['r']:+.2f}R" if res["r"] is not None else ""
        icon = "🟢" if res["pnl"] >= 0 else "🔴"
        text = f"{icon} {p.coin}: {label} по {fmt(exit_price)}. Итог {res['pnl']:+,.2f} USDT{r}"
        self.notify(text)
        return text

    # --- ручная торговля, как на бирже: эти монеты бот не ведёт и не продаёт --------
    def tradable_coins(self) -> list[str]:
        return [*COINS, *(c for c in self.defaults["coins"] if c not in COINS)]

    def manual_order(self, coin: str, side: str, usdt: float | None = None, qty: float | None = None) -> str:
        """Рыночная покупка или продажа на споте по сумме в USDT или количеству монеты.
        Продать можно только своё — то, что держит бот, он продаёт сам (или «Закрыть позицию»)."""
        coin = coin.upper()
        if coin not in self.tradable_coins():
            raise ValueError(f"монета {coin} не поддерживается")
        if side not in ("buy", "sell"):
            raise ValueError("сторона: buy или sell")
        if (usdt is None) == (qty is None):
            raise ValueError("укажите сумму в USDT или количество монеты")
        amount = usdt if usdt is not None else qty
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount <= 0:
            raise ValueError("сумма должна быть больше нуля")
        with self.lock:
            sym = self.symbol(coin)
            inst = self.ex.instrument(sym)
            price = self.ex.last_price(sym)
            want = Decimal(str(qty)) if qty is not None else Decimal(str(usdt / price))
            if side == "buy":
                free = self.ex.balance("USDT")
                want = min(want, Decimal(str(free * 0.995 / price)))  # запас на комиссию и движение цены
            else:
                bot = self.store.position(coin)
                mine = self.ex.balance(coin) - (bot.qty if bot else 0.0)
                if mine <= 0:
                    raise ValueError(f"своих {coin} на счёте нет" + (" — эту монету держит бот" if bot else ""))
                want = min(want, Decimal(str(mine)))
            q = inst.floor_qty(float(want))
            if q <= 0 or q * Decimal(str(price)) < inst.min_amount:
                raise ValueError(f"сумма меньше минимальной для ордера: {inst.min_amount} USDT")
            fill = self.ex.market_buy(sym, coin, q) if side == "buy" else self.ex.market_sell(sym, q)
            self.store.add_order(coin, side, fill.qty, fill.avg_price, fill.order_id)
            word = "Куплено" if side == "buy" else "Продано"
            text = f"{'🛒' if side == 'buy' else '💵'} {word} {fill.qty:g} {coin} по {fmt(fill.avg_price)} " \
                   f"(≈{fill.qty * fill.avg_price:,.2f} USDT) — вручную, бот эту сделку не ведёт"
            self.store.log(text)
            return text

    def close_all(self, reason: str = "manual") -> list[str]:
        return [self.close(p.coin, reason) for p in self.store.positions()]

    def reconcile(self) -> None:
        """Раз в минуту: сработавшие стопы, позиции, закрытые вручную, истёкшие предложения."""
        with self.lock:
            self.expire_proposals()
            for p in self.store.positions():
                try:
                    state, fill = self.ex.stop_state(p.symbol, p.stop_order_id)
                except Exception as exc:
                    log.warning("stop_state %s: %s", p.coin, exc)
                    continue
                if state == "filled":
                    self._closed(p, fill.avg_price, "stop", fill.fee_usdt)
                elif state == "gone":
                    inst = self.ex.instrument(p.symbol)
                    bal = self.ex.balance(p.coin)
                    price = self.ex.last_price(p.symbol)
                    if Decimal(str(min(bal, p.qty) * price)) < inst.min_amount:
                        self._closed(p, price, "manual", 0.0)
                    else:
                        qty = inst.floor_qty(min(bal, p.qty))
                        p.qty = float(qty)
                        p.stop_order_id = self.ex.place_stop(p.symbol, qty, inst.stop_price(p.stop))
                        self.store.save_position(p)
                        self.notify(f"⚠️ {p.coin}: стоп-ордер пропал — поставил заново на {fmt(p.stop)}")

    # --- отчёты ----------------------------------------------------------------
    def chart(self, coin: str, interval: str = "4h", bars: int = 300) -> dict:
        """Свечи с EMA для графика в мини-приложении. Решения бот принимает только по 4ч;
        на других таймфреймах EMA считаются по их свечам — для обзора."""
        if interval not in CHART_INTERVALS:
            raise ValueError(f"interval: {', '.join(CHART_INTERVALS)}")
        df = self.ex.candles(self.symbol(coin), interval, 1000)
        data = bt.prepare(df, self.params).iloc[-bars:]
        nan_to_none = lambda col: [None if pd.isna(v) else round(float(v), 10) for v in data[col]]  # noqa: E731
        p = self.store.position(coin)
        return {
            "coin": coin,
            "interval": interval,
            "time": [int(t.timestamp()) for t in data.index],
            **{k: nan_to_none(k) for k in ("open", "high", "low", "close", "ema_fast", "ema_slow", "atr")},
            "position": p.__dict__ if p else None,
        }

    def trades(self, coin: str) -> dict:
        """Последние сделки рынка — начало секундного графика, дальше он идёт по потоку биржи."""
        try:
            trades = self.ex.recent_trades(self.symbol(coin))
        except Exception as exc:  # без истории график просто начнётся с текущей секунды
            log.warning("recent trades %s: %s", coin, exc)
            trades = []
        return {"coin": coin, "trades": trades}

    def status(self) -> dict:
        eq = self.equity()
        positions = []
        for p in self.store.positions():
            price = eq["prices"][p.coin]
            positions.append({"coin": p.coin, "qty": p.qty, "entry": p.entry, "stop": p.stop, "price": price,
                              "pnl_usdt": (price - p.entry) * p.qty, "opened_at": p.opened_at})
        return {
            "env": self.cfg.env, "mode": self.mode, "paused": self.paused, "account": self.cfg.account,
            "enabled": self.enabled,
            "equity": {k: v for k, v in eq.items() if k != "prices"},
            "positions": positions,
            "proposals": [p.__dict__ for p in self.store.pending_proposals()],
            "signals": self.store.get("signals", {}),
            "last_bar": self.store.get("last_bar", 0),
            "trades": self.store.trades(30),
            "events": self.store.events(30),
            "settings": {**self.settings(), "atr_mult": self.cfg.atr_mult,
                         "ema_fast": self.cfg.ema_fast, "ema_slow": self.cfg.ema_slow},
            "settings_defaults": self.defaults,
            "paper_start_usdt": self.cfg.paper_start_usdt,
            "settings_limits": {k: {"min": lo, "max": hi} for k, (_, lo, hi) in LIMITS.items()},
            "all_coins": self.tradable_coins(),
            "orders": self.store.orders(50),
            "equity_history": self.store.equity_history(now() - 90 * 86400),
            "last_scan": self.store.get("last_scan"),
        }


def next_bar_close(ts: float | None = None, delay: int = 20) -> float:
    """Ближайший момент закрытия 4ч свечи (00/04/08/12/16/20 UTC) плюс задержка."""
    ts = time.time() if ts is None else ts
    return (int(ts - delay) // BAR_SECONDS + 1) * BAR_SECONDS + delay
