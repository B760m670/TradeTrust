"""Цена монеты на биржах владельца — из CoinGecko: сравниваем только надёжные строки, кэш и лимиты."""
import pytest

from tradetrust.bot import venues as vmod
from tradetrust.bot.venues import Venues, clean_url, summarize

from test_bot import FakeResponse


def tick(ex, price, vol=5e6, target="USDT", **kw):
    return {"market": {"identifier": ex}, "target": target, "last": price, "converted_volume": {"usd": vol},
            "bid_ask_spread_percentage": 0.01, "is_stale": False, "is_anomaly": False,
            "trade_url": f"https://{ex}.com/trade/ETH_USDT?ref=123", "last_traded_at": "t", **kw}


def test_summary_keeps_your_exchanges_and_skips_unreliable_rows():
    s = summarize("ETH", [tick("binance", 100), tick("okex", 100.4), tick("kucoin", 99.6, is_stale=True),
                          tick("bybit_spot", 100.2), tick("bybit_spot", 90, vol=1000), tick("gate", 120),
                          tick("binance", 101, target="BTC")])
    assert [r["name"] for r in s["rows"]] == ["Bybit", "Binance", "OKX", "KuCoin"]
    assert s["median"] == 100.2 and s["range_pct"] == pytest.approx(0.4)
    kucoin = s["rows"][3]
    assert kucoin["stale"] and kucoin["diff_pct"] is None  # устаревшая цена в сравнении не участвует
    assert s["rows"][0]["price"] == 100.2 and s["rows"][1]["url"] == "https://binance.com/trade/ETH_USDT"
    assert summarize("X", [tick("binance", 1)])["missing"] == ["Bybit", "OKX", "KuCoin"]
    assert clean_url(None) is None


class Session:
    def __init__(self, status=200):
        self.status, self.calls = status, []

    def get(self, url, params=None, headers=None, timeout=None):
        self.calls.append((url, params, headers))
        if "/search" in url:
            return FakeResponse({"coins": [{"id": "fake-night", "symbol": "NIGHT", "market_cap_rank": 900},
                                           {"id": "midnight", "symbol": "NIGHT", "market_cap_rank": 150}]})
        resp = FakeResponse({"tickers": [tick("binance", 100), tick("okex", 101)]})
        if self.status != 200:
            import requests
            err = requests.HTTPError("429")
            err.response = type("R", (), {"status_code": self.status})()

            def boom():
                raise err
            resp.raise_for_status = boom
        return resp


def test_ids_cache_key_and_rate_limit(monkeypatch):
    s = Session()
    v = Venues("demo-key", session=s)
    assert v.prices("eth")["range_pct"] == pytest.approx(1.0)
    assert s.calls[0][0].endswith("/coins/ethereum/tickers") and s.calls[0][2]["x-cg-demo-api-key"] == "demo-key"
    v.prices("ETH")
    assert len(s.calls) == 1  # кэш
    v.prices("NIGHT")
    assert s.calls[-1][0].endswith("/coins/midnight/tickers")  # тикер не уникален — берём самую крупную монету
    s.status = 429
    monkeypatch.setattr(vmod, "CACHE_SECONDS", 0)
    stale = v.prices("ETH")
    assert stale["rows"] and "частоту запросов" in stale["error"]
    assert "частоту" in Venues(session=Session(429)).prices("SOL")["error"]
