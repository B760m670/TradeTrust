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
from ..indicators import btc_regime
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
    "max_positions": (int, 1, 10),
    "max_position_pct": (float, 5.0, 50.0),
    "max_total_risk_pct": (float, 1.0, 10.0),
    "daily_loss_limit_pct": (float, 1.0, 10.0),
    "capital_usdt": (float, 0.0, 10_000_000.0),
    "proposal_ttl_min": (int, 15, 240),
    "report_hour_utc": (int, 0, 23),
}
FLAGS = ("btc_filter", "daily_report")
EDITABLE = (*LIMITS, *FLAGS, "coins")
LABELS = {
    "risk_pct": "риск на сделку, %", "max_positions": "позиций максимум", "max_position_pct": "в одной монете, %",
    "max_total_risk_pct": "общий риск, %", "daily_loss_limit_pct": "дневной лимит убытка, %",
    "capital_usdt": "капитал бота, USDT", "proposal_ttl_min": "предложение действует, мин",
    "btc_filter": "фильтр BTC", "coins": "монеты",
    "daily_report": "ежедневный отчёт", "report_hour_utc": "время отчёта (UTC), ч",
}


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
        saved = self.store.get("settings", {})
        try:
            self._apply(check_settings(saved, self.defaults, self.defaults["coins"]))
        except ValueError as exc:  # границы могли измениться в новой версии — тогда работаем по .env
            log.warning("сохранённые настройки не применены: %s", exc)

    # --- настройки -----------------------------------------------------------
    def settings(self) -> dict:
        return {k: (list(v) if isinstance(v := getattr(self.cfg, k), list) else v) for k in EDITABLE}

    def _apply(self, values: dict) -> None:
        for key, value in values.items():
            setattr(self.cfg, key, value)
        self.params = replace(self.params, risk=self.cfg.risk_pct / 100)

    def update_settings(self, changes: dict) -> str:
        with self.lock:
            before = self.settings()
            values = check_settings(changes, before, self.defaults["coins"])
            self._apply(values)
            after = self.settings()
            self.store.set("settings", {k: v for k, v in after.items() if v != self.defaults[k]})
            diff = [f"{LABELS[k]}: {_show(before[k])} → {_show(after[k])}" for k in EDITABLE if before[k] != after[k]]
            if not diff:
                return "Без изменений"
            self.notify("⚙️ Настройки изменены из приложения\n" + "\n".join(diff))
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
        regime_src = self.ex.candles("BTCUSDT", "1d", 400) if self.cfg.btc_filter else None
        out = {}
        for coin in self.watched_coins():
            try:
                df = self.ex.candles(self.symbol(coin), "4h", 1000)
                regime = btc_regime(regime_src, df.index) if regime_src is not None else None
                data = bt.prepare(df, self.params, regime)
                last = data.iloc[-1]
                out[coin] = {
                    "bar": int(data.index[-1].timestamp()), "price": float(last["close"]),
                    "atr": float(last["atr"]), "ema_fast": float(last["ema_fast"]), "ema_slow": float(last["ema_slow"]),
                    "cross_up": bool(last["cross_up"]), "trend_down": bool(last["trend_down"]),
                    "regime_ok": bool(last["regime_ok"]),
                }
            except Exception as exc:
                log.warning("scan %s: %s", coin, exc)
                out[coin] = {"error": str(exc)}
        return out

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
            if self.mode != "signals" and not self.paused and self.daily_loss_hit():
                self.pause("дневной лимит убытка")
                self.notify(f"⛔ Дневной убыток достиг {self.cfg.daily_loss_limit_pct}% — новые сделки на паузе. "
                            "Снять: /resume")
            entries = [(c, s) for c, s in signals.items()
                       if c in self.cfg.coins and s.get("cross_up") and s.get("regime_ok")]
            for coin, s in entries:
                self.handle_entry_signal(coin, s)
            self.record_equity()
            self.record_scan(signals, bar, [c for c, _ in entries], exits)

    def record_scan(self, signals: dict, bar: int, entries: list[str], exits: list[str]) -> None:
        """Итог проверки рынка — чтобы было видно, что бот работает, даже когда сделок нет."""
        ok = {c: s for c, s in signals.items() if c in self.cfg.coins and not s.get("error")}
        up = sum(1 for s in ok.values() if not s.get("trend_down"))
        scan = {"ts": now(), "bar": bar, "coins": len(ok), "up": up, "entries": entries, "exits": exits}
        self.store.set("last_scan", scan)
        found = f"вход: {', '.join(entries)}" if entries else "сигналов на вход нет"
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
        state = f"пауза ({self.paused})" if self.paused else "работает"
        lines.append(f"Режим: {MODE_NAMES.get(self.mode, self.mode)}, бот {state}")
        return "\n".join(lines)

    def maybe_daily_report(self, ts: float | None = None) -> bool:
        """Раз в сутки в выбранный час присылает сводку. Возвращает True, если отправил."""
        ts = time.time() if ts is None else ts
        day, hour = time.strftime("%Y-%m-%d", time.gmtime(ts)), time.gmtime(ts).tm_hour
        if not self.cfg.daily_report or hour != self.cfg.report_hour_utc or self.store.get("report_day") == day:
            return False
        self.store.set("report_day", day)
        try:
            self.notifier.send(self.daily_report_text())  # в журнал событий сводку не пишем
        except Exception:
            log.exception("daily report")
        return True

    def handle_entry_signal(self, coin: str, s: dict) -> None:
        price, stop = s["price"], s["price"] - self.cfg.atr_mult * s["atr"]
        head = f"📈 ВХОД {coin} ~{fmt(price)}, стоп {fmt(stop)} (−{(1 - stop / price) * 100:.1f}%)"
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
            self.open(coin, stop, ref_price=price)
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
    def open(self, coin: str, stop: float, ref_price: float) -> str:
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
                    f"Стоп {fmt(float(trigger))}, риск {pos.risk_usdt:,.2f} USDT")
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

    def status(self) -> dict:
        eq = self.equity()
        positions = []
        for p in self.store.positions():
            price = eq["prices"][p.coin]
            positions.append({"coin": p.coin, "qty": p.qty, "entry": p.entry, "stop": p.stop, "price": price,
                              "pnl_usdt": (price - p.entry) * p.qty, "opened_at": p.opened_at})
        return {
            "env": self.cfg.env, "mode": self.mode, "paused": self.paused,
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
            "settings_limits": {k: {"min": lo, "max": hi} for k, (_, lo, hi) in LIMITS.items()},
            "all_coins": [*COINS, *(c for c in self.defaults["coins"] if c not in COINS)],
            "equity_history": self.store.equity_history(now() - 90 * 86400),
            "last_scan": self.store.get("last_scan"),
        }


def next_bar_close(ts: float | None = None, delay: int = 20) -> float:
    """Ближайший момент закрытия 4ч свечи (00/04/08/12/16/20 UTC) плюс задержка."""
    ts = time.time() if ts is None else ts
    return (int(ts - delay) // BAR_SECONDS + 1) * BAR_SECONDS + delay
