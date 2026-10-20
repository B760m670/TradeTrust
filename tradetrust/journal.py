"""Журнал сделок (демо или реальных) в CSV и статистика по нему."""
from __future__ import annotations

from pathlib import Path

import pandas as pd

JOURNAL = Path(__file__).resolve().parent.parent / "journal.csv"
FIELDS = ["opened", "closed", "coin", "side", "entry", "stop", "exit", "qty", "fees",
          "followed_rules", "reason", "mistake"]


def load(path: Path = JOURNAL) -> pd.DataFrame:
    return pd.read_csv(path) if path.exists() else pd.DataFrame(columns=FIELDS)


def add(entry: dict, path: Path = JOURNAL) -> None:
    df = pd.concat([load(path), pd.DataFrame([{k: entry.get(k, "") for k in FIELDS}])], ignore_index=True)
    df.to_csv(path, index=False)


def stats(df: pd.DataFrame) -> dict:
    closed = df[pd.to_numeric(df["exit"], errors="coerce").notna()].copy()
    if closed.empty:
        return {"closed_trades": 0}
    for col in ("entry", "stop", "exit", "qty", "fees"):
        closed[col] = pd.to_numeric(closed[col], errors="coerce").fillna(0.0)
    sign = closed["side"].str.lower().map({"long": 1, "short": -1}).fillna(1)
    pnl = sign * (closed["exit"] - closed["entry"]) * closed["qty"] - closed["fees"]
    risk = (closed["entry"] - closed["stop"]).abs() * closed["qty"]
    r = (pnl / risk.where(risk > 0)).dropna()
    wins, losses = pnl[pnl > 0], pnl[pnl <= 0]
    return {
        "closed_trades": len(closed),
        "win_%": round(100 * len(wins) / len(closed), 1),
        "pnl_$": round(pnl.sum(), 2),
        "avg_win_$": round(wins.mean(), 2) if len(wins) else 0,
        "avg_loss_$": round(losses.mean(), 2) if len(losses) else 0,
        "profit_factor": round(wins.sum() / -losses.sum(), 2) if losses.sum() < 0 else None,
        "avg_R": round(r.mean(), 2) if len(r) else None,
        "rules_broken": int((closed["followed_rules"].astype(str).str.lower().isin(["no", "нет", "false", "0"])).sum()),
    }
