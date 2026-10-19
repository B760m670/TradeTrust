import numpy as np
import pandas as pd
import pytest

from tradetrust import backtest as bt
from tradetrust import journal
from tradetrust.indicators import btc_regime


def candles(closes, spread=0.01):
    closes = np.asarray(closes, dtype=float)
    idx = pd.date_range("2024-01-01", periods=len(closes), freq="4h", tz="UTC")
    opens = np.r_[closes[0], closes[:-1]]
    return pd.DataFrame({
        "open": opens,
        "high": np.maximum(opens, closes) * (1 + spread),
        "low": np.minimum(opens, closes) * (1 - spread),
        "close": closes,
        "volume": 1.0,
    }, index=idx)


P = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=2.0, fee=0.0)


def test_flat_market_no_trades():
    res = bt.run(candles([100] * 50), P)
    assert res.trades == []
    assert res.total_return == pytest.approx(0)


def test_uptrend_enters_and_profits():
    closes = [100] * 20 + list(np.linspace(100, 200, 40))
    res = bt.run(candles(closes, spread=0.001), P)
    assert len(res.trades) == 1
    assert res.open_trade is not None
    assert res.total_return > 0


def test_entry_executes_at_next_open_not_signal_close():
    closes = [100] * 20 + list(np.linspace(100, 200, 40))
    df = candles(closes, spread=0.001)
    data = bt.prepare(df, P)
    signal_bar = data.index[data["cross_up"]][0]
    t = bt.run(df, P).trades[0]
    assert t.entry_time == signal_bar + pd.Timedelta(hours=4)
    assert t.entry_price == df.loc[t.entry_time, "open"]


def test_risk_sizing_limits_loss_to_risk():
    closes = [100] * 20 + list(np.linspace(100, 130, 15)) + [60] * 10
    p = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=2.0, risk=0.01, fee=0.0)
    res = bt.run(candles(closes, spread=0.001), p)
    stopped = [t for t in res.trades if t.reason == "stop"]
    assert stopped, "ожидали выход по стопу"
    t = stopped[0]
    loss = (t.entry_price - t.exit_price) * t.qty
    risk = (t.entry_price - t.stop) * t.qty
    assert risk <= 0.01 + 1e-9  # до стопа рискуем не больше 1% капитала
    assert loss > 0


def test_no_leverage_position_never_exceeds_capital():
    closes = [100] * 20 + list(np.linspace(100, 300, 60))
    res = bt.run(candles(closes, spread=0.0001), bt.Params(fast=3, slow=6, atr_period=3, atr_mult=0.1, risk=0.5))
    for t in res.trades:
        assert t.qty * t.entry_price <= 1.0 + 1e-9


def test_fees_reduce_return():
    closes = [100] * 20 + list(np.linspace(100, 200, 40))
    df = candles(closes, spread=0.001)
    free = bt.run(df, bt.Params(fast=3, slow=6, atr_period=3, sizing="all", fee=0.0))
    paid = bt.run(df, bt.Params(fast=3, slow=6, atr_period=3, sizing="all", fee=0.01))
    assert paid.total_return < free.total_return


def test_btc_regime_has_no_lookahead():
    days = pd.date_range("2023-01-01", periods=260, freq="1D", tz="UTC")
    closes = np.r_[np.full(259, 100.0), 1000.0]  # скачок только в последний день
    daily = pd.DataFrame({"close": closes}, index=days)
    h4 = pd.date_range(days[-1], periods=12, freq="4h", tz="UTC")
    reg = btc_regime(daily, h4, period=200)
    assert not reg.iloc[:6].any()   # пока день не закрылся — фильтр не знает о скачке
    assert reg.iloc[6:].all()


def test_journal_stats(tmp_path):
    path = tmp_path / "j.csv"
    journal.add({"coin": "BTC", "side": "long", "entry": 100, "stop": 95, "exit": 110, "qty": 1, "fees": 0,
                 "followed_rules": "yes"}, path)
    journal.add({"coin": "ETH", "side": "long", "entry": 100, "stop": 95, "exit": 95, "qty": 1, "fees": 0,
                 "followed_rules": "no"}, path)
    s = journal.stats(journal.load(path))
    assert s["closed_trades"] == 2
    assert s["pnl_$"] == pytest.approx(5)
    assert s["avg_R"] == pytest.approx(0.5)
    assert s["rules_broken"] == 1
