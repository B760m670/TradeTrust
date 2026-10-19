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
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

import pandas as pd

from .. import backtest as bt
from ..indicators import btc_regime
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


class Bot:
    def __init__(self, cfg: Config, exchange, store: Store, notifier: Notifier | None = None):
        self.cfg, self.ex, self.store = cfg, exchange, store
        self.notifier = notifier or LogNotifier()
        self.lock = threading.RLock()
        self.params = bt.Params(fast=cfg.ema_fast, slow=cfg.ema_slow, atr_mult=cfg.atr_mult, risk=cfg.risk_pct / 100)

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
        for coin in self.cfg.coins:
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

            for p in self.store.positions():
                s = signals.get(p.coin, {})
                if s.get("trend_down"):
                    self.close(p.coin, "signal")

            self.expire_proposals()
            if self.mode != "signals" and not self.paused and self.daily_loss_hit():
                self.pause("дневной лимит убытка")
                self.notify(f"⛔ Дневной убыток достиг {self.cfg.daily_loss_limit_pct}% — новые сделки на паузе. "
                            "Снять: /resume")
            entries = [(c, s) for c, s in signals.items() if s.get("cross_up") and s.get("regime_ok")]
            for coin, s in entries:
                self.handle_entry_signal(coin, s)

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

    def _edit(self, p: Proposal, text: str) -> None:
        if p.message_id:
            try:
                self.notifier.edit(p.message_id, text)
            except Exception:
                log.exception("edit failed")
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
            self._edit(p, result)
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
            self.store.log(text)
            if self.mode == "auto":
                self.notify(text)
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
            "settings": {"risk_pct": self.cfg.risk_pct, "atr_mult": self.cfg.atr_mult, "ema_fast": self.cfg.ema_fast,
                         "ema_slow": self.cfg.ema_slow, "btc_filter": self.cfg.btc_filter,
                         "capital_usdt": self.cfg.capital_usdt, "max_positions": self.cfg.max_positions,
                         "coins": self.cfg.coins},
        }


def next_bar_close(ts: float | None = None, delay: int = 20) -> float:
    """Ближайший момент закрытия 4ч свечи (00/04/08/12/16/20 UTC) плюс задержка."""
    ts = time.time() if ts is None else ts
    return (int(ts - delay) // BAR_SECONDS + 1) * BAR_SECONDS + delay
