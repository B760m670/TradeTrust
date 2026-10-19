"""Бэктест трендовой системы EMA fast/slow, только покупки (спот, без плеча).

Правила:
  * Вход: на закрытии свечи EMA fast пересекла EMA slow снизу вверх
    (и, если включён фильтр, BTC выше 200-дневной SMA) — покупка по открытию
    следующей свечи.
  * Стоп: цена входа − atr_mult × ATR на момент сигнала. Срабатывает внутри
    свечи; если свеча открылась ниже стопа (гэп) — выход по открытию.
  * Выход по сигналу: на закрытии EMA fast ниже EMA slow — продажа по
    открытию следующей свечи.
  * Размер: sizing="risk" — потеря до стопа равна risk доли капитала
    (но не больше всего капитала); sizing="all" — весь капитал в сделку.
  * Комиссия fee берётся с каждой стороны сделки.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .indicators import atr, ema


@dataclass(frozen=True)
class Params:
    fast: int = 20
    slow: int = 50
    atr_period: int = 14
    atr_mult: float = 2.0
    risk: float = 0.01
    sizing: str = "risk"  # "risk" | "all"
    fee: float = 0.001


@dataclass
class Trade:
    entry_time: pd.Timestamp
    entry_price: float
    stop: float
    qty: float
    exit_time: pd.Timestamp | None = None
    exit_price: float | None = None
    reason: str = ""

    @property
    def pnl_pct(self) -> float:
        return (self.exit_price / self.entry_price - 1) * 100 if self.exit_price else 0.0


@dataclass
class Result:
    equity: pd.Series
    trades: list[Trade] = field(default_factory=list)
    open_trade: Trade | None = None

    @property
    def total_return(self) -> float:
        return (self.equity.iloc[-1] / self.equity.iloc[0] - 1) * 100

    @property
    def max_drawdown(self) -> float:
        eq = self.equity
        return ((eq / eq.cummax()) - 1).min() * 100

    @property
    def win_rate(self) -> float:
        closed = [t for t in self.trades if t.exit_price]
        return 100 * sum(t.exit_price > t.entry_price for t in closed) / len(closed) if closed else 0.0

    def summary(self) -> dict:
        return {
            "return_%": round(self.total_return, 1),
            "max_dd_%": round(self.max_drawdown, 1),
            "trades": len(self.trades),
            "win_%": round(self.win_rate, 0),
        }


def prepare(df: pd.DataFrame, p: Params, regime: pd.Series | None = None) -> pd.DataFrame:
    """Индикаторы и сигналы на закрытии каждой свечи."""
    out = df.copy()
    out["ema_fast"] = ema(out["close"], p.fast)
    out["ema_slow"] = ema(out["close"], p.slow)
    out["atr"] = atr(out, p.atr_period)
    above = out["ema_fast"] > out["ema_slow"]
    valid = out["ema_slow"].notna()
    out["cross_up"] = above & ~above.shift(1, fill_value=True) & valid
    out["trend_down"] = ~above & valid
    out["regime_ok"] = True if regime is None else regime.reindex(out.index).fillna(False).astype(bool)
    return out


def run(df: pd.DataFrame, p: Params = Params(), regime: pd.Series | None = None,
        start: pd.Timestamp | None = None, end: pd.Timestamp | None = None,
        capital: float = 1.0, prepared: pd.DataFrame | None = None) -> Result:
    """Индикаторы считаются по всей истории (прогрев), торговля — только в [start, end)."""
    data = prepared if prepared is not None else prepare(df, p, regime)
    if start is not None:
        data = data[data.index >= start]
    if end is not None:
        data = data[data.index < end]

    o, h, l, c = (data[k].to_numpy() for k in ("open", "high", "low", "close"))
    atr_v = data["atr"].to_numpy()
    cross_up = data["cross_up"].to_numpy()
    trend_down = data["trend_down"].to_numpy()
    regime_ok = data["regime_ok"].to_numpy()
    idx = data.index

    cash, qty = capital, 0.0
    trade: Trade | None = None
    trades: list[Trade] = []
    pending_entry = pending_exit = False
    stop_dist = np.nan
    equity = np.empty(len(data))

    for i in range(len(data)):
        # 1) исполнение решений, принятых на закрытии прошлой свечи
        if pending_exit and trade:
            cash += qty * o[i] * (1 - p.fee)
            trade.exit_time, trade.exit_price, trade.reason = idx[i], o[i], "signal"
            trade, qty = None, 0.0
        elif pending_entry and not trade:
            stop = o[i] - stop_dist
            risk_per_unit = stop_dist
            if risk_per_unit > 0:
                max_qty = cash / (o[i] * (1 + p.fee))
                qty = max_qty if p.sizing == "all" else min(max_qty, cash * p.risk / risk_per_unit)
                cash -= qty * o[i] * (1 + p.fee)
                trade = Trade(idx[i], o[i], stop, qty)
                trades.append(trade)
        pending_entry = pending_exit = False

        # 2) стоп внутри свечи
        if trade and l[i] <= trade.stop:
            px = min(o[i], trade.stop)
            cash += qty * px * (1 - p.fee)
            trade.exit_time, trade.exit_price, trade.reason = idx[i], px, "stop"
            trade, qty = None, 0.0

        # 3) сигналы на закрытии
        if trade and trend_down[i]:
            pending_exit = True
        elif not trade and cross_up[i] and regime_ok[i] and atr_v[i] > 0:
            pending_entry = True
            stop_dist = p.atr_mult * atr_v[i]

        equity[i] = cash + qty * c[i]

    eq = pd.Series(equity, index=idx)
    return Result(eq, trades, trade)
