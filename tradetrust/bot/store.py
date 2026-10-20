"""Состояние бота в SQLite: открытые позиции, предложения сделок, журнал, настройки."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict, dataclass

SCHEMA = """
CREATE TABLE IF NOT EXISTS positions (
    coin TEXT PRIMARY KEY, symbol TEXT, qty REAL, entry REAL, stop REAL, stop_order_id TEXT,
    opened_at INTEGER, buy_order_id TEXT, risk_usdt REAL
);
CREATE TABLE IF NOT EXISTS proposals (
    id TEXT PRIMARY KEY, coin TEXT, symbol TEXT, price REAL, stop REAL, qty REAL, risk_usdt REAL,
    created_at INTEGER, expires_at INTEGER, status TEXT, message_id INTEGER
);
CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, coin TEXT, qty REAL, entry REAL, stop REAL, exit REAL,
    opened_at INTEGER, closed_at INTEGER, reason TEXT, pnl_usdt REAL, r REAL
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, level TEXT, text TEXT);
CREATE TABLE IF NOT EXISTS equity (ts INTEGER PRIMARY KEY, total REAL);
"""


@dataclass
class Position:
    coin: str
    symbol: str
    qty: float
    entry: float
    stop: float
    stop_order_id: str
    opened_at: int
    buy_order_id: str = ""
    risk_usdt: float = 0.0


@dataclass
class Proposal:
    id: str
    coin: str
    symbol: str
    price: float
    stop: float
    qty: float
    risk_usdt: float
    created_at: int
    expires_at: int
    status: str = "pending"   # pending | confirmed | rejected | expired | failed
    message_id: int | None = None


def now() -> int:
    return int(time.time())


class Store:
    def __init__(self, path: str):
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock:
            self.db.executescript(SCHEMA)

    def _all(self, sql: str, *args) -> list[sqlite3.Row]:
        with self.lock:
            return self.db.execute(sql, args).fetchall()

    def _exec(self, sql: str, *args) -> sqlite3.Cursor:
        with self.lock:
            return self.db.execute(sql, args)

    # --- настройки ---------------------------------------------------------
    def get(self, key: str, default=None):
        rows = self._all("SELECT value FROM kv WHERE key = ?", key)
        return json.loads(rows[0]["value"]) if rows else default

    def set(self, key: str, value) -> None:
        self._exec("INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                   key, json.dumps(value))

    # --- позиции -----------------------------------------------------------
    def positions(self) -> list[Position]:
        return [Position(**dict(r)) for r in self._all("SELECT * FROM positions ORDER BY opened_at")]

    def position(self, coin: str) -> Position | None:
        rows = self._all("SELECT * FROM positions WHERE coin = ?", coin)
        return Position(**dict(rows[0])) if rows else None

    def save_position(self, p: Position) -> None:
        d = asdict(p)
        self._exec(f"INSERT OR REPLACE INTO positions({','.join(d)}) VALUES({','.join('?' * len(d))})", *d.values())

    def close_position(self, p: Position, exit_price: float, reason: str, fee_usdt: float = 0.0) -> dict:
        pnl = (exit_price - p.entry) * p.qty - fee_usdt
        risk = (p.entry - p.stop) * p.qty
        r = pnl / risk if risk > 0 else None
        with self.lock:
            self.db.execute("BEGIN")
            self.db.execute("DELETE FROM positions WHERE coin = ?", (p.coin,))
            self.db.execute("INSERT INTO trades(coin, qty, entry, stop, exit, opened_at, closed_at, reason, pnl_usdt, r)"
                            " VALUES(?,?,?,?,?,?,?,?,?,?)",
                            (p.coin, p.qty, p.entry, p.stop, exit_price, p.opened_at, now(), reason, pnl, r))
            self.db.execute("COMMIT")
        return {"pnl": pnl, "r": r}

    def forget_position(self, coin: str) -> None:
        self._exec("DELETE FROM positions WHERE coin = ?", coin)

    # --- предложения ---------------------------------------------------------
    def save_proposal(self, p: Proposal) -> None:
        d = asdict(p)
        self._exec(f"INSERT OR REPLACE INTO proposals({','.join(d)}) VALUES({','.join('?' * len(d))})", *d.values())

    def proposal(self, pid: str) -> Proposal | None:
        rows = self._all("SELECT * FROM proposals WHERE id = ?", pid)
        return Proposal(**dict(rows[0])) if rows else None

    def pending_proposals(self) -> list[Proposal]:
        return [Proposal(**dict(r)) for r in self._all("SELECT * FROM proposals WHERE status = 'pending'")]

    def claim_proposal(self, pid: str, status: str) -> bool:
        """Атомарно переводит предложение из pending; False, если его уже обработали."""
        return self._exec("UPDATE proposals SET status = ? WHERE id = ? AND status = 'pending'",
                          status, pid).rowcount == 1

    def set_proposal_status(self, pid: str, status: str) -> None:
        self._exec("UPDATE proposals SET status = ? WHERE id = ?", status, pid)

    # --- журнал --------------------------------------------------------------
    def trades(self, limit: int = 50) -> list[dict]:
        return [dict(r) for r in self._all("SELECT * FROM trades ORDER BY closed_at DESC LIMIT ?", limit)]

    def realized_since(self, ts: int) -> float:
        rows = self._all("SELECT COALESCE(SUM(pnl_usdt), 0) AS s FROM trades WHERE closed_at >= ?", ts)
        return float(rows[0]["s"])

    def add_equity(self, ts: int, total: float) -> None:
        self._exec("INSERT OR REPLACE INTO equity(ts, total) VALUES(?, ?)", ts, total)

    def equity_history(self, since: int = 0) -> list[tuple[int, float]]:
        return [(r["ts"], r["total"]) for r in self._all("SELECT ts, total FROM equity WHERE ts >= ? ORDER BY ts", since)]

    def equity_before(self, ts: int) -> float | None:
        rows = self._all("SELECT total FROM equity WHERE ts <= ? ORDER BY ts DESC LIMIT 1", ts)
        return float(rows[0]["total"]) if rows else None

    def log(self, text: str, level: str = "info") -> None:
        self._exec("INSERT INTO events(ts, level, text) VALUES(?, ?, ?)", now(), level, text)

    def events(self, limit: int = 50) -> list[dict]:
        return [dict(r) for r in self._all("SELECT * FROM events ORDER BY id DESC LIMIT ?", limit)]
