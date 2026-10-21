import numpy as np
import pandas as pd

from tradetrust import carry as cr


def events(rate, days=40, start="2024-01-01"):
    idx = pd.date_range(start, periods=days * 3, freq="8h", tz="UTC") + pd.Timedelta(milliseconds=5)
    return pd.Series(rate, index=idx, dtype=float)


def prices(px, days=40, start="2024-01-01"):
    return pd.Series(px, index=pd.date_range(start, periods=days, freq="1D", tz="UTC"), dtype=float)


def test_daily_funding_counts_midnight_charge_for_previous_day():
    e = events(0.0001, days=2)
    d = cr.daily_funding(e)
    assert d.index[0] == pd.Timestamp("2023-12-31", tz="UTC") and d.iloc[0] == 0.0001  # 00:00 01.01 — за 31.12
    assert np.isclose(d.iloc[1], 0.0003)


def test_hedged_position_earns_funding_whatever_the_price_does():
    rules = cr.CarryRules(max_coins=1, lookback=3, enter=0.05, exit=0.0, leverage=1e9)
    start = pd.Timestamp("2024-01-01", tz="UTC")
    flat, _ = cr.run({"X": events(0.0001)}, {"X": prices(100.0)}, {"X": prices(100.0)}, rules, start)
    # 0,03% в день × ~37 дней = 1,1% минус комиссии входа и выхода 0,31%
    assert 1.007 < flat.iloc[-1] < 1.009
    up = np.linspace(100, 200, 40)  # цена удвоилась: спот заработал ровно столько, сколько потерял шорт
    _, trades = cr.run({"X": events(0.0001)}, {"X": prices(up)}, {"X": prices(up)}, rules, start)
    assert len(trades) == 1 and trades[0]["funding"] > 0 and abs(trades[0]["basis"]) < 1e-12


def test_no_entry_and_exit_when_funding_turns_negative():
    rate = np.r_[np.full(60, 0.0001), np.full(60, -0.0002)]
    rules = cr.CarryRules(max_coins=1, lookback=3, enter=0.05, exit=0.0)
    eq, trades = cr.run({"X": events(rate)}, {"X": prices(100.0)}, {"X": prices(100.0)}, rules,
                        pd.Timestamp("2024-01-01", tz="UTC"))
    assert len(trades) == 1 and trades[0]["reason"] == "ставка упала"
    assert trades[0]["closed"] < pd.Timestamp("2024-01-25", tz="UTC")
