"""Бумажная торговля: реальные цены Bybit, виртуальный баланс, без ключей API.

Нужна, чтобы проверить сервер, Telegram и приложение до подключения счёта.
Стоп проверяется раз в минуту по последней цене, поэтому короткий прокол ниже стопа
может быть пропущен — на бирже настоящий стоп-ордер сработал бы точнее.
"""
from __future__ import annotations

import uuid
from decimal import Decimal

from .bybit import Fill, Instrument
from .store import Store

FEE = 0.001
SLIPPAGE = 0.0005


class PaperExchange:
    def __init__(self, market, store: Store, start_usdt: float = 1000.0):
        self.market, self.store = market, store
        if self.store.get("paper_balances") is None:
            self.store.set("paper_balances", {"USDT": start_usdt})
            self.store.set("paper_stops", {})

    def _balances(self) -> dict:
        return self.store.get("paper_balances", {})

    def _add(self, coin: str, amount: float) -> None:
        b = self._balances()
        b[coin] = b.get(coin, 0.0) + amount
        self.store.set("paper_balances", b)

    def candles(self, symbol, interval, limit=1000):
        return self.market.candles(symbol, interval, limit)

    def last_price(self, symbol):
        return self.market.last_price(symbol)

    def recent_trades(self, symbol):
        return self.market.recent_trades(symbol)

    def instrument(self, symbol) -> Instrument:
        return self.market.instrument(symbol)

    def balance(self, coin: str) -> float:
        return max(0.0, self._balances().get(coin, 0.0))

    def holdings(self) -> dict[str, dict]:
        return {coin: {"qty": qty, "usd": None} for coin, qty in self._balances().items()}

    def market_buy(self, symbol, coin, qty: Decimal) -> Fill:
        price = self.last_price(symbol) * (1 + SLIPPAGE)
        cost = float(qty) * price
        if cost > self.balance("USDT"):
            raise RuntimeError("Balance insufficient")
        self._add("USDT", -cost)
        got = float(qty) * (1 - FEE)
        self._add(coin, got)
        return Fill(uuid.uuid4().hex, got, price, 0.0)

    def market_sell(self, symbol, qty: Decimal) -> Fill:
        coin = symbol.removesuffix("USDT")
        if float(qty) > self.balance(coin) + 1e-12:
            raise RuntimeError("Balance insufficient")
        price = self.last_price(symbol) * (1 - SLIPPAGE)
        self._add(coin, -float(qty))
        fee = float(qty) * price * FEE
        self._add("USDT", float(qty) * price - fee)
        return Fill(uuid.uuid4().hex, float(qty), price, fee)

    def place_stop(self, symbol, qty: Decimal, trigger: Decimal) -> str:
        oid = uuid.uuid4().hex
        stops = self.store.get("paper_stops", {})
        stops[oid] = {"symbol": symbol, "qty": float(qty), "trigger": float(trigger), "status": "open"}
        self.store.set("paper_stops", stops)
        return oid

    def stop_state(self, symbol, order_id):
        stops = self.store.get("paper_stops", {})
        s = stops.get(order_id)
        if s is None or s["status"] == "cancelled":
            return "gone", None
        if s["status"] == "filled":
            return "filled", Fill(order_id, s["qty"], s["fill_price"], s["fee"])
        if self.last_price(symbol) <= s["trigger"]:
            fill = self.market_sell(symbol, Decimal(str(min(s["qty"], self.balance(symbol.removesuffix("USDT"))))))
            s.update(status="filled", fill_price=fill.avg_price, fee=fill.fee_usdt)
            self.store.set("paper_stops", stops)
            return "filled", fill
        return "open", None

    def cancel_stop(self, symbol, order_id) -> None:
        stops = self.store.get("paper_stops", {})
        if order_id in stops and stops[order_id]["status"] == "open":
            stops[order_id]["status"] = "cancelled"
            self.store.set("paper_stops", stops)
