"""Сбор нагрузки сервера (deploy/host_stats.py) и её показ в админке."""
import importlib.util
import json
import time
from pathlib import Path

from tradetrust.bot import admin

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("host_stats", ROOT / "deploy" / "host_stats.py")
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)


def test_sizes_from_docker_stats():
    assert hs.size_mb("382.4MiB") == 382.4
    assert hs.size_mb("1.5GiB") == 1536
    assert round(hs.size_mb("11.47MB"), 2) == 10.94
    assert hs.size_mb("512KiB") == 0.5


def test_services_from_cgroups(tmp_path, monkeypatch):
    usage = {"caddy": [1_000_000, 1_500_000], "gloria-bot": [0, 0]}
    calls = {"n": 0}
    for name, mem in (("caddy", 31 * 2**20), ("gloria-bot", 6 * 2**20)):
        d = tmp_path / f"{name}.service"
        d.mkdir()
        (d / "memory.current").write_text(str(mem))
    (tmp_path / "docker-abc.scope").mkdir()  # контейнеры считает docker stats, не дублируем

    def snapshot_files():
        for name, u in usage.items():
            (tmp_path / f"{name}.service" / "cpu.stat").write_text(f"usage_usec {u[calls['n']]}\nuser_usec 1\n")
        calls["n"] += 1

    real = hs.services_snapshot
    monkeypatch.setattr(hs, "CGROUP", tmp_path)
    monkeypatch.setattr(hs, "services_snapshot", lambda: (snapshot_files(), real())[1])
    monkeypatch.setattr(hs.time, "sleep", lambda s: None)
    t = iter([100.0, 101.0])
    monkeypatch.setattr(hs.time, "time", lambda: next(t))
    rows = {r["name"]: r for r in hs.services(cpus=2)}
    assert set(rows) == {"caddy", "gloria-bot"}
    assert rows["caddy"]["mem_mb"] == 31 and rows["caddy"]["cpu_pct"] == 25.0  # 0,5 с из 1 с на 2 ядрах


def test_admin_reads_fresh_host_stats_with_friendly_names(tmp_path):
    assert admin.host_services(tmp_path) == {"ts": None, "services": []}
    (tmp_path / "host_stats.json").write_text(json.dumps({"ts": int(time.time()), "cpus": 2, "services": [
        {"name": "remnawave", "kind": "docker", "mem_mb": 382.4, "cpu_pct": 11.0},
        {"name": "something", "kind": "service", "mem_mb": 5, "cpu_pct": 0}]}))
    got = admin.host_services(tmp_path)
    assert got["fresh"] and [r["label"] for r in got["services"]] == ["Панель VPN (Remnawave)", "something"]
    old = json.loads((tmp_path / "host_stats.json").read_text())
    old["ts"] -= 3600
    (tmp_path / "host_stats.json").write_text(json.dumps(old))
    assert admin.host_services(tmp_path)["fresh"] is False


def test_cpu_info_measures_load():
    info = admin.cpu_info()
    assert info["cores"] >= 1 and len(info["load"]) == 3
    assert info["pct"] is None or 0 <= info["pct"] <= 100
