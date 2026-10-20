"""Текущее состояние системы по монетам: что делать на следующей свече."""
from __future__ import annotations

import pandas as pd

from . import backtest as bt
from .indicators import btc_regime


def check(candles: dict[str, pd.DataFrame], btc_daily: pd.DataFrame, p: bt.Params,
          deposit: float, use_filter: bool = True) -> pd.DataFrame:
    rows = []
    for coin, df in candles.items():
        regime = btc_regime(btc_daily, df.index) if use_filter else None
        data = bt.prepare(df, p, regime)
        res = bt.run(df, p, regime, prepared=data)
        last = data.iloc[-1]
        bar_close = data.index[-1] + (data.index[-1] - data.index[-2])
        price = last["close"]

        if res.open_trade and last["trend_down"]:
            action, detail = "ВЫХОД", "EMA fast ушла ниже slow — продать по открытию следующей свечи"
        elif res.open_trade:
            t = res.open_trade
            action = "ДЕРЖАТЬ"
            detail = f"вход {t.entry_time:%d.%m %H:%M} по {t.entry_price:.6g}, стоп {t.stop:.6g}"
        elif last["cross_up"] and last["regime_ok"]:
            stop_dist = p.atr_mult * last["atr"]
            stop = price - stop_dist
            qty = min(deposit * p.risk / stop_dist, deposit / price)
            action = "ВХОД"
            detail = (f"купить ~{qty:.6g} {coin} (~${qty * price:,.0f}) по рынку ~{price:.6g}, "
                      f"стоп {stop:.6g} (риск ${qty * stop_dist:,.2f})")
        elif last["cross_up"]:
            action, detail = "пропуск", "пересечение вверх, но BTC ниже 200-дневной SMA"
        else:
            trend = "вверх" if not last["trend_down"] else "вниз"
            action, detail = "ждать", f"тренд EMA {trend}, сигнала нет"

        rows.append({"coin": coin, "price": f"{price:.6g}", "action": action, "detail": detail,
                     "as_of_utc": f"{bar_close:%Y-%m-%d %H:%M}"})
    order = {"ВХОД": 0, "ВЫХОД": 1, "ДЕРЖАТЬ": 2, "пропуск": 3, "ждать": 4}
    return pd.DataFrame(rows).sort_values("action", key=lambda s: s.map(order)).reset_index(drop=True)
