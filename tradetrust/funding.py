"""История платы за финансирование (funding) и дневных цен бессрочных фьючерсов USDT.

Источник — открытые архивы Binance (data.binance.vision): у Bybit публичной истории за годы нет,
а ставки крупных бирж почти совпадают — для проверки идеи этого достаточно. Месячные архивы,
текущий месяц — дневными. Кэш — data/funding/.
"""
from __future__ import annotations

import io
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

import pandas as pd

from .data import DATA_DIR

BASE = "https://data.binance.vision/data/futures/um"
DIR = DATA_DIR / "funding"


def _zip_csv(url: str) -> pd.DataFrame | None:
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            raw = r.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None  # монеты ещё не было или месяц не выложен
        raise
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        with z.open(z.namelist()[0]) as f:
            head = f.read(64).decode()
        with z.open(z.namelist()[0]) as f:
            # в старых архивах нет строки заголовков
            return pd.read_csv(f, header=0 if head[:1].isalpha() else None)


def _months(since: str, until: pd.Timestamp) -> list[str]:
    return [m.strftime("%Y-%m") for m in pd.period_range(since, until - pd.offsets.MonthBegin(1), freq="M")]


def _load(kind: str, symbol: str, since: str, parse) -> pd.Series | pd.DataFrame:
    DIR.mkdir(parents=True, exist_ok=True)
    path = DIR / f"{symbol}_{kind}.pkl"
    now = pd.Timestamp.now(tz="UTC").tz_localize(None)
    cached = pd.read_pickle(path) if path.exists() else None
    done = set() if cached is None else set(cached.attrs.get("months", []))
    parts, months = ([] if cached is None else [cached]), list(done)
    for m in _months(since, now):
        if m in done:
            continue
        name = (f"{BASE}/monthly/fundingRate/{symbol}/{symbol}-fundingRate-{m}.zip" if kind == "funding"
                else f"{BASE}/monthly/klines/{symbol}/1d/{symbol}-1d-{m}.zip")
        df = _zip_csv(name)
        if df is not None:
            parts.append(parse(df))
        months.append(m)
    out = pd.concat(parts).sort_index() if parts else pd.Series(dtype=float)
    out = out[~out.index.duplicated()]
    out.attrs["months"] = sorted(months)
    out.to_pickle(path)
    return out


def _parse_funding(df: pd.DataFrame) -> pd.Series:
    t, rate = df.iloc[:, 0], df.iloc[:, 2]  # calc_time, funding_interval_hours, last_funding_rate
    return pd.Series(rate.astype(float).to_numpy(), index=pd.to_datetime(t.astype("int64"), unit="ms", utc=True))


def _parse_klines(df: pd.DataFrame) -> pd.Series:
    return pd.Series(df.iloc[:, 4].astype(float).to_numpy(), index=pd.to_datetime(df.iloc[:, 0].astype("int64"), unit="ms", utc=True))


def load_funding(coin: str, since: str = "2022-01") -> pd.Series:
    """Ставки финансирования по времени списания (доля от позиции; > 0 — шорт получает)."""
    return _load("funding", f"{coin}USDT", since, _parse_funding)


def load_perp_daily(coin: str, since: str = "2022-01") -> pd.Series:
    """Дневные цены закрытия бессрочного фьючерса — для разницы с ценой спота (базиса)."""
    return _load("perp1d", f"{coin}USDT", since, _parse_klines)
