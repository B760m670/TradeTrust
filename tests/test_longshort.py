import numpy as np
import pandas as pd
import pytest

from tradetrust import backtest as bt
from tradetrust import longshort as ls


def candles(closes, spread=0.01):
    closes = np.asarray(closes, dtype=float)
    idx = pd.date_range("2026-01-01", periods=len(closes), freq="4h", tz="UTC")
    opens = np.r_[closes[0], closes[:-1]]
    return pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * (1 + spread),
                         "low": np.minimum(opens, closes) * (1 - spread), "close": closes, "volume": 1.0}, index=idx)


P = bt.Params(fast=3, slow=6, atr_period=3)
WAVE = candles(100 + 30 * np.sin(np.linspace(0, 6 * np.pi, 240)))


def test_long_only_matches_the_spot_backtest():
    eq, deals = ls.run(ls.prepare(WAVE, P), P, ls.Costs(spot_fee=0.001), short=False)
    ref = bt.run(WAVE, P)
    assert len(deals) == len(ref.trades)
    assert eq.iloc[-1] == pytest.approx(ref.equity.iloc[-1], rel=1e-9)


def test_short_earns_on_a_fall_and_respects_risk():
    fall = candles(np.r_[np.linspace(100, 120, 40), np.linspace(120, 60, 60)])
    eq, deals = ls.run(ls.prepare(fall, P), P, ls.Costs(perp_fee=0, funding_8h=0), long=False)
    assert deals and deals[0].side == "short" and deals[0].stop > deals[0].entry
    assert eq.iloc[-1] > 1.0
    risk = deals[0].qty * (deals[0].stop - deals[0].entry)
    assert risk <= 0.01 + 1e-9 and deals[0].qty * deals[0].entry <= 1.0 + 1e-9  # 1% риска, без плеча


def test_short_stop_inside_the_bar():
    up = candles(np.r_[np.linspace(100, 120, 40), np.linspace(120, 100, 12), [100, 140, 150]])
    _, deals = ls.run(ls.prepare(up, P), P, ls.Costs(), long=False)
    stopped = [d for d in deals if d.reason == "stop"]
    assert stopped and stopped[0].exit >= stopped[0].stop


def test_funding_is_charged_to_shorts():
    fall = candles(np.r_[np.linspace(100, 120, 40), np.linspace(120, 60, 60)])
    free, _ = ls.run(ls.prepare(fall, P), P, ls.Costs(funding_8h=0), long=False)
    paid, _ = ls.run(ls.prepare(fall, P), P, ls.Costs(funding_8h=0.001), long=False)
    assert paid.iloc[-1] < free.iloc[-1]


def test_reversal_closes_long_and_opens_short_on_the_same_bar():
    eq, deals = ls.run(ls.prepare(WAVE, P), P, ls.Costs())
    sides = [d.side for d in deals]
    assert "long" in sides and "short" in sides
    for a, b in zip(deals, deals[1:]):
        assert b.entry_time >= a.exit_time  # одновременно открыта только одна позиция
