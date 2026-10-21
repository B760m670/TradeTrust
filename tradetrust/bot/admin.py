"""Админка владельца: состояние сервера и бота, последние ошибки."""
from __future__ import annotations

import collections
import json
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
            if key in ("MemTotal", "MemAvailable", "SwapTotal", "SwapFree"):
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


_last_cpu: tuple[float, float, float] | None = None  # (время, простой, всего) с прошлого запроса


def _cpu_times() -> tuple[float, float] | None:
    """Суммарное время процессора из /proc/stat — оно общее для всего сервера, даже изнутри Docker."""
    try:
        values = [float(x) for x in Path("/proc/stat").read_text().splitlines()[0].split()[1:]]
    except (OSError, ValueError, IndexError):
        return None
    idle = values[3] + (values[4] if len(values) > 4 else 0)  # idle + iowait
    return idle, sum(values)


def cpu_info() -> dict:
    """Загрузка процессора сейчас (с прошлого запроса или за полсекунды) и средняя за 1/5/15 минут."""
    global _last_cpu
    now = _cpu_times()
    prev = _last_cpu[1:] if _last_cpu and time.time() - _last_cpu[0] >= 1 else None
    if now and prev is None:  # первый запрос или слишком частый — меряем полсекунды
        time.sleep(0.5)
        prev, now = now, _cpu_times()
    pct = None
    if now and prev and now[1] > prev[1]:
        pct = round(100 * (1 - (now[0] - prev[0]) / (now[1] - prev[1])), 1)
    if now:
        _last_cpu = (time.time(), *now)
    try:
        load = [float(x) for x in Path("/proc/loadavg").read_text().split()[:3]]
    except (OSError, ValueError):
        load = []
    return {"pct": pct, "load": load, "cores": os.cpu_count() or 1}


# как называть сервисы в админке; остальные — как есть
SERVICE_NAMES = {
    "tradetrust-bot-1": "TradeTrust: бот и приложение", "remnawave": "Панель VPN (Remnawave)",
    "remnanode": "VPN-узел", "remnawave-db": "База панели VPN", "remnawave-redis": "Кэш панели VPN",
    "caddy": "Caddy: сайт и HTTPS", "containerd": "Docker (containerd)", "docker": "Docker", "gloria-bot": "Бот VPN (gloria)",
    "fail2ban": "Защита от взлома (fail2ban)", "ssh": "SSH", "systemd-journald": "Системные логи",
}
HOST_STATS_FRESH = 300  # файл старше 5 минут — сбор на сервере не работает


def host_services(data_dir: Path) -> dict:
    """Нагрузка по сервисам из botdata/host_stats.json (пишет deploy/host_stats.py на сервере раз в минуту)."""
    try:
        raw = json.loads((data_dir / "host_stats.json").read_text())
    except (OSError, ValueError):
        return {"ts": None, "services": []}
    rows = [{**r, "label": SERVICE_NAMES.get(r.get("name", ""), r.get("name", ""))} for r in raw.get("services", [])]
    return {"ts": raw.get("ts"), "fresh": time.time() - (raw.get("ts") or 0) < HOST_STATS_FRESH, "services": rows}


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
        "memory": {"process_mb": _rss_mb(), "total_mb": mem.get("MemTotal"), "available_mb": mem.get("MemAvailable"),
                   "swap_total_mb": mem.get("SwapTotal"), "swap_free_mb": mem.get("SwapFree")},
        "cpu": cpu_info(),
        "host": host_services(data_dir),
        "disk": {"total_gb": disk.total / 2**30, "free_gb": disk.free / 2**30, "data_mb": _dir_mb(data_dir)},
        "errors": ERRORS.recent(),
    }
