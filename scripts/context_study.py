"""Обстановка на рынке как правило для бота: меньше риска (или пауза), когда рынок слабый, биткоин падает,
толпа в панике/эйфории, рядом заседание ФРС; самопроверка — меньше риска при просадке счёта.

База — стратегия v2 (все монеты, риск 0,3%, только монеты в росте за 120 дней). Правила подбираются на 2022–2024
и проверяются на 2025–2026, которые при подборе не использовались. Индекс страха и жадности — alternative.me
(data/fear_greed.json, https://api.alternative.me/fng/?limit=0).

Запуск: python -m scripts.context_study [--offline]. Результат — reports/context_study.md.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

from tradetrust import backtest as bt
from tradetrust import portfolio as pf
from tradetrust.research import COINS, load_universe

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / "context_study.md"
START = pd.Timestamp("2022-01-01", tz="UTC")
SPLIT = pd.Timestamp("2025-01-01", tz="UTC")
BASE = pf.Rules(risk=0.003, max_positions=25, max_total_risk=0.10, positive_momentum=True, momentum_days=120)
# решения ФРС (второй день заседания), объявление ~18:00 UTC
FOMC = """2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14
2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13
2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18
2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10
2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28 2026-12-09""".split()


def f(x: float, sign: bool = True) -> str:
    return (f"{x:+.1f}" if sign else f"{x:.2f}").replace(".", ",").replace("-", "−")


def seg_stats(eq: pd.Series) -> tuple[float, float, float]:
    rets = eq.resample("1D").last().pct_change().dropna()
    return ((eq.iloc[-1] / eq.iloc[0] - 1) * 100, ((eq / eq.cummax()) - 1).min() * 100,
            rets.mean() / rets.std() * np.sqrt(365) if rets.std() > 0 else 0.0)


def contexts(prepared: dict[str, pd.DataFrame], btc_daily: pd.DataFrame) -> dict[str, pd.Series]:
    index = pd.DatetimeIndex(sorted(set().union(*(d.index for d in prepared.values()))))
    up = pd.DataFrame({c: (d["ema_fast"] > d["ema_slow"]).where(d["ema_slow"].notna()) for c, d in prepared.items()}).reindex(index)
    mom = pd.DataFrame({c: (d["momentum"] > 0).where(d["momentum"].notna()) for c, d in prepared.items()}).reindex(index)
    btc = btc_daily["close"]
    fng = json.loads((ROOT / "data" / "fear_greed.json").read_text())["data"]
    fng = pd.Series({pd.Timestamp(int(x["timestamp"]), unit="s", tz="UTC"): float(x["value"]) for x in fng}).sort_index()
    fomc = pd.Series(False, index=index)
    for d in FOMC:  # с начала дня перед решением до конца дня решения
        day = pd.Timestamp(d, tz="UTC")
        fomc[(index >= day - pd.Timedelta(days=1)) & (index < day + pd.Timedelta(days=1))] = True
    # дневные значения биткоина известны только на закрытии дня → сдвиг на день
    btc_ok = {n: (btc > btc.rolling(n).mean()).shift(1).reindex(index, method="ffill") for n in (50, 100, 200)}
    return {"breadth": up.mean(axis=1), "breadth_mom": mom.mean(axis=1),
            "fng": fng.reindex(index, method="ffill"), "fomc": fomc, **{f"btc{n}": v for n, v in btc_ok.items()}}


def variants(ctx: dict[str, pd.Series]) -> dict[str, tuple[pf.Rules, pd.Series | None]]:
    one = lambda cond, k: pd.Series(np.where(cond.fillna(False).astype(bool), k, 1.0), index=cond.index)  # noqa: E731
    v: dict = {"База (стратегия v2)": (BASE, None)}
    for b in (0.2, 0.3, 0.4, 0.5):
        for k in (0.5, 0.0):
            v[f"Ширина < {b:.0%} монет в росте → риск ×{k:g}"] = (BASE, one(ctx["breadth"] < b, k))
            v[f"Монет в росте за 120 дн < {b:.0%} → риск ×{k:g}"] = (BASE, one(ctx["breadth_mom"] < b, k))
    for n in (50, 100, 200):
        for k in (0.5, 0.0):
            v[f"BTC ниже {n}-дн. средней → риск ×{k:g}"] = (BASE, one(ctx[f"btc{n}"] == False, k))  # noqa: E712
    for t in (15, 20, 25):
        v[f"Страх ≤ {t} → риск ×0,5"] = (BASE, one(ctx["fng"] <= t, 0.5))
        v[f"Страх ≤ {t} → риск ×1,5"] = (BASE, one(ctx["fng"] <= t, 1.5))
    for t in (75, 80, 85):
        v[f"Жадность ≥ {t} → риск ×0,5"] = (BASE, one(ctx["fng"] >= t, 0.5))
    v["ФРС: сутки до и день решения → не входить"] = (BASE, one(ctx["fomc"], 0.0))
    for cut in (0.10, 0.15, 0.20):
        v[f"Самопроверка: просадка > {cut:.0%} → риск ×0,5"] = (pf.Rules(**{**BASE.__dict__, "dd_cut": cut}), None)
    return v


def main() -> None:
    p = bt.Params()
    candles, btc_daily = load_universe(COINS, "4h", "2021-01-01", refresh="--offline" not in sys.argv)
    prepared = pf.prepare(candles, p, BASE)
    ctx = contexts(prepared, btc_daily)
    end = max(df.index[-1] for df in candles.values())
    lines = [f"# Обстановка на рынке · {len(candles)} монет · {START:%d.%m.%Y}–{end:%d.%m.%Y}", "",
             "База — стратегия v2. Подбор — 2022–2024, проверка — 2025–2026 (правила их «не видели»). "
             "Правило полезно, только если лучше базы в обоих периодах.", "",
             "| Правило | 2022–24 доход | просадка | Шарп | 2025–26 доход | просадка | Шарп |", "|---|---|---|---|---|---|---|"]
    for name, (rules, mult) in variants(ctx).items():
        eq, _ = pf.run(prepared, p, rules, START, risk_mult=mult)
        a, b = seg_stats(eq[eq.index < SPLIT]), seg_stats(eq[eq.index >= SPLIT - pd.Timedelta(hours=4)])
        lines.append(f"| {name} | {f(a[0])}% | {f(a[1])}% | {f(a[2], False)} | {f(b[0])}% | {f(b[1])}% | {f(b[2], False)} |")
        print(lines[-1], flush=True)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
