#!/usr/bin/env python3
"""Нагрузка сервера по сервисам для админки бота: запускается на сервере раз в минуту (tradetrust-stats.timer)
и пишет JSON в botdata/host_stats.json. Контейнеру бота не нужен доступ к Docker — он только читает этот файл.

Docker-контейнеры — из `docker stats`, службы systemd — из cgroup (/sys/fs/cgroup/system.slice/*.service).
Процессор — доля всего сервера (100% — все ядра заняты), память — в МБ.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

CGROUP = Path("/sys/fs/cgroup/system.slice")
UNITS = {"B": 1, "KiB": 2**10, "MiB": 2**20, "GiB": 2**30, "kB": 1e3, "MB": 1e6, "GB": 1e9}
MIN_MB = 3  # мелочь не показываем


def size_mb(text: str) -> float:
    text = text.strip()
    for unit in sorted(UNITS, key=len, reverse=True):
        if text.endswith(unit):
            return float(text[: -len(unit)]) * UNITS[unit] / 2**20
    return 0.0


def services_snapshot() -> dict[str, tuple[int, int]]:
    out = {}
    for d in CGROUP.glob("*.service"):
        try:
            mem = int((d / "memory.current").read_text())
            usage = next(int(line.split()[1]) for line in (d / "cpu.stat").read_text().splitlines()
                         if line.startswith("usage_usec"))
        except (OSError, ValueError, StopIteration):
            continue
        out[d.name.removesuffix(".service")] = (mem, usage)
    return out


def services(cpus: int) -> list[dict]:
    a, t0 = services_snapshot(), time.time()
    time.sleep(1)
    b, dt = services_snapshot(), time.time() - t0
    rows = []
    for name, (mem, usage) in b.items():
        cpu = (usage - a.get(name, (0, usage))[1]) / (dt * 1e6) / cpus * 100
        rows.append({"name": name, "kind": "service", "mem_mb": round(mem / 2**20, 1), "cpu_pct": round(max(cpu, 0), 1)})
    return rows


def containers(cpus: int) -> list[dict]:
    try:
        out = subprocess.run(["docker", "stats", "--no-stream", "--format", "{{json .}}"],
                             capture_output=True, text=True, timeout=40).stdout
    except (OSError, subprocess.TimeoutExpired):
        return []
    rows = []
    for line in out.splitlines():
        try:
            d = json.loads(line)
            rows.append({"name": d["Name"], "kind": "docker", "mem_mb": round(size_mb(d["MemUsage"].split("/")[0]), 1),
                         # docker считает от одного ядра — переводим в долю всего сервера
                         "cpu_pct": round(float(d["CPUPerc"].rstrip("%")) / cpus, 1)})
        except (ValueError, KeyError):
            continue
    return rows


def main() -> None:
    target = Path(sys.argv[1])
    cpus = os.cpu_count() or 1
    rows = [r for r in containers(cpus) + services(cpus) if r["mem_mb"] >= MIN_MB or r["cpu_pct"] >= 1]
    rows.sort(key=lambda r: -r["mem_mb"])
    tmp = target.with_suffix(".tmp")
    tmp.write_text(json.dumps({"ts": int(time.time()), "cpus": cpus, "services": rows}, ensure_ascii=False))
    tmp.replace(target)  # бот не прочитает недописанный файл


if __name__ == "__main__":
    main()
