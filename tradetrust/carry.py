"""Сбор платы за финансирование: купить монету на споте и продать столько же на бессрочном фьючерсе.

Цена монеты на итог почти не влияет (сколько теряет одна нога, столько получает другая); доход —
плата, которую каждые 8 часов шорт получает от лонга, когда ставка > 0 (и платит, когда < 0).

Модель (дневной шаг):
  * решение в начале дня D по средней ставке за прошлые lookback дней (то, что уже известно);
  * держим до max_coins монет с самой высокой средней; вход — если она выше enter (годовых),
    выход — если ниже exit или монета выпала из лучших;
  * на каждую монету — equity / max_coins / capital_per_notional: спот оплачивается полностью,
    под шорт нужна маржа 1/leverage;
  * комиссии тейкера: спот fee_spot, фьючерс fee_perp — на входе и выходе обеих ног;
  * базис: разница цен фьючерса и спота на входе и выходе (дневные закрытия) — тоже в результат.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class CarryRules:
    max_coins: int = 5
    lookback: int = 7          # дней для средней ставки
    enter: float = 0.10        # вход, если средняя ставка выше (годовых)
    exit: float = 0.0          # выход, если ниже (годовых)
    leverage: float = 3.0      # маржа под шорт = 1/leverage от позиции
    fee_spot: float = 0.001
    fee_perp: float = 0.00055
    min_hold: int = 0          # не выходить раньше, чем через столько дней (кроме ставки ниже exit)


def daily_funding(events: pd.Series) -> pd.Series:
    """Сумма ставок за день. Списание в 00:00 относится к прошедшему дню: держа позицию весь день D,
    получаешь списания 08:00, 16:00 дня D и 00:00 дня D+1."""
    return events.groupby((events.index - pd.Timedelta(minutes=1)).floor("1D")).sum()


def run(funding: dict[str, pd.Series], spot: dict[str, pd.Series], perp: dict[str, pd.Series],
        rules: CarryRules, start: pd.Timestamp, end: pd.Timestamp | None = None) -> tuple[pd.Series, list[dict]]:
    """funding — ставки по времени списания; spot/perp — дневные закрытия. Возвращает капитал и сделки."""
    coins = [c for c in funding if c in spot and c in perp]
    days = pd.date_range(start, end or min(daily_funding(funding[c]).index[-1] for c in coins), freq="1D", tz="UTC")
    rate = pd.DataFrame({c: daily_funding(funding[c]) for c in coins}).reindex(days)
    # средняя за прошлые дни, известная к началу дня D
    signal = pd.DataFrame({c: daily_funding(funding[c]) for c in coins}).rolling(rules.lookback).mean().shift(1)
    signal = signal.reindex(days) * 365
    # закрытие дня D−1 = цена в начале дня D
    s_px = pd.DataFrame({c: spot[c] for c in coins}).shift(1).reindex(days)
    p_px = pd.DataFrame({c: perp[c] for c in coins}).shift(1).reindex(days)
    per_notional = 1 + 1 / rules.leverage
    fee = rules.fee_spot + rules.fee_perp

    equity, cash_pnl = 1.0, 0.0
    held: dict[str, dict] = {}
    trades: list[dict] = []
    curve = np.empty(len(days))

    def close(c: str, i: int, why: str) -> None:
        nonlocal equity
        h = held.pop(c)
        sp, pp = s_px.iloc[i][c], p_px.iloc[i][c]
        if np.isnan(sp) or np.isnan(pp):
            sp, pp = h["spot"], h["perp"]
        basis = h["qty"] * ((sp - h["spot"]) - (pp - h["perp"]))  # лонг спот + шорт фьючерс
        cost = h["qty"] * (sp + pp) / 2 * fee
        equity += basis - cost
        trades.append({"coin": c, "opened": h["opened"], "closed": days[i], "funding": h["funding"],
                       "basis": basis, "fees": h["fees"] + cost, "reason": why,
                       "pnl": h["funding"] + basis - h["fees"] - cost})

    for i, d in enumerate(days):
        sig = signal.iloc[i]
        ranked = [c for c in sig.dropna().sort_values(ascending=False).index]
        best = set(ranked[: rules.max_coins])
        for c in list(held):
            age = (d - held[c]["opened"]).days
            if np.isnan(sig[c]) or sig[c] < rules.exit:
                close(c, i, "ставка упала")
            elif c not in best and age >= rules.min_hold and sig[c] < rules.enter:
                close(c, i, "есть лучше")
        for c in ranked:
            if len(held) >= rules.max_coins:
                break
            if c in held or sig[c] < rules.enter:
                continue
            sp, pp = s_px.iloc[i][c], p_px.iloc[i][c]
            if np.isnan(sp) or np.isnan(pp) or np.isnan(rate.iloc[i][c]):
                continue
            notional = equity / rules.max_coins / per_notional
            qty = notional / sp
            cost = qty * (sp + pp) / 2 * fee
            equity -= cost
            held[c] = {"qty": qty, "spot": sp, "perp": pp, "opened": d, "funding": 0.0, "fees": cost}
        # плата за день по позициям (на стоимость позиции по цене начала дня)
        for c, h in held.items():
            r, px = rate.iloc[i][c], p_px.iloc[i][c]
            if not np.isnan(r) and not np.isnan(px):
                got = h["qty"] * px * r
                h["funding"] += got
                equity += got
        curve[i] = equity
    for c in list(held):
        close(c, len(days) - 1, "конец теста")
    curve[-1] = equity
    return pd.Series(curve, index=days), trades


def stats(equity: pd.Series, trades: list[dict]) -> dict:
    years = max((equity.index[-1] - equity.index[0]).days / 365.25, 1e-9)
    total = equity.iloc[-1] / equity.iloc[0]
    rets = equity.pct_change().dropna()
    return {
        "return_%": (total - 1) * 100,
        "cagr_%": (total ** (1 / years) - 1) * 100,
        "max_dd_%": ((equity / equity.cummax()) - 1).min() * 100,
        "sharpe": rets.mean() / rets.std() * np.sqrt(365) if rets.std() > 0 else 0.0,
        "trades": len(trades),
        "fees_%": sum(t["fees"] for t in trades) * 100,
        "basis_%": sum(t["basis"] for t in trades) * 100,
    }
