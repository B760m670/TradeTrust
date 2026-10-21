"""Админка владельца: состояние сервера и бота, последние ошибки."""
from __future__ import annotations

import collections
import logging
import os
import shutil
import time
from pathlib import Path

from . import bybit
from .engine import Bot, next_bar_close

STARTED_AT = time.time()


class ErrorLog(logging.Handler):
    """Последние предупреждения и ошибки из логов — чтобы видеть их в админке, а не только на сервере."""

    def __init__(self, size: int = 50):
        super().__init__(level=logging.WARNING)
        self.items: collections.deque = collections.deque(maxlen=size)

    def emit(self, record: logging.LogRecord) -> None:
        try:
            text = record.getMessage()
            if record.exc_info and record.exc_info[1] is not None:
                text += f": {record.exc_info[1]}"
            self.items.append({"ts": int(record.created), "level": record.levelname.lower(),
                               "source": record.name.removeprefix("tradetrust."), "text": text[:500]})
        except Exception:  # логирование не должно ломать бота
            pass

    def recent(self, n: int = 30) -> list[dict]:
        return list(self.items)[-n:][::-1]


ERRORS = ErrorLog()


def _meminfo() -> dict:
    """Память сервера (МБ) из /proc/meminfo; на других системах — пусто."""
    out = {}
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            key, value = line.split(":", 1)
            if key in ("MemTotal", "MemAvailable"):
                out[key] = int(value.split()[0]) // 1024
    except (OSError, ValueError):
        pass
    return out


def _rss_mb() -> float | None:
    try:
        for line in Path("/proc/self/status").read_text().splitlines():
            if line.startswith("VmRSS:"):
                return int(line.split()[1]) / 1024
    except (OSError, ValueError):
        pass
    return None


def _dir_mb(path: Path) -> float:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file()) / 2**20 if path.exists() else 0.0


def system_info(owner: Bot, telegram=None) -> dict:
    data_dir = Path(owner.cfg.db_path).resolve().parent
    disk = shutil.disk_usage(data_dir)
    mem = _meminfo()
    scan = owner.store.get("last_scan") or {}
    return {
        "version": os.environ.get("APP_VERSION", "dev")[:12], "built_at": os.environ.get("APP_BUILT_AT", ""),
        "started_at": int(STARTED_AT), "now": int(time.time()),
        "env": owner.cfg.env, "mode": owner.mode, "paused": owner.paused,
        "last_scan": scan.get("ts"), "next_scan": int(next_bar_close()),
        "bybit": {"ok_at": bybit.HEALTH["ok_at"], "error_at": bybit.HEALTH["error_at"], "error": bybit.HEALTH["error"]},
        "telegram": {"ok_at": getattr(telegram, "ok_at", None), "error": getattr(telegram, "error", "")},
        "memory": {"process_mb": _rss_mb(), "total_mb": mem.get("MemTotal"), "available_mb": mem.get("MemAvailable")},
        "disk": {"total_gb": disk.total / 2**30, "free_gb": disk.free / 2**30, "data_mb": _dir_mb(data_dir)},
        "errors": ERRORS.recent(),
    }
