"""Цена монеты на разных биржах — из CoinGecko (агрегатор: собирает цены и обороты со всех бирж).

Без ключей бирж и бесплатно: публичный API CoinGecko (с ключом demo — выше лимиты, COINGECKO_API_KEY).
Показываем биржи владельца (Bybit, Binance, OKX, KuCoin): цена, спред, оборот, отклонение от средней,
пометки «данные устарели» / «аномалия» — такие строки в сравнении не участвуют.
"""
from __future__ import annotations

import logging
import statistics
import threading
import time
from urllib.parse import urlsplit, urlunsplit

import requests

log = logging.getLogger(__name__)

BASE = "https://api.coingecko.com/api/v3"
# id монет в CoinGecko: тикер не уникален (под одним тикером бывают разные токены), поэтому для своих монет — явно
GECKO_IDS = {
    "BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana", "XRP": "ripple", "DOGE": "dogecoin", "ADA": "cardano",
    "LINK": "chainlink", "AVAX": "avalanche-2", "BNB": "binancecoin", "TRX": "tron", "DOT": "polkadot",
    "LTC": "litecoin", "BCH": "bitcoin-cash", "NEAR": "near", "UNI": "uniswap", "ATOM": "cosmos", "XLM": "stellar",
    "ETC": "ethereum-classic", "FIL": "filecoin", "AAVE": "aave", "APT": "aptos", "OP": "optimism",
    "ARB": "arbitrum", "INJ": "injective-protocol", "SUI": "sui", "TON": "the-open-network",
}
# биржи владельца: id в CoinGecko → название
EXCHANGES = {"bybit_spot": "Bybit", "binance": "Binance", "okex": "OKX", "kucoin": "KuCoin"}
CACHE_SECONDS = 120      # цены по биржам не чаще раза в 2 минуты на монету: бесплатный лимит CoinGecko невелик
MIN_VOLUME_USD = 50_000  # с меньшим оборотом цена случайна — показываем, но не сравниваем


def clean_url(url: str | None) -> str | None:
    """Ссылка на пару на бирже без реферальных параметров."""
    if not url:
        return None
    parts = urlsplit(url)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def summarize(coin: str, tickers: list[dict]) -> dict:
    """Строки по биржам владельца (пара к USDT) и разброс цен между теми, чьим данным можно верить."""
    rows = []
    for t in tickers:
        ex = (t.get("market") or {}).get("identifier")
        if ex not in EXCHANGES or t.get("target") != "USDT" or not t.get("last"):
            continue
        volume = float((t.get("converted_volume") or {}).get("usd") or 0)
        rows.append({
            "exchange": ex, "name": EXCHANGES[ex], "price": float(t["last"]),
            "spread_pct": t.get("bid_ask_spread_percentage"), "volume_usd": volume,
            "stale": bool(t.get("is_stale")), "anomaly": bool(t.get("is_anomaly")), "thin": volume < MIN_VOLUME_USD,
            "url": clean_url(t.get("trade_url")), "updated": t.get("last_traded_at") or t.get("timestamp"),
        })
    # у биржи может быть несколько строк (разные пары/рынки) — берём самую оборотную
    best: dict[str, dict] = {}
    for r in rows:
        if r["exchange"] not in best or r["volume_usd"] > best[r["exchange"]]["volume_usd"]:
            best[r["exchange"]] = r
    rows = sorted(best.values(), key=lambda r: list(EXCHANGES).index(r["exchange"]))
    good = [r["price"] for r in rows if not (r["stale"] or r["anomaly"] or r["thin"])]
    mid = statistics.median(good) if good else None
    for r in rows:
        r["diff_pct"] = (r["price"] / mid - 1) * 100 if mid and not (r["stale"] or r["anomaly"] or r["thin"]) else None
    spread = (max(good) / min(good) - 1) * 100 if len(good) >= 2 else None
    return {"coin": coin, "rows": rows, "median": mid, "range_pct": spread, "missing": [n for k, n in EXCHANGES.items()
                                                                                       if k not in best]}


class Venues:
    def __init__(self, api_key: str = "", session: requests.Session | None = None):
        self.http = session or requests.Session()
        self.headers = {"accept": "application/json", **({"x-cg-demo-api-key": api_key} if api_key else {})}
        self._cache: dict[str, tuple[float, dict]] = {}
        self._ids: dict[str, str | None] = {}
        self.lock = threading.Lock()

    def _get(self, path: str, params: dict) -> dict:
        resp = self.http.get(BASE + path, params=params, headers=self.headers, timeout=15)
        resp.raise_for_status()
        return resp.json()

    def coin_id(self, coin: str) -> str | None:
        if coin in GECKO_IDS:
            return GECKO_IDS[coin]
        if coin not in self._ids:
            # чужая монета: самая крупная по капитализации с таким тикером
            found = [c for c in self._get("/search", {"query": coin}).get("coins", []) if c.get("symbol", "").upper() == coin]
            found.sort(key=lambda c: c.get("market_cap_rank") or 10**9)
            self._ids[coin] = found[0]["id"] if found else None
        return self._ids[coin]

    def prices(self, coin: str) -> dict:
        coin = coin.upper()
        now = time.time()
        with self.lock:
            hit = self._cache.get(coin)
            if hit and now - hit[0] < CACHE_SECONDS:
                return hit[1]
            try:
                cid = self.coin_id(coin)
                if cid is None:
                    return {"coin": coin, "rows": [], "error": "монеты нет в CoinGecko"}
                data = self._get(f"/coins/{cid}/tickers", {"exchange_ids": ",".join(EXCHANGES)})
                result = {**summarize(coin, data.get("tickers") or []), "updated_at": int(now), "source": "CoinGecko"}
            except Exception as exc:
                log.warning("coingecko %s: %s", coin, exc)
                status = getattr(getattr(exc, "response", None), "status_code", None)
                why = ("CoinGecko ограничил частоту запросов — обновится через минуту" if status == 429
                       else "CoinGecko не ответил")
                if hit:  # лимит или сбой — отдаём прошлые данные с пометкой
                    return {**hit[1], "error": f"{why}; показаны данные прошлого обновления"}
                return {"coin": coin, "rows": [], "error": why}
            self._cache[coin] = (now, result)
            return result
