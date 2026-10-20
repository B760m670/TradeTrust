"""Проверка устойчивости: много монет, разные периоды, walk-forward."""
from __future__ import annotations

from dataclasses import replace
from itertools import product

import numpy as np
import pandas as pd

from . import backtest as bt
from .data import load_candles
from .indicators import btc_regime

COINS = [
    "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LINK", "AVAX", "BNB", "TRX",
    "DOT", "LTC", "BCH", "NEAR", "UNI", "ATOM", "XLM", "ETC", "FIL", "AAVE",
    "APT", "OP", "ARB", "INJ", "SUI",
]

# Грубая сетка: только «круглые» значения, чтобы не подгонять под историю.
GRID = {"fast": [10, 20, 30], "slow": [50, 100], "atr_mult": [2.0, 3.0]}


def load_universe(coins: list[str], interval: str, since: str, refresh: bool = True):
    candles = {}
    for coin in coins:
        try:
            df = load_candles(f"{coin}USDT", interval, since, refresh)
        except Exception as exc:  # монета могла не торговаться / сеть
            print(f"  {coin}: пропуск ({exc})")
            continue
        if len(df) > 300:
            candles[coin] = df
    btc_daily = load_candles("BTCUSDT", "1d", "2019-01-01", refresh)
    return candles, btc_daily


def score(results: list[bt.Result]) -> float:
    """Медиана отношения доход/просадка по монетам — штрафует за глубокие просадки."""
    vals = [r.total_return / max(abs(r.max_drawdown), 1.0) for r in results]
    return float(np.median(vals)) if vals else -np.inf


def compare(candles: dict, btc_daily: pd.DataFrame, variants: dict[str, tuple[bt.Params, bool]],
            start=None, end=None) -> pd.DataFrame:
    """Таблица: вариант × монета → доход, просадка, сделки."""
    rows = []
    for name, (params, use_filter) in variants.items():
        for coin, df in candles.items():
            regime = btc_regime(btc_daily, df.index) if use_filter else None
            if name == "hold":
                eq = df["close"]
                eq = eq[eq.index >= start] if start is not None else eq
                eq = eq[eq.index < end] if end is not None else eq
                res = bt.Result(eq / eq.iloc[0])
            else:
                res = bt.run(df, params, regime, start, end)
            rows.append({"variant": name, "coin": coin, **res.summary()})
    return pd.DataFrame(rows)


def _bars(df: pd.DataFrame, start, end) -> int:
    return int(((df.index >= start) & (df.index < end)).sum())


def walk_forward(candles: dict, btc_daily: pd.DataFrame, base: bt.Params, use_filter: bool,
                 train_months: int = 12, test_months: int = 6) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Параметры выбираются на train-окне по всем монетам сразу и проверяются на
    следующем test-окне, которое при выборе не использовалось.

    Возвращает (по окнам: выбранные параметры и результат), (итог по монетам:
    склеенная вне-выборочная доходность).
    """
    combos = [replace(base, fast=f, slow=s, atr_mult=a)
              for f, s, a in product(GRID["fast"], GRID["slow"], GRID["atr_mult"]) if f < s]

    # индикаторы для каждой комбинации считаем один раз
    regimes = {coin: btc_regime(btc_daily, df.index) if use_filter else None for coin, df in candles.items()}
    prepared = {(coin, pp): bt.prepare(df, pp, regimes[coin])
                for coin, df in candles.items() for pp in combos}

    first = min(df.index[0] for df in candles.values())
    last = max(df.index[-1] for df in candles.values())
    t = first + pd.DateOffset(months=train_months)
    windows, oos = [], {coin: 1.0 for coin in candles}

    while t < last:
        train_start, test_end = t - pd.DateOffset(months=train_months), t + pd.DateOffset(months=test_months)
        best, best_score = None, -np.inf
        for pp in combos:
            res = [bt.run(df, pp, start=train_start, end=t, prepared=prepared[(coin, pp)])
                   for coin, df in candles.items() if _bars(df, train_start, t) > 500]
            sc = score(res)
            if sc > best_score:
                best, best_score = pp, sc
        test_res = {coin: bt.run(df, best, start=t, end=test_end, prepared=prepared[(coin, best)])
                    for coin, df in candles.items() if _bars(df, t, test_end) > 10}
        for coin, r in test_res.items():
            oos[coin] *= 1 + r.total_return / 100
        rets = [r.total_return for r in test_res.values()]
        windows.append({
            "test_from": t.date(), "test_to": min(test_end, last).date(),
            "fast": best.fast, "slow": best.slow, "atr_mult": best.atr_mult,
            "train_score": round(best_score, 2),
            "test_median_%": round(float(np.median(rets)), 1),
            "coins_up": f"{sum(x > 0 for x in rets)}/{len(rets)}",
        })
        t = test_end

    total = pd.DataFrame({"coin": list(oos), "oos_return_%": [round((v - 1) * 100, 1) for v in oos.values()]})
    return pd.DataFrame(windows), total
