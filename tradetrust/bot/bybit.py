"""Клиент Bybit V5 и биржевой слой бота.

Спот без плеча (isLeverage=0): стоп-лосс — отдельный условный ордер (orderFilter=StopOrder),
рыночная продажа при падении цены до triggerPrice.
Бессрочные фьючерсы USDT (linear) — для копитрейдинга: Bybit копирует подписчикам только их.
Бот там только покупает (лонг) с плечом 1x и на сумму не больше своих денег — по риску это тот же спот.
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

# связь с биржей для админки: когда был последний удачный запрос и последняя ошибка
HEALTH: dict = {"ok_at": None, "error_at": None, "error": ""}

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
    copy_trading: bool = True  # фьючерс доступен в копитрейдинге (на споте не используется)

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
                 base_url: str | None = None, recv_window: int = 5000, session: requests.Session | None = None,
                 category: str = "spot"):
        self.base = (base_url or ENDPOINTS[env]).rstrip("/")
        self.category = category  # spot | linear (бессрочные фьючерсы USDT)
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
        try:
            resp = self.http.request(method, url, data=body, headers=headers, timeout=20)
            resp.raise_for_status()
            data = resp.json()
        except Exception as exc:
            HEALTH.update(error_at=time.time(), error=f"{path}: {exc}"[:300])
            raise
        if data.get("retCode") != 0:
            # ошибка в ответе (например, мало денег) — связь при этом есть
            HEALTH["ok_at"] = time.time()
            raise BybitError(data.get("retCode"), data.get("retMsg", ""), path)
        HEALTH["ok_at"] = time.time()
        return data.get("result") or {}

    def sync_time(self) -> None:
        result = self._request("GET", "/v5/market/time")
        server_ms = int(result["timeNano"]) // 1_000_000
        self.time_offset = server_ms - int(time.time() * 1000)

    # --- рынок -------------------------------------------------------------
    def candles(self, symbol: str, interval: str = "4h", limit: int = 1000, end: int | None = None) -> pd.DataFrame:
        """Только закрытые свечи, по возрастанию времени; индекс — время открытия (UTC).
        end — время в мс: свечи, открытые не позже него (для подгрузки истории)."""
        code, ms = INTERVALS[interval]
        rows = self._request("GET", "/v5/market/kline",
                             {"category": self.category, "symbol": symbol, "interval": code, "limit": limit, "end": end})["list"]
        now = int(time.time() * 1000) + self.time_offset
        rows = [r for r in rows if int(r[0]) + ms <= now]
        df = pd.DataFrame([r[:6] for r in rows], columns=["time", "open", "high", "low", "close", "volume"])
        df["time"] = pd.to_datetime(df["time"].astype("int64"), unit="ms", utc=True)
        return df.set_index("time").astype(float).sort_index()

    def last_price(self, symbol: str) -> float:
        rows = self._request("GET", "/v5/market/tickers", {"category": self.category, "symbol": symbol})["list"]
        return float(rows[0]["lastPrice"])

    def recent_trades(self, symbol: str, limit: int = 60) -> list[dict]:
        """Последние сделки на рынке (спот отдаёт до 60): время в мс, цена, объём — по возрастанию времени."""
        rows = self._request("GET", "/v5/market/recent-trade",
                             {"category": self.category, "symbol": symbol, "limit": limit})["list"]
        return sorted(({"t": int(r["time"]), "p": float(r["price"]), "v": float(r["size"])} for r in rows),
                      key=lambda r: r["t"])

    def instrument(self, symbol: str) -> Instrument:
        rows = self._request("GET", "/v5/market/instruments-info", {"category": self.category, "symbol": symbol})["list"]
        if not rows:
            raise BybitError(-1, "symbol not found", symbol)
        lot, price = rows[0]["lotSizeFilter"], rows[0]["priceFilter"]
        if self.category == "linear":
            return Instrument(symbol, Decimal(lot["qtyStep"]), Decimal(price["tickSize"]),
                              Decimal(lot.get("minNotionalValue") or "5"), Decimal(lot.get("maxMktOrderQty") or "1e18"),
                              copy_trading=rows[0].get("copyTrading", "none") != "none")
        return Instrument(symbol, Decimal(lot["basePrecision"]), Decimal(price["tickSize"]),
                          Decimal(lot.get("minOrderAmt") or "5"), Decimal(lot.get("maxMarketOrderQty") or "1e18"))

    # --- аккаунт и ордера ----------------------------------------------------
    def key_info(self) -> dict:
        """Права и привязка к IP ключа, которым подписаны запросы."""
        return self._request("GET", "/v5/user/query-api", auth=True)

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
        spot = {"isLeverage": 0} if self.category == "spot" else {}
        params = {"category": self.category, **spot, "orderLinkId": f"tt-{uuid.uuid4().hex[:28]}", **params}
        return self._request("POST", "/v5/order/create", params, auth=True)["orderId"]

    def positions(self) -> list[dict]:
        """Открытые позиции по фьючерсам USDT."""
        rows = self._request("GET", "/v5/position/list", {"category": self.category, "settleCoin": "USDT"},
                             auth=True).get("list", [])
        return [r for r in rows if float(r.get("size") or 0) > 0]

    def set_leverage(self, symbol: str, leverage: str = "1") -> None:
        self._request("POST", "/v5/position/set-leverage", {"category": self.category, "symbol": symbol,
                                                            "buyLeverage": leverage, "sellLeverage": leverage}, auth=True)

    def get_order(self, symbol: str, order_id: str) -> dict | None:
        """Открытый или недавно закрытый ордер; если его уже нет в «realtime» — ищем в истории."""
        for path in ("/v5/order/realtime", "/v5/order/history"):
            rows = self._request("GET", path, {"category": self.category, "symbol": symbol, "orderId": order_id},
                                 auth=True).get("list", [])
            if rows:
                return rows[0]
        return None

    def cancel_order(self, symbol: str, order_id: str, order_filter: str = "StopOrder") -> None:
        # orderFilter нужен только на споте: условный ордер фьючерса отменяется просто по id
        self._request("POST", "/v5/order/cancel", {"category": self.category, "symbol": symbol, "orderId": order_id,
                                                    "orderFilter": order_filter if self.category == "spot" else None},
                      auth=True)


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

    def candles(self, symbol: str, interval: str, limit: int = 1000, end: int | None = None) -> pd.DataFrame:
        return self.c.candles(symbol, interval, limit, end)

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


class LinearExchange(BybitExchange):
    """Фьючерсы USDT для копитрейдинга с тем же поведением, что спот у бота: позиция — «купленные монеты»,
    USDT — деньги, не вложенные в позиции, стоп — условная продажа reduceOnly.
    Плечо 1x и сумма не больше своих денег, поэтому ликвидации практически нет."""

    futures = True
    POSITION_MODE_ERROR = 10001  # positionIdx не подходит к режиму позиций счёта
    LEVERAGE_NOT_MODIFIED = 110043

    def __init__(self, client: BybitClient, copy_only: bool = True, **kw):
        super().__init__(client, **kw)
        self.copy_only = copy_only
        self.position_idx = 0  # 0 — односторонний режим; 1 — лонг в режиме хеджирования (так у копитрейдинга)
        self._leverage_set: set[str] = set()

    def instrument(self, symbol: str) -> Instrument:
        inst = super().instrument(symbol)
        if self.copy_only and not inst.copy_trading:
            raise BybitError(-1, "фьючерс недоступен в копитрейдинге", symbol)
        return inst

    def _longs(self) -> dict[str, dict]:
        return {r["symbol"]: r for r in self.c.positions() if r.get("side") == "Buy"}

    def balance(self, coin: str) -> float:
        longs = self._longs()
        if coin == "USDT":
            usdt = self.c.wallet(["USDT"]).get("USDT")
            invested = sum(float(r["size"]) * float(r["avgPrice"]) for r in longs.values())
            return max(0.0, (usdt["wallet"] if usdt else 0.0) - invested)
        row = longs.get(f"{coin}USDT")
        return float(row["size"]) if row else 0.0

    def holdings(self) -> dict[str, dict]:
        cash = self.balance("USDT")
        out = {"USDT": {"qty": cash, "usd": cash}}
        for sym, r in self._longs().items():
            size = float(r["size"])
            out[sym.removesuffix("USDT")] = {"qty": size, "usd": size * float(r.get("markPrice") or r["avgPrice"])}
        return out

    def _order(self, **params) -> str:
        """Ордер с positionIdx; если счёт в режиме хеджирования (копитрейдинг), запоминаем это и повторяем."""
        try:
            return self.c.place_order(positionIdx=self.position_idx, **params)
        except BybitError as exc:
            if exc.code != self.POSITION_MODE_ERROR:
                raise
            self.position_idx = 1 - self.position_idx
            return self.c.place_order(positionIdx=self.position_idx, **params)

    @staticmethod
    def _fill(oid: str, o: dict) -> Fill:
        return Fill(oid, float(o.get("cumExecQty") or 0), float(o.get("avgPrice") or 0), float(o.get("cumExecFee") or 0))

    def market_buy(self, symbol: str, coin: str, qty: Decimal) -> Fill:
        if symbol not in self._leverage_set:
            try:
                self.c.set_leverage(symbol, "1")
            except BybitError as exc:
                if exc.code != self.LEVERAGE_NOT_MODIFIED:  # плечо уже 1x
                    raise
            self._leverage_set.add(symbol)
        oid = self._order(symbol=symbol, side="Buy", orderType="Market", qty=str(qty))
        fill = self._fill(oid, self._wait_final(symbol, oid))
        if fill.qty <= 0:
            raise RuntimeError(f"Покупка {symbol} не исполнилась")
        return fill

    def market_sell(self, symbol: str, qty: Decimal) -> Fill:
        oid = self._order(symbol=symbol, side="Sell", orderType="Market", qty=str(qty), reduceOnly=True)
        return self._fill(oid, self._wait_final(symbol, oid))

    def place_stop(self, symbol: str, qty: Decimal, trigger: Decimal) -> str:
        # triggerDirection=2 — срабатывает при падении цены до triggerPrice; reduceOnly — только закрывает позицию
        return self._order(symbol=symbol, side="Sell", orderType="Market", qty=str(qty), triggerPrice=str(trigger),
                           triggerDirection=2, triggerBy="LastPrice", reduceOnly=True)

    def stop_state(self, symbol: str, order_id: str) -> tuple[str, Fill | None]:
        o = self.c.get_order(symbol, order_id)
        if o is None:
            return "gone", None
        status = o.get("orderStatus")
        if status in ("Untriggered", "New", "PartiallyFilled", "Triggered"):
            return "open", None
        if status == "Filled":
            return "filled", self._fill(order_id, o)
        return "gone", None
