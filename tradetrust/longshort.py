"""Бэктест той же трендовой системы в обе стороны: лонг на споте + шорт на бессрочном фьючерсе без плеча.

Правила лонга — как в backtest.py. Шорт — зеркально:
  * Вход: на закрытии EMA fast пересекла EMA slow сверху вниз — продажа по открытию следующей свечи.
  * Стоп: вход + atr_mult × ATR; срабатывает внутри свечи, при гэпе вверх — по открытию.
  * Выход: EMA fast снова выше EMA slow — откуп по открытию следующей свечи.
  * Размер: потеря до стопа = risk капитала, но позиция не больше капитала (плечо 1x).
  * Плата за удержание (funding) списывается в 00, 08 и 16 UTC: funding_8h > 0 — шорт платит.
Когда лонг закрывается по сигналу «тренд вниз», в ту же свечу может открыться шорт, и наоборот.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import backtest as bt


@dataclass(frozen=True)
class Costs:
    spot_fee: float = 0.001      # спот Bybit, тейкер
    perp_fee: float = 0.00055    # бессрочные USDT-контракты Bybit, тейкер
    funding_8h: float = 0.0      # доля от позиции за 8 часов, которую платит шорт


@dataclass
class Deal:
    side: str
    entry_time: pd.Timestamp
    entry: float
    stop: float
    qty: float
    exit_time: pd.Timestamp | None = None
    exit: float | None = None
    reason: str = ""

    @property
    def won(self) -> bool:
        if self.exit is None:
            return False
        return self.exit > self.entry if self.side == "long" else self.exit < self.entry


def prepare(df: pd.DataFrame, p: bt.Params) -> pd.DataFrame:
    out = bt.prepare(df, p)
    above = out["ema_fast"] > out["ema_slow"]
    valid = out["ema_slow"].notna()
    out["cross_down"] = ~above & above.shift(1, fill_value=False) & valid
    out["trend_up"] = above & valid
    return out


def run(data: pd.DataFrame, p: bt.Params = bt.Params(), costs: Costs = Costs(), long: bool = True,
        short: bool = True, start: pd.Timestamp | None = None, capital: float = 1.0
        ) -> tuple[pd.Series, list[Deal]]:
    """data — результат prepare(). Индикаторы считаются по всей истории, торговля — с start."""
    if start is not None:
        data = data[data.index >= start]
    o, h, l, c = (data[k].to_numpy() for k in ("open", "high", "low", "close"))
    atr_v = data["atr"].to_numpy()
    cross_up, cross_down = data["cross_up"].to_numpy(), data["cross_down"].to_numpy()
    trend_up, trend_down = data["trend_up"].to_numpy(), data["trend_down"].to_numpy()
    idx = data.index
    funding_bar = np.isin(idx.hour, (0, 8, 16))

    cash = capital
    deal: Deal | None = None
    deals: list[Deal] = []
    pending_exit, pending_side, stop_dist = False, None, np.nan
    equity = np.empty(len(data))

    def close(i: int, px: float, reason: str) -> None:
        nonlocal cash, deal
        if deal.side == "long":
            cash += deal.qty * px * (1 - costs.spot_fee)
        else:
            cash += deal.qty * (deal.entry - px) - deal.qty * px * costs.perp_fee
        deal.exit_time, deal.exit, deal.reason = idx[i], px, reason
        deal = None

    for i in range(len(data)):
        # 1) исполнение решений прошлой свечи: сначала выход, потом вход (возможен разворот)
        if pending_exit and deal:
            close(i, o[i], "signal")
        if pending_side and not deal and stop_dist > 0:
            fee = costs.spot_fee if pending_side == "long" else costs.perp_fee
            qty = min(cash / (o[i] * (1 + fee)), cash * p.risk / stop_dist)
            if pending_side == "long":
                cash -= qty * o[i] * (1 + fee)
                stop = o[i] - stop_dist
            else:
                cash -= qty * o[i] * fee
                stop = o[i] + stop_dist
            deal = Deal(pending_side, idx[i], o[i], stop, qty)
            deals.append(deal)
        pending_exit, pending_side = False, None

        # 2) стоп внутри свечи
        if deal and deal.side == "long" and l[i] <= deal.stop:
            close(i, min(o[i], deal.stop), "stop")
        elif deal and deal.side == "short" and h[i] >= deal.stop:
            close(i, max(o[i], deal.stop), "stop")

        # 3) плата за удержание шорта
        if deal and deal.side == "short" and funding_bar[i]:
            cash -= deal.qty * o[i] * costs.funding_8h

        # 4) сигналы на закрытии
        if deal and ((deal.side == "long" and trend_down[i]) or (deal.side == "short" and trend_up[i])):
            pending_exit = True
        free = deal is None or pending_exit
        if free and atr_v[i] > 0:
            if long and cross_up[i]:
                pending_side = "long"
            elif short and cross_down[i]:
                pending_side = "short"
            stop_dist = p.atr_mult * atr_v[i]

        if deal is None:
            equity[i] = cash
        elif deal.side == "long":
            equity[i] = cash + deal.qty * c[i]
        else:
            equity[i] = cash + deal.qty * (deal.entry - c[i])
    return pd.Series(equity, index=idx), deals


def stats(equity: pd.Series, deals: list[Deal]) -> dict:
    closed = [d for d in deals if d.exit is not None]
    months = max((equity.index[-1] - equity.index[0]).days / 30.44, 1e-9)
    return {
        "return_%": (equity.iloc[-1] / equity.iloc[0] - 1) * 100,
        "max_dd_%": ((equity / equity.cummax()) - 1).min() * 100,
        "trades": len(deals),
        "per_month": len(deals) / months,
        "win_%": 100 * sum(d.won for d in closed) / len(closed) if closed else 0.0,
        "shorts": sum(d.side == "short" for d in deals),
    }
