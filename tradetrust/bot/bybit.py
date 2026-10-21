"""Клиент Bybit V5 (спот) и биржевой слой бота.

Только спот без плеча (isLeverage=0). Стоп-лосс — отдельный условный ордер
(orderFilter=StopOrder): рыночная продажа при падении цены до triggerPrice.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from urllib.parse import urlencode

import pandas as pd
import requests

ENDPOINTS = {
    "mainnet": "https://api.bybit.com",
    "demo": "https://api-demo.bybit.com",
    "testnet": "https://api-testnet.bybit.com",
}
MINUTE = 60_000
INTERVALS = {
    "1m": ("1", MINUTE), "5m": ("5", 5 * MINUTE), "15m": ("15", 15 * MINUTE), "1h": ("60", 60 * MINUTE),
    "4h": ("240", 240 * MINUTE), "1d": ("D", 1440 * MINUTE), "1w": ("W", 7 * 1440 * MINUTE),
}


class BybitError(RuntimeError):
    def __init__(self, code: int, msg: str, path: str):
        super().__init__(f"Bybit {path}: {code} {msg}")
        self.code = code


@dataclass(frozen=True)
class Instrument:
    symbol: str
    base_step: Decimal      # шаг количества базовой монеты (basePrecision)
    tick: Decimal           # шаг цены
    min_amount: Decimal     # минимальная сумма ордера в USDT
    max_market_qty: Decimal

    def floor_qty(self, qty: float) -> Decimal:
        return (Decimal(str(qty)) / self.base_step).to_integral_value(ROUND_DOWN) * self.base_step

    def stop_price(self, price: float) -> Decimal:
        """Цена стопа по шагу цены, округление вверх: стоп чуть ближе, риск не больше расчётного."""
        return (Decimal(str(price)) / self.tick).to_integral_value(ROUND_UP) * self.tick


@dataclass
class Fill:
    order_id: str
    qty: float        # сколько монет реально получено/продано (после комиссии в монете)
    avg_price: float
    fee_usdt: float


class BybitClient:
    def __init__(self, env: str = "mainnet", api_key: str = "", api_secret: str = "",
                 base_url: str | None = None, recv_window: int = 5000, session: requests.Session | None = None):
        self.base = (base_url or ENDPOINTS[env]).rstrip("/")
        self.key, self.secret = api_key, api_secret
        self.recv_window = str(recv_window)
        self.http = session or requests.Session()
        self.time_offset = 0  # мс, сервер минус локальное время

    # --- транспорт ---------------------------------------------------------
    def sign(self, timestamp: str, payload: str) -> str:
        msg = timestamp + self.key + self.recv_window + payload
        return hmac.new(self.secret.encode(), msg.encode(), hashlib.sha256).hexdigest()

    def _request(self, method: str, path: str, params: dict | None = None, auth: bool = False) -> dict:
        params = {k: v for k, v in (params or {}).items() if v is not None}
        url = self.base + path
        headers = {}
        body = None
        if method == "GET":
            query = urlencode(params)
            payload = query
            if query:
                url += "?" + query
        else:
            body = json.dumps(params, separators=(",", ":"))
            payload = body
            headers["Content-Type"] = "application/json"
        if auth:
            if not self.key:
                raise RuntimeError("Не задан BYBIT_API_KEY")
            ts = str(int(time.time() * 1000) + self.time_offset)
            headers.update({
                "X-BAPI-API-KEY": self.key,
                "X-BAPI-TIMESTAMP": ts,
                "X-BAPI-RECV-WINDOW": self.recv_window,
                "X-BAPI-SIGN": self.sign(ts, payload),
            })
        resp = self.http.request(method, url, data=body, headers=headers, timeout=20)
        resp.raise_for_status()
        data = resp.json()
        if data.get("retCode") != 0:
            raise BybitError(data.get("retCode"), data.get("retMsg", ""), path)
        return data.get("result") or {}

    def sync_time(self) -> None:
        result = self._request("GET", "/v5/market/time")
        server_ms = int(result["timeNano"]) // 1_000_000
        self.time_offset = server_ms - int(time.time() * 1000)

    # --- рынок -------------------------------------------------------------
    def candles(self, symbol: str, interval: str = "4h", limit: int = 1000) -> pd.DataFrame:
        """Только закрытые свечи, по возрастанию времени; индекс — время открытия (UTC)."""
        code, ms = INTERVALS[interval]
        rows = self._request("GET", "/v5/market/kline",
                             {"category": "spot", "symbol": symbol, "interval": code, "limit": limit})["list"]
        now = int(time.time() * 1000) + self.time_offset
        rows = [r for r in rows if int(r[0]) + ms <= now]
        df = pd.DataFrame([r[:6] for r in rows], columns=["time", "open", "high", "low", "close", "volume"])
        df["time"] = pd.to_datetime(df["time"].astype("int64"), unit="ms", utc=True)
        return df.set_index("time").astype(float).sort_index()

    def last_price(self, symbol: str) -> float:
        rows = self._request("GET", "/v5/market/tickers", {"category": "spot", "symbol": symbol})["list"]
        return float(rows[0]["lastPrice"])

    def recent_trades(self, symbol: str, limit: int = 60) -> list[dict]:
        """Последние сделки на рынке (спот отдаёт до 60): время в мс, цена, объём — по возрастанию времени."""
        rows = self._request("GET", "/v5/market/recent-trade",
                             {"category": "spot", "symbol": symbol, "limit": limit})["list"]
        return sorted(({"t": int(r["time"]), "p": float(r["price"]), "v": float(r["size"])} for r in rows),
                      key=lambda r: r["t"])

    def instrument(self, symbol: str) -> Instrument:
        rows = self._request("GET", "/v5/market/instruments-info", {"category": "spot", "symbol": symbol})["list"]
        if not rows:
            raise BybitError(-1, "symbol not found", symbol)
        lot, price = rows[0]["lotSizeFilter"], rows[0]["priceFilter"]
        return Instrument(symbol, Decimal(lot["basePrecision"]), Decimal(price["tickSize"]),
                          Decimal(lot.get("minOrderAmt") or "5"), Decimal(lot.get("maxMarketOrderQty") or "1e18"))

    # --- аккаунт и ордера ----------------------------------------------------
    def wallet(self, coins: list[str] | None = None) -> dict[str, dict]:
        result = self._request("GET", "/v5/account/wallet-balance",
                               {"accountType": "UNIFIED", "coin": ",".join(coins) if coins else None}, auth=True)
        out = {}
        for acct in result.get("list", []):
            for c in acct.get("coin", []):
                out[c["coin"]] = {"wallet": float(c.get("walletBalance") or 0), "locked": float(c.get("locked") or 0),
                                  "usd": float(c.get("usdValue") or 0)}
        return out

    def place_order(self, **params) -> str:
        params = {"category": "spot", "isLeverage": 0, "orderLinkId": f"tt-{uuid.uuid4().hex[:28]}", **params}
        return self._request("POST", "/v5/order/create", params, auth=True)["orderId"]

    def get_order(self, symbol: str, order_id: str) -> dict | None:
        """Открытый или недавно закрытый ордер; если его уже нет в «realtime» — ищем в истории."""
        for path in ("/v5/order/realtime", "/v5/order/history"):
            rows = self._request("GET", path, {"category": "spot", "symbol": symbol, "orderId": order_id},
                                 auth=True).get("list", [])
            if rows:
                return rows[0]
        return None

    def cancel_order(self, symbol: str, order_id: str, order_filter: str = "StopOrder") -> None:
        self._request("POST", "/v5/order/cancel", {"category": "spot", "symbol": symbol, "orderId": order_id,
                                                    "orderFilter": order_filter}, auth=True)


def fee_in(order: dict, coin: str) -> float:
    detail = order.get("cumFeeDetail") or {}
    if isinstance(detail, str):
        detail = json.loads(detail or "{}")
    return float(detail.get(coin, 0) or 0)


class BybitExchange:
    """Биржевые действия бота поверх BybitClient."""

    FINAL = {"Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled", "Deactivated"}

    def __init__(self, client: BybitClient, poll_seconds: float = 0.5, poll_tries: int = 20):
        self.c = client
        self.poll_seconds, self.poll_tries = poll_seconds, poll_tries
        self._instruments: dict[str, Instrument] = {}

    def instrument(self, symbol: str) -> Instrument:
        if symbol not in self._instruments:
            self._instruments[symbol] = self.c.instrument(symbol)
        return self._instruments[symbol]

    def candles(self, symbol: str, interval: str, limit: int = 1000) -> pd.DataFrame:
        return self.c.candles(symbol, interval, limit)

    def last_price(self, symbol: str) -> float:
        return self.c.last_price(symbol)

    def recent_trades(self, symbol: str) -> list[dict]:
        return self.c.recent_trades(symbol)

    def balance(self, coin: str) -> float:
        b = self.c.wallet([coin]).get(coin)
        return max(0.0, b["wallet"] - b["locked"]) if b else 0.0

    def holdings(self) -> dict[str, dict]:
        """Все монеты на счёте: количество и стоимость в USD по оценке биржи."""
        return {coin: {"qty": b["wallet"], "usd": b["usd"]} for coin, b in self.c.wallet().items()}

    def _wait_final(self, symbol: str, order_id: str) -> dict:
        order = None
        for _ in range(self.poll_tries):
            order = self.c.get_order(symbol, order_id)
            if order and order.get("orderStatus") in self.FINAL:
                return order
            time.sleep(self.poll_seconds)
        raise RuntimeError(f"Ордер {order_id} не исполнился вовремя: {order}")

    def market_buy(self, symbol: str, coin: str, qty: Decimal) -> Fill:
        oid = self.c.place_order(symbol=symbol, side="Buy", orderType="Market", qty=str(qty), marketUnit="baseCoin")
        o = self._wait_final(symbol, oid)
        got = float(o.get("cumExecQty") or 0) - fee_in(o, coin)
        if got <= 0:
            raise RuntimeError(f"Покупка {symbol} не исполнилась: {o.get('orderStatus')}")
        return Fill(oid, got, float(o.get("avgPrice") or 0), 0.0)

    def market_sell(self, symbol: str, qty: Decimal) -> Fill:
        oid = self.c.place_order(symbol=symbol, side="Sell", orderType="Market", qty=str(qty))
        o = self._wait_final(symbol, oid)
        return Fill(oid, float(o.get("cumExecQty") or 0), float(o.get("avgPrice") or 0), fee_in(o, "USDT"))

    def place_stop(self, symbol: str, qty: Decimal, trigger: Decimal) -> str:
        return self.c.place_order(symbol=symbol, side="Sell", orderType="Market", qty=str(qty),
                                  triggerPrice=str(trigger), orderFilter="StopOrder")

    def stop_state(self, symbol: str, order_id: str) -> tuple[str, Fill | None]:
        """("open", None) | ("filled", Fill) | ("gone", None) — отменён вручную или не найден."""
        o = self.c.get_order(symbol, order_id)
        if o is None:
            return "gone", None
        status = o.get("orderStatus")
        if status in ("Untriggered", "New", "PartiallyFilled", "Triggered"):
            return "open", None
        if status == "Filled":
            return "filled", Fill(order_id, float(o.get("cumExecQty") or 0), float(o.get("avgPrice") or 0),
                                  fee_in(o, "USDT"))
        return "gone", None

    def cancel_stop(self, symbol: str, order_id: str) -> None:
        try:
            self.c.cancel_order(symbol, order_id)
        except BybitError as exc:
            # 170213 / 110001: ордера уже нет (сработал или отменён) — продолжаем закрытие
            if exc.code not in (170213, 110001):
                raise
