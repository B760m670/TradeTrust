"""Загрузка свечей с публичного API Binance (зеркало data-api.binance.vision).

Ключи API не нужны: это только рыночные данные. Свечи кэшируются в data/*.csv,
повторный запуск докачивает только новые.
"""
from __future__ import annotations

import time
from pathlib import Path

import pandas as pd
import requests

BASE_URL = "https://data-api.binance.vision/api/v3/klines"
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
INTERVAL_MS = {"1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
COLUMNS = ["open", "high", "low", "close", "volume"]


def _fetch(symbol: str, interval: str, start_ms: int, end_ms: int) -> list[list]:
    rows: list[list] = []
    while start_ms < end_ms:
        params = {"symbol": symbol, "interval": interval, "startTime": start_ms, "limit": 1000}
        for attempt in range(4):
            try:
                resp = requests.get(BASE_URL, params=params, timeout=30)
                resp.raise_for_status()
                break
            except requests.RequestException:
                if attempt == 3:
                    raise
                time.sleep(2 ** (attempt + 1))
        batch = resp.json()
        if not batch:
            break
        rows.extend(batch)
        start_ms = batch[-1][0] + INTERVAL_MS[interval]
        if len(batch) < 1000:
            break
    return rows


def load_candles(symbol: str, interval: str = "4h", since: str = "2021-01-01",
                 refresh: bool = True) -> pd.DataFrame:
    """OHLCV закрытых свечей, индекс — время открытия свечи (UTC)."""
    DATA_DIR.mkdir(exist_ok=True)
    path = DATA_DIR / f"{symbol}_{interval}.csv"
    cached = pd.read_csv(path, index_col=0, parse_dates=True) if path.exists() else None

    since_ms = int(pd.Timestamp(since, tz="UTC").timestamp() * 1000)
    if cached is not None and len(cached):
        cached.index = pd.to_datetime(cached.index, utc=True)
        first_ms = int(cached.index[0].timestamp() * 1000)
        start_ms = int(cached.index[-1].timestamp() * 1000) + INTERVAL_MS[interval]
        if first_ms > since_ms + INTERVAL_MS[interval]:
            cached, start_ms = None, since_ms  # кэш короче запрошенного — качаем заново
    else:
        start_ms = since_ms

    now_ms = int(time.time() * 1000)
    if refresh or cached is None:
        rows = _fetch(symbol, interval, start_ms, now_ms)
        # последняя свеча ещё не закрыта — отбрасываем
        rows = [r for r in rows if r[6] < now_ms]
        fresh = pd.DataFrame([r[:6] for r in rows], columns=["time", *COLUMNS])
        fresh["time"] = pd.to_datetime(fresh["time"], unit="ms", utc=True)
        fresh = fresh.set_index("time").astype(float)
        df = fresh if cached is None else pd.concat([cached, fresh])
    else:
        df = cached

    df = df[~df.index.duplicated(keep="last")].sort_index()
    df.to_csv(path)
    return df[df.index >= pd.Timestamp(since, tz="UTC")]
