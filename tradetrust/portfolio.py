"""Бэктест всего портфеля так, как торгует бот: общий капитал на все монеты и его лимиты.

Правила входа/выхода — как в backtest.py (EMA-пересечение, стоп atr_mult × ATR, выход при EMA fast < slow).
Лимиты — как в боте (tradetrust/bot/engine.py: plan): риск на сделку, не больше max_positions позиций,
не больше max_position_pct капитала в одной монете, суммарный риск открытых позиций не больше max_total_risk_pct.
Дополнительно можно отбирать монеты по силе (моментуму) и требовать долгосрочный тренд.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import backtest as bt

BARS_PER_DAY = 6  # свечи 4ч


@dataclass(frozen=True)
class Rules:
    risk: float = 0.01
    max_positions: int = 5
    max_position_pct: float = 0.25
    max_total_risk: float = 0.05
    fee: float = 0.001
    momentum_days: int = 90         # окно для силы монеты
    top_n: int | None = None        # входить только в top_n самых сильных монет (None — в любые)
    positive_momentum: bool = False  # входить, только если монета выросла за окно
    long_trend_days: int | None = None  # входить, только если цена выше SMA за столько дней
    rank_entries: bool = False      # при нехватке мест — сначала самые сильные
    trail_atr: float | None = None  # подтягивать стоп: не ниже close − trail_atr × ATR (только вверх)


@dataclass
class Position:
    coin: str
    qty: float
    entry: float
    stop: float
    opened: pd.Timestamp


def prepare(candles: dict[str, pd.DataFrame], p: bt.Params, rules: Rules) -> dict[str, pd.DataFrame]:
    out = {}
    for coin, df in candles.items():
        d = bt.prepare(df, p)
        d["momentum"] = d["close"] / d["close"].shift(rules.momentum_days * BARS_PER_DAY) - 1
        if rules.long_trend_days:
            d["long_sma"] = d["close"].rolling(rules.long_trend_days * BARS_PER_DAY).mean()
        out[coin] = d
    return out


def run(prepared: dict[str, pd.DataFrame], p: bt.Params, rules: Rules, start: pd.Timestamp,
        capital: float = 1.0) -> tuple[pd.Series, list[dict]]:
    index = sorted(set().union(*(d.index[d.index >= start] for d in prepared.values())))
    frames = {c: d.reindex(index) for c, d in prepared.items()}
    coins = list(frames)
    col = lambda name: np.column_stack([frames[c][name].to_numpy(dtype=float) for c in coins])  # noqa: E731
    o, h, l, c, atr_v, mom = (col(k) for k in ("open", "high", "low", "close", "atr", "momentum"))
    cross = np.column_stack([frames[c]["cross_up"].fillna(False).to_numpy(dtype=bool) for c in coins])
    down = np.column_stack([frames[c]["trend_down"].fillna(False).to_numpy(dtype=bool) for c in coins])
    long_ok = (c > col("long_sma")) if rules.long_trend_days else np.ones_like(c, dtype=bool)

    cash = capital
    pos: dict[int, Position] = {}
    trades: list[dict] = []
    pending_exit: set[int] = set()
    pending_entry: list[tuple[int, float]] = []  # (монета, расстояние до стопа)
    last_close = np.full(len(coins), np.nan)
    equity = np.empty(len(index))

    def value() -> float:
        return cash + sum(q.qty * last_close[j] for j, q in pos.items())

    def close(j: int, px: float, t, reason: str) -> None:
        nonlocal cash
        q = pos.pop(j)
        cash += q.qty * px * (1 - rules.fee)
        trades.append({"coin": coins[j], "opened": q.opened, "closed": t, "entry": q.entry, "exit": px, "stop": q.stop, "qty": q.qty,
                       "reason": reason, "pnl": q.qty * (px - q.entry) - q.qty * (px + q.entry) * rules.fee})

    for i, t in enumerate(index):
        # 1) исполнение решений прошлой свечи
        for j in sorted(pending_exit):
            if j in pos and not np.isnan(o[i, j]):
                close(j, o[i, j], t, "signal")
        pending_exit = set()
        eq_now = value()
        for j, dist in pending_entry:
            if j in pos or np.isnan(o[i, j]) or dist <= 0 or len(pos) >= rules.max_positions:
                continue
            open_risk = sum(q.qty * max(0.0, q.entry - q.stop) for q in pos.values())
            risk_budget = min(eq_now * rules.risk, eq_now * rules.max_total_risk - open_risk)
            if risk_budget <= 0:
                continue
            qty = min(risk_budget / dist, eq_now * rules.max_position_pct / o[i, j], cash / (o[i, j] * (1 + rules.fee)))
            if qty * o[i, j] < 5e-3 * capital:  # слишком мелкая позиция — как у бота, пропуск
                continue
            cash -= qty * o[i, j] * (1 + rules.fee)
            pos[j] = Position(coins[j], qty, o[i, j], o[i, j] - dist, t)
        pending_entry = []

        # 2) стопы внутри свечи
        for j in list(pos):
            if not np.isnan(l[i, j]) and l[i, j] <= pos[j].stop:
                close(j, min(o[i, j], pos[j].stop), t, "stop")

        # 3) сигналы на закрытии
        valid = ~np.isnan(c[i])
        last_close[valid] = c[i, valid]
        if rules.trail_atr:
            for j, q in pos.items():
                if valid[j] and atr_v[i, j] > 0:
                    q.stop = max(q.stop, c[i, j] - rules.trail_atr * atr_v[i, j])
        for j in pos:
            if down[i, j]:
                pending_exit.add(j)
        candidates = [j for j in range(len(coins)) if cross[i, j] and j not in pos and atr_v[i, j] > 0 and long_ok[i, j]]
        if rules.positive_momentum:
            candidates = [j for j in candidates if mom[i, j] > 0]
        if rules.top_n:
            m = np.where(np.isnan(mom[i]), -np.inf, mom[i])
            top = set(np.argsort(-m)[: rules.top_n])
            candidates = [j for j in candidates if j in top]
        if rules.rank_entries:
            candidates.sort(key=lambda j: -(mom[i, j] if not np.isnan(mom[i, j]) else -np.inf))
        pending_entry = [(j, p.atr_mult * atr_v[i, j]) for j in candidates]
        equity[i] = value()

    return pd.Series(equity, index=pd.DatetimeIndex(index)), trades


def stats(equity: pd.Series, trades: list[dict]) -> dict:
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    total = equity.iloc[-1] / equity.iloc[0]
    rets = equity.resample("1D").last().pct_change().dropna()
    return {
        "return_%": (total - 1) * 100,
        "cagr_%": (total ** (1 / years) - 1) * 100,
        "max_dd_%": ((equity / equity.cummax()) - 1).min() * 100,
        "sharpe": rets.mean() / rets.std() * np.sqrt(365) if rets.std() > 0 else 0.0,
        "trades": len(trades),
        "per_month": len(trades) / (years * 12),
        "win_%": 100 * np.mean([t["pnl"] > 0 for t in trades]) if trades else 0.0,
    }
