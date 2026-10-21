"""Лонг на споте против «лонг + шорт на фьючерсе без плеча» на 25 монетах, свечи 4ч.

Запуск из корня репозитория: python -m scripts.long_short_study
Результат — reports/long_short.md. Плата за удержание шорта задаётся сценариями: полной
истории funding с 2022 года в открытом доступе нет, поэтому главный сценарий — пессимистичный.
"""
import sys
from pathlib import Path

import pandas as pd

from tradetrust import backtest as bt
from tradetrust import longshort as ls
from tradetrust.research import COINS, load_universe

START = pd.Timestamp("2022-01-01", tz="UTC")
YEARS = [("2022", "2022-01-01", "2023-01-01"), ("2023", "2023-01-01", "2024-01-01"),
         ("2024", "2024-01-01", "2025-01-01"), ("2025", "2025-01-01", "2026-01-01"), ("2026", "2026-01-01", None)]
VARIANTS = {
    "Только лонг (сейчас)": dict(short=False, costs=ls.Costs()),
    "Лонг + шорт, без платы": dict(short=True, costs=ls.Costs(funding_8h=0.0)),
    "Лонг + шорт, шорт получает 0,01%/8ч": dict(short=True, costs=ls.Costs(funding_8h=-0.0001)),
    "Лонг + шорт, шорт платит 0,01%/8ч": dict(short=True, costs=ls.Costs(funding_8h=0.0001)),
    "Только шорт, платит 0,01%/8ч": dict(short=True, long=False, costs=ls.Costs(funding_8h=0.0001)),
}
OUT = Path(__file__).resolve().parent.parent / "reports" / "long_short.md"


def fmt(x: float, sign: bool = True) -> str:
    return (f"{x:+.1f}" if sign else f"{x:.1f}").replace(".", ",").replace("-", "−")


def main() -> None:
    p = bt.Params()
    candles, _ = load_universe(COINS, "4h", "2021-06-01", refresh="--offline" not in sys.argv)
    prepared = {c: ls.prepare(df, p) for c, df in candles.items()}
    end = max(df.index[-1] for df in candles.values())
    lines = [f"# Лонг против лонг + шорт · 4ч · {len(prepared)} монет · {START:%d.%m.%Y}–{end:%d.%m.%Y}", "",
             "Риск 1% на сделку, стоп 2 ATR, без плеча. Комиссии: спот 0,1%, фьючерс 0,055% за сторону.", "",
             "| Вариант | Доход, медиана | Просадка, медиана | Монет в плюсе | Сделок в месяц (все монеты) | Корзина 25 монет: доход | Корзина: просадка |",
             "|---|---|---|---|---|---|---|"]
    yearly = {}
    for name, v in VARIANTS.items():
        rows, curves = [], []
        for coin, data in prepared.items():
            eq, deals = ls.run(data, p, v["costs"], long=v.get("long", True), short=v["short"], start=START)
            rows.append(ls.stats(eq, deals))
            curves.append(eq / eq.iloc[0])
        df = pd.DataFrame(rows)
        basket = pd.concat(curves, axis=1).ffill().fillna(1.0).mean(axis=1)
        b_ret = (basket.iloc[-1] - 1) * 100
        b_dd = ((basket / basket.cummax()) - 1).min() * 100
        lines.append(f"| {name} | {fmt(df['return_%'].median())}% | {fmt(df['max_dd_%'].median())}% | "
                     f"{(df['return_%'] > 0).sum()}/{len(df)} | {fmt(df['per_month'].sum(), False)} | "
                     f"{fmt(b_ret)}% | {fmt(b_dd)}% |")
        yearly[name] = {}
        for label, a, b in YEARS:
            seg = basket[(basket.index >= pd.Timestamp(a, tz="UTC")) &
                         ((basket.index < pd.Timestamp(b, tz="UTC")) if b else True)]
            if len(seg) > 1:
                yearly[name][label] = (seg.iloc[-1] / seg.iloc[0] - 1) * 100
    lines += ["", "## Корзина 25 монет по годам (равные доли)", "",
              "| Вариант | " + " | ".join(y for y, *_ in YEARS) + " |", "|---|" + "---|" * len(YEARS)]
    for name, ys in yearly.items():
        lines.append(f"| {name} | " + " | ".join(f"{fmt(ys[y])}%" if y in ys else "—" for y, *_ in YEARS) + " |")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
