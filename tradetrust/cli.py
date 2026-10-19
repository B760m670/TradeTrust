"""Командная строка: python -m tradetrust <команда> --help"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from . import backtest as bt
from . import journal, research, signals

REPORTS = Path(__file__).resolve().parent.parent / "reports"
pd.set_option("display.width", 200)
pd.set_option("display.max_columns", 20)
pd.set_option("display.max_colwidth", 90)


def _coins(arg: str | None) -> list[str]:
    return [c.strip().upper() for c in arg.split(",")] if arg else research.COINS


def _params(a) -> bt.Params:
    return bt.Params(fast=a.fast, slow=a.slow, atr_mult=a.atr_mult, risk=a.risk / 100, fee=a.fee / 100)


def _save(name: str, text: str) -> None:
    REPORTS.mkdir(exist_ok=True)
    path = REPORTS / f"{name}_{datetime.now(timezone.utc):%Y%m%d_%H%M}.md"
    path.write_text(text, encoding="utf-8")
    print(f"\nОтчёт: {path}")


def cmd_backtest(a) -> None:
    candles, btc = research.load_universe(_coins(a.coins), a.interval, a.since, not a.offline)
    p = _params(a)
    variants = {
        "hold": (p, False),
        "ema_all_in": (bt.Params(p.fast, p.slow, p.atr_period, p.atr_mult, p.risk, "all", p.fee), False),
        "ema_risk": (p, False),
        "ema_risk_btcfilter": (p, True),
    }
    table = research.compare(candles, btc, variants)
    by_variant = table.groupby("variant", sort=False).agg(
        median_return=("return_%", "median"), median_dd=("max_dd_%", "median"),
        coins_up=("return_%", lambda s: f"{(s > 0).sum()}/{len(s)}"), trades=("trades", "median"))
    pivot = table.pivot(index="coin", columns="variant", values="return_%")[list(variants)]
    print(by_variant.to_string(), "\n\nДоход по монетам, %:\n", pivot.to_string(), sep="")
    _save("backtest", f"# Бэктест {a.interval} с {a.since}\n\nПараметры: {p}\n\n"
          f"```\n{by_variant.to_string()}\n\n{pivot.to_string()}\n```\n")


def cmd_walkforward(a) -> None:
    candles, btc = research.load_universe(_coins(a.coins), a.interval, a.since, not a.offline)
    windows, total = research.walk_forward(candles, btc, _params(a), a.btc_filter, a.train, a.test)
    print(windows.to_string(index=False))
    print("\nСклеенный результат только на «невиданных» отрезках, %:")
    print(total.sort_values("oos_return_%", ascending=False).to_string(index=False))
    print(f"\nМедиана: {total['oos_return_%'].median():.1f}%, в плюсе {(total['oos_return_%'] > 0).sum()}/{len(total)}")
    _save("walkforward", f"# Walk-forward {a.interval} с {a.since}, train {a.train} мес / test {a.test} мес, "
          f"фильтр BTC: {a.btc_filter}\n\n```\n{windows.to_string(index=False)}\n\n{total.to_string(index=False)}\n```\n")


def cmd_signals(a) -> None:
    candles, btc = research.load_universe(_coins(a.coins), "4h", "2024-01-01", not a.offline)
    table = signals.check(candles, btc, _params(a), a.deposit, a.btc_filter)
    print(table.to_string(index=False))
    if a.only_actions:
        actionable = table[table["action"].isin(["ВХОД", "ВЫХОД"])]
        print("\nДействий нет." if actionable.empty else f"\nДЕЙСТВИЯ:\n{actionable.to_string(index=False)}")


def cmd_journal(a) -> None:
    if a.action == "add":
        journal.add({k: getattr(a, k) for k in journal.FIELDS if getattr(a, k, None) is not None})
        print("Записано.")
    df = journal.load()
    print(df.tail(20).to_string(index=False) if len(df) else "Журнал пуст.")
    print("\n", journal.stats(df) if len(df) else "", sep="")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="tradetrust", description="Бэктесты и сигналы трендовой системы EMA")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(sp, interval=True):
        sp.add_argument("--coins", help="через запятую, например BTC,ETH,SOL (по умолчанию 25 монет)")
        sp.add_argument("--fast", type=int, default=20)
        sp.add_argument("--slow", type=int, default=50)
        sp.add_argument("--atr-mult", type=float, default=2.0)
        sp.add_argument("--risk", type=float, default=1.0, help="риск на сделку, %% депозита")
        sp.add_argument("--fee", type=float, default=0.1, help="комиссия с каждой стороны, %%")
        sp.add_argument("--offline", action="store_true", help="не докачивать данные, брать из кэша")
        if interval:
            sp.add_argument("--interval", default="4h", choices=["1h", "4h", "1d"])
            sp.add_argument("--since", default="2021-01-01")

    sp = sub.add_parser("backtest", help="сравнить варианты системы на многих монетах")
    common(sp)
    sp.set_defaults(func=cmd_backtest)

    sp = sub.add_parser("walkforward", help="подбор на прошлом, проверка на следующем отрезке")
    common(sp)
    sp.add_argument("--train", type=int, default=12, help="месяцев на подбор")
    sp.add_argument("--test", type=int, default=6, help="месяцев на проверку")
    sp.add_argument("--btc-filter", action="store_true")
    sp.set_defaults(func=cmd_walkforward)

    sp = sub.add_parser("signals", help="что система говорит сейчас (4h)")
    common(sp, interval=False)
    sp.add_argument("--deposit", type=float, default=1000.0)
    sp.add_argument("--no-btc-filter", dest="btc_filter", action="store_false")
    sp.add_argument("--only-actions", action="store_true")
    sp.set_defaults(func=cmd_signals)

    sp = sub.add_parser("journal", help="журнал сделок: show | add")
    sp.add_argument("action", choices=["show", "add"], nargs="?", default="show")
    for f in journal.FIELDS:
        sp.add_argument(f"--{f.replace('_', '-')}", dest=f)
    sp.set_defaults(func=cmd_journal)

    a = ap.parse_args(argv)
    a.func(a)
