from __future__ import annotations

import pandas as pd


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period, min_periods=period).mean()


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Средний истинный диапазон (сглаживание Уайлдера)."""
    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"] - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def btc_regime(btc_daily: pd.DataFrame, index: pd.DatetimeIndex, period: int = 200) -> pd.Series:
    """True, если BTC закрыл предыдущий день выше SMA(period).

    Значение дня D становится известно только после его закрытия, поэтому
    сдвигаем на сутки вперёд — иначе в тест попадёт заглядывание в будущее.
    """
    above = btc_daily["close"] > sma(btc_daily["close"], period)
    above.index = above.index + pd.Timedelta(days=1)
    return above.reindex(index, method="ffill").fillna(False).astype(bool)
