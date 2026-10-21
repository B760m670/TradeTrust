import numpy as np
import pandas as pd
import pytest

from tradetrust import backtest as bt
from tradetrust import portfolio as pf


def candles(closes, start="2026-01-01", spread=0.01):
    closes = np.asarray(closes, dtype=float)
    idx = pd.date_range(start, periods=len(closes), freq="4h", tz="UTC")
    opens = np.r_[closes[0], closes[:-1]]
    return pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * (1 + spread),
                         "low": np.minimum(opens, closes) * (1 - spread), "close": closes, "volume": 1.0}, index=idx)


P = bt.Params(fast=3, slow=6, atr_period=3)
WAVE = candles(100 + 30 * np.sin(np.linspace(0, 6 * np.pi, 240)))
LOOSE = pf.Rules(max_positions=99, max_position_pct=1.0, max_total_risk=1.0, momentum_days=1)


def test_one_coin_without_limits_matches_the_single_coin_backtest():
    eq, trades = pf.run(pf.prepare({"X": WAVE}, P, LOOSE), P, LOOSE, WAVE.index[0])
    ref = bt.run(WAVE, P)
    assert len(trades) == len(ref.trades) - (1 if ref.open_trade else 0)
    assert eq.iloc[-1] == pytest.approx(ref.equity.iloc[-1], rel=1e-9)


def test_position_limit_is_respected():
    coins = {f"C{k}": candles(100 + 30 * np.sin(np.linspace(0, 6 * np.pi, 240) + k * 0.01)) for k in range(4)}
    rules = pf.Rules(max_positions=2, max_position_pct=1.0, max_total_risk=1.0, momentum_days=1)
    _, trades = pf.run(pf.prepare(coins, P, rules), P, rules, WAVE.index[0])
    times = sorted({t["opened"] for t in trades})
    for t in times:
        assert sum(tr["opened"] <= t < tr["closed"] for tr in trades) <= 2


def test_top_n_keeps_only_the_strongest():
    strong = candles(np.r_[np.linspace(50, 100, 120), 100 + 30 * np.sin(np.linspace(0, 6 * np.pi, 240))])
    weak = candles(np.r_[np.linspace(150, 100, 120), 100 + 30 * np.sin(np.linspace(0, 6 * np.pi, 240))])
    rules = pf.Rules(top_n=1, momentum_days=20, max_positions=5, max_position_pct=1.0, max_total_risk=1.0)
    data = pf.prepare({"STRONG": strong, "WEAK": weak}, P, rules)
    _, trades = pf.run(data, P, rules, strong.index[130])
    assert trades and {t["coin"] for t in trades} == {"STRONG"}
