"""Портфель как у бота (общий капитал, 5 позиций, 25% на монету, общий риск 5%) и идеи трендовых фондов:
отбор сильных монет (моментум), долгосрочный фильтр тренда, приоритет сильных при нехватке мест.

Запуск: python -m scripts.portfolio_study [--offline]. Результат — reports/portfolio_study.md.
"""
import sys
from pathlib import Path

import pandas as pd

from tradetrust import backtest as bt
from tradetrust import portfolio as pf
from tradetrust.research import COINS, load_universe

START = pd.Timestamp("2022-01-01", tz="UTC")
YEARS = ["2022", "2023", "2024", "2025", "2026"]
BOT = dict(risk=0.01, max_positions=5)                 # настройки бота сейчас
WIDE = dict(risk=0.003, max_positions=25, max_total_risk=0.10)  # все монеты, маленький риск
VARIANTS = {
    "Как сейчас: 5 позиций, риск 1%": pf.Rules(**BOT),
    "Как сейчас + подтягивать стоп 4 ATR": pf.Rules(**BOT, trail_atr=4),
    "Как сейчас + только монеты в росте за 120 дн": pf.Rules(**BOT, positive_momentum=True, momentum_days=120),
    "Все монеты, риск 0,3%": pf.Rules(**WIDE),
    "Все монеты, риск 0,3% + подтягивать стоп 4 ATR": pf.Rules(**WIDE, trail_atr=4),
    "Все монеты, риск 0,3% + только в росте за 120 дн": pf.Rules(**WIDE, positive_momentum=True, momentum_days=120),
    "Все монеты, риск 0,3% + цена выше 150-дн. средней": pf.Rules(**WIDE, long_trend_days=150),
}
# фильтр долгосрочного тренда с разными окнами: если хорош только один — это подгонка, а не закономерность
ROBUST = {f"Все, 0,3% + в росте за {d} дн": pf.Rules(**WIDE, positive_momentum=True, momentum_days=d) for d in (30, 60, 90, 120, 180)}
ROBUST |= {f"Все, 0,3% + выше {d}-дн. средней": pf.Rules(**WIDE, long_trend_days=d) for d in (100, 150, 200)}
OUT = Path(__file__).resolve().parent.parent / "reports" / "portfolio_study.md"


def f(x: float, sign: bool = True) -> str:
    return (f"{x:+.1f}" if sign else f"{x:.1f}").replace(".", ",").replace("-", "−")


def table(variants: dict, candles: dict, p: bt.Params) -> list[str]:
    rows = ["| Вариант | Доход | В год | Просадка | Шарп | Сделок/мес | Прибыльных | " + " | ".join(YEARS) + " |",
            "|---|---|---|---|---|---|---|" + "---|" * len(YEARS)]
    for name, rules in variants.items():
        eq, trades = pf.run(pf.prepare(candles, p, rules), p, rules, START)
        s = pf.stats(eq, trades)
        years = []
        for y in YEARS:
            seg = eq[str(y)]
            years.append(f"{f((seg.iloc[-1] / seg.iloc[0] - 1) * 100)}%" if len(seg) > 1 else "—")
        rows.append(f"| {name} | {f(s['return_%'])}% | {f(s['cagr_%'])}% | {f(s['max_dd_%'])}% | "
                    f"{f(s['sharpe'], False)} | {f(s['per_month'], False)} | {f(s['win_%'], False)}% | " + " | ".join(years) + " |")
        print(rows[-1], flush=True)
    return rows


def main() -> None:
    p = bt.Params()
    candles, _ = load_universe(COINS, "4h", "2021-01-01", refresh="--offline" not in sys.argv)
    end = max(df.index[-1] for df in candles.values())
    lines = [f"# Портфель как у бота · {len(candles)} монет · 4ч · {START:%d.%m.%Y}–{end:%d.%m.%Y}", "",
             "Общий капитал, стоп 2 ATR, не больше 25% капитала в монете, комиссия 0,1%. «Как сейчас» — лимиты бота: "
             "5 позиций, риск 1%, общий риск 5%. Шарп — доходность к колебаниям (больше — ровнее).", "", "## Варианты", ""]
    lines += table(VARIANTS, candles, p)
    lines += ["", "## Устойчивость: то же с другими окнами", ""]
    lines += table(ROBUST, candles, p)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
