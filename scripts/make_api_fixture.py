"""Готовит bot_status.json: настоящий ответ /api/status сервера.

Его читают BotApiContractTest (Android) и App.test.tsx (мини-приложение) — так клиенты
проверяются на том же JSON, который отдаёт бот.

Бот на бумажном счёте, рынок — статичные свечи; один сигнал подтверждён (есть позиция),
по второй монете висит предложение, третья монета куплена и закрыта по стопу.
Запуск из корня репозитория: python -m scripts.make_api_fixture
"""
import json
import tempfile
from decimal import Decimal
from pathlib import Path

import numpy as np
import pandas as pd

from tradetrust import backtest as bt
from tradetrust.bot.bybit import Instrument
from tradetrust.bot.config import Config
from tradetrust.bot.engine import Bot
from tradetrust.bot.paper import PaperExchange
from tradetrust.bot.store import Store

OUT = Path(__file__).resolve().parent.parent / "android/app/src/test/resources/bot_status.json"


def cross_candles(scale: float) -> pd.DataFrame:
    closes = np.r_[np.full(20, 100.0), np.linspace(100, 200, 40)] * scale
    idx = pd.date_range("2026-01-01", periods=len(closes), freq="4h", tz="UTC")
    opens = np.r_[closes[0], closes[:-1]]
    df = pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * 1.05,
                       "low": np.minimum(opens, closes) * 0.95, "close": closes, "volume": 1.0}, index=idx)
    i = int(np.argmax(bt.prepare(df, bt.Params(fast=3, slow=6, atr_period=3))["cross_up"].to_numpy()))
    return df.iloc[: i + 1]


class StaticMarket:
    def __init__(self):
        self.data = {f"{c}USDT": cross_candles(s) for c, s in (("SOL", 1.0), ("ETH", 20.0), ("LINK", 0.1))}
        self.prices = {k: float(v["close"].iloc[-1]) for k, v in self.data.items()}

    def candles(self, symbol, interval, limit=1000):
        return self.data[symbol]

    def last_price(self, symbol):
        return self.prices[symbol]

    def instrument(self, symbol):
        return Instrument(symbol, Decimal("0.001"), Decimal("0.01"), Decimal("5"), Decimal("1e9"))


def main() -> None:
    db = tempfile.mkdtemp() + "/bot.db"
    cfg = Config(env="paper", mode="confirm", coins=["SOL", "ETH", "LINK"], ema_fast=3, ema_slow=6, db_path=db)
    market = StaticMarket()
    store = Store(db)
    bot = Bot(cfg, PaperExchange(market, store), store)
    bot.params = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=2.0, risk=0.01)
    bot.on_candle_close()
    props = {p.coin: p for p in store.pending_proposals()}
    bot.confirm(props["SOL"].id)
    bot.confirm(props["LINK"].id)
    market.prices["LINKUSDT"] = store.position("LINK").stop * 0.99
    bot.reconcile()
    status = bot.status()
    OUT.write_text(json.dumps(status, ensure_ascii=False, default=str, indent=1))
    print(f"positions={len(status['positions'])} proposals={len(status['proposals'])} trades={len(status['trades'])}")


if __name__ == "__main__":
    main()
