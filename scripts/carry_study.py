"""Сбор платы за финансирование (спот + шорт фьючерса) на 25 монетах, 2022–2026.

Ставки и цены фьючерсов — архивы Binance (tradetrust/funding.py), спот — те же 4ч свечи, что у бота.
Запуск: python -m scripts.carry_study [--offline]. Результат — reports/carry_study.md.
"""
import sys
from pathlib import Path

import pandas as pd

from tradetrust import carry as cr
from tradetrust.funding import load_funding, load_perp_daily
from tradetrust.research import COINS, load_universe

OUT = Path(__file__).resolve().parent.parent / "reports" / "carry_study.md"
START = pd.Timestamp("2022-01-15", tz="UTC")
SPLIT = pd.Timestamp("2025-01-01", tz="UTC")
VARIANTS = {"Все 25 монет всегда": cr.CarryRules(max_coins=25, enter=-9, exit=-9)}
VARIANTS |= {f"Все 25, вход при ставке > {en:.0%}, выход < {ex:.0%}, средняя {lb} дн": cr.CarryRules(max_coins=25, lookback=lb, enter=en, exit=ex)
             for lb in (7, 14, 30) for en, ex in ((0.0, -0.05), (0.05, 0.0))}
VARIANTS |= {f"Лучшие {k}, вход > 10%, средняя {lb} дн": cr.CarryRules(max_coins=k, lookback=lb, enter=0.10, exit=0.0)
             for k in (3, 10) for lb in (7, 14)}


def f(x: float) -> str:
    return f"{x:+.1f}".replace(".", ",").replace("-", "−")


def main() -> None:
    candles, _ = load_universe(COINS, "4h", "2021-01-01", refresh="--offline" not in sys.argv)
    spot = {c: df["close"].resample("1D").last() for c, df in candles.items()}
    funding = {c: load_funding(c) for c in spot}
    perp = {c: load_perp_daily(c) for c in spot}
    years = range(2022, 2027)
    lines = ["# Сбор платы за финансирование · 25 монет · 2022–2026", "",
             "Спот куплен, столько же продано на фьючерсе (маржа 1/3), комиссии тейкера 0,1% + 0,055% на каждой ноге, "
             "решение раз в день по средней ставке за прошлые дни.", "",
             "| Вариант | В год | Просадка | 2022–24 | 2025–26 | Сделок | Комиссии | " + " | ".join(map(str, years)) + " |",
             "|---|---|---|---|---|---|---|" + "---|" * len(years)]
    for name, rules in VARIANTS.items():
        eq, trades = cr.run(funding, spot, perp, rules, START)
        s = cr.stats(eq, trades)
        a, b = eq[eq.index < SPLIT], eq[eq.index >= SPLIT]
        ys = [eq[eq.index.year == y] for y in years]
        lines.append(f"| {name} | {f(s['cagr_%'])}% | {f(s['max_dd_%'])}% | {f((a.iloc[-1] / a.iloc[0] - 1) * 100)}% | "
                     f"{f((b.iloc[-1] / b.iloc[0] - 1) * 100)}% | {s['trades']} | {f(-s['fees_%'])}% | "
                     + " | ".join(f"{f((y.iloc[-1] / y.iloc[0] - 1) * 100)}%" for y in ys) + " |")
        print(lines[-1], flush=True)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
