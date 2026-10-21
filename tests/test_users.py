"""Демо-счета пользователей: у каждого свой бумажный счёт, своя база и свой чат."""
import json
import urllib.request
from urllib.error import HTTPError

import pytest

from test_bot import FakeExchange, FakeTelegram, Recorder, cross_on_last_bar, init_data
from tradetrust import backtest as bt
from tradetrust.bot import api
from tradetrust.bot.__main__ import tick
from tradetrust.bot.config import Config
from tradetrust.bot.engine import Bot
from tradetrust.bot.store import Store
from tradetrust.bot.users import CachedMarket, Users


@pytest.fixture
def env(tmp_path):
    """Владелец (чат 42) и реестр демо-счетов на общей подделке рынка; уведомления — по чатам."""
    market = FakeExchange()
    market.set("SOL", cross_on_last_bar())
    cfg = Config(mode="confirm", coins=["SOL"], ema_fast=3, ema_slow=6, db_path=str(tmp_path / "bot.db"),
                 telegram_chat_id="42", risk_pct=1.0, max_positions=5, max_total_risk_pct=5.0,
                 trend_filter=False, btc_filter=False, max_users=2)
    owner = Bot(cfg, FakeExchange(), Store(cfg.db_path), Recorder())
    chats: dict[str, Recorder] = {}
    joined = []

    def notifier_for(chat_id):
        return chats.setdefault(chat_id, Recorder())

    users = Users(cfg, CachedMarket(market), tmp_path / "users", notifier_for, lambda b, n: joined.append(n))
    users._first_scan = lambda bot: None  # в тестах свечи прогоняем сами
    return owner, users, chats, joined, market


def short_params(bot):
    bot.params = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=bot.cfg.atr_mult, risk=bot.cfg.risk_pct / 100)
    return bot


def test_each_user_gets_own_paper_account(env, tmp_path):
    owner, users, chats, joined, _ = env
    ann = users.get(7, {"first_name": "Ann", "username": "ann"}, create=True)
    assert ann.cfg.env == "paper" and ann.cfg.mode == "auto" and ann.cfg.account == "demo"
    assert ann.equity()["total"] == pytest.approx(1000.0)
    assert chats["7"].sent[0][0].startswith("👋 Демо-счёт открыт: 1,000 виртуальных USDT")
    assert joined == [1] and ann.store.get("profile") == {"name": "Ann", "username": "ann"}
    assert users.get("7") is ann and users.get(7, create=True) is ann  # второй раз — тот же счёт
    assert users.get(8) is None                                          # без create не открывается
    assert users.get("42", create=True) is None                          # владелец — не демо-счёт
    assert users.get("abc", create=True) is None

    short_params(ann).on_candle_close()
    assert ann.store.position("SOL") is not None                          # купил сам на своём счёте
    assert owner.store.position("SOL") is None and not owner.store.get("signals")
    bob = short_params(users.get(8, create=True))
    assert bob.store.position("SOL") is None and bob.equity()["total"] == pytest.approx(1000.0)
    assert (tmp_path / "users" / "7.db").exists() and (tmp_path / "users" / "8.db").exists()


def test_limit_and_reopen_after_restart(env, tmp_path):
    owner, users, chats, joined, market = env
    users.get(7, create=True)
    users.get(8, create=True)
    assert users.get(9, create=True) is None  # мест нет (max_users=2)
    again = Users(owner.cfg, CachedMarket(market), tmp_path / "users")
    assert sorted(b.cfg.telegram_chat_id for b in again.all()) == ["7", "8"]
    assert "Демо-счетов: 2 из 2" in again.summary()


def test_cached_market_shares_requests():
    market = FakeExchange()
    market.set("SOL", cross_on_last_bar())
    calls = []
    original = market.candles
    market.candles = lambda *a: calls.append(a) or original(*a)
    cached = CachedMarket(market)
    cached.candles("SOLUSDT", "4h", 1000)
    cached.candles("SOLUSDT", "4h", 1000)
    assert len(calls) == 1 and cached.last_price("SOLUSDT") == market.prices["SOLUSDT"]


def test_api_opens_demo_account_for_any_telegram_user(env):
    owner, users, chats, _, _ = env
    server = api.serve(owner, "", 0, tg_token="123:ABC", owner_id="42", users=users)
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def get(user_id):
        req = urllib.request.Request(base + "/api/status", headers={"Authorization": "tma " + init_data(user_id=user_id)})
        return json.loads(urllib.request.urlopen(req).read())

    try:
        assert get(42)["account"] == "owner"
        mine = get(7)
        assert mine["account"] == "demo" and mine["env"] == "paper" and mine["equity"]["total"] == pytest.approx(1000)
        assert "7" in chats
        get(8)
        with pytest.raises(HTTPError) as e:  # мест больше нет
            get(9)
        assert e.value.code == 403 and "закончились" in json.loads(e.value.read())["error"]
        # смена режима на демо-счёте не трогает счёт владельца
        req = urllib.request.Request(base + "/api/mode", data=b'{"mode": "signals"}', method="POST",
                                     headers={"Authorization": "tma " + init_data(user_id=7)})
        urllib.request.urlopen(req)
        assert users.get(7).mode == "signals" and owner.mode == "confirm"
    finally:
        server.shutdown()


def test_telegram_start_opens_demo_and_routes_commands(env):
    owner, users, chats, _, _ = env
    tg = FakeTelegram()
    tg.webapp_url = "https://1-2-3-4.sslip.io"
    tg.bot, tg.users = owner, users
    chat = {"id": 7, "type": "private"}
    tg.handle({"update_id": 1, "message": {"chat": chat, "from": {"id": 7, "first_name": "Ann"}, "text": "/status"}})
    assert tg.calls[-1][1]["text"].startswith("Чтобы открыть демо-счёт") and users.get(7) is None
    tg.handle({"update_id": 2, "message": {"chat": chat, "from": {"id": 7, "first_name": "Ann"}, "text": "/start"}})
    assert users.get(7) is not None
    sent = tg.calls[-1][1]
    assert sent["chat_id"] == "7" and sent["reply_markup"]["inline_keyboard"][0][0]["web_app"]
    assert "/users" not in sent["text"]
    tg.handle({"update_id": 3, "message": {"chat": chat, "text": "/mode signals"}})
    assert users.get(7).mode == "signals" and owner.mode == "confirm"
    tg.handle({"update_id": 4, "message": {"chat": chat, "text": "/users"}})
    assert "Не понял команду" in tg.calls[-1][1]["text"]   # список пользователей — только владельцу
    tg.handle({"update_id": 5, "message": {"chat": {"id": -100, "type": "group"}, "text": "/start"}})
    assert users.get(-100) is None
    tg.handle({"update_id": 6, "message": {"chat": {"id": 42, "type": "private"}, "text": "/users"}})
    assert "Ann" in tg.calls[-1][1]["text"] and tg.calls[-1][1]["chat_id"] == "42"


def test_one_broken_account_does_not_stop_others(env):
    _, users, _, _, _ = env
    a, b = short_params(users.get(7, create=True)), short_params(users.get(8, create=True))
    a.reconcile = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
    tick([a, b], candle_closed=True)
    assert b.store.position("SOL") is not None


# --- админка владельца ---------------------------------------------------------

@pytest.fixture
def admin_env(env):
    owner, users, chats, joined, market = env
    users.admin_store = owner.store
    return owner, users, chats, market


def call(server, path, user_id=42, body=None):
    base = f"http://127.0.0.1:{server.server_address[1]}"
    req = urllib.request.Request(base + path, headers={"Authorization": "tma " + init_data(user_id=user_id)},
                                 data=None if body is None else json.dumps(body).encode(), method="GET" if body is None else "POST")
    return json.loads(urllib.request.urlopen(req).read())


def test_admin_is_owner_only_and_shows_users_and_system(admin_env):
    owner, users, _, _ = admin_env
    users.get(7, {"first_name": "Ann", "username": "ann"}, create=True)
    server = api.serve(owner, "", 0, tg_token="123:ABC", owner_id="42", users=users)
    try:
        assert call(server, "/api/status")["admin"] is True
        assert call(server, "/api/status", 7)["admin"] is False
        with pytest.raises(HTTPError) as e:
            call(server, "/api/admin", 7)
        assert e.value.code == 403
        with pytest.raises(HTTPError) as e:
            call(server, "/api/admin/broadcast", 7, {"text": "hi"})
        assert e.value.code == 403
        data = call(server, "/api/admin")
        row = data["users"][0]
        assert (row["id"], row["name"], row["username"]) == ("7", "Ann", "ann")
        assert row["equity"] == pytest.approx(1000) and row["joined_at"] and row["last_seen"]
        assert data["stats"]["total"] == 1 and data["stats"]["new_day"] == 1 and data["stats"]["signups"][-1]["count"] == 1
        assert data["settings"] == {"registration_open": True, "notify_new_users": False, "max_users": 2,
                                    "demo_start_usdt": 1000.0}
        sys = data["system"]
        assert {"version", "started_at", "last_scan", "next_scan", "bybit", "memory", "disk", "errors"} <= set(sys)
    finally:
        server.shutdown()


def test_admin_settings_close_registration_and_change_start_sum(admin_env):
    owner, users, chats, _ = admin_env
    server = api.serve(owner, "", 0, tg_token="123:ABC", owner_id="42", users=users)
    try:
        call(server, "/api/admin/settings", body={"registration_open": False})
        with pytest.raises(HTTPError) as e:
            call(server, "/api/status", 7)
        assert e.value.code == 403 and "Регистрация" in json.loads(e.value.read())["error"]
        call(server, "/api/admin/settings", body={"registration_open": True, "demo_start_usdt": 5000})
        assert call(server, "/api/status", 7)["equity"]["total"] == pytest.approx(5000)
        with pytest.raises(HTTPError) as e:
            call(server, "/api/admin/settings", body={"max_users": 0})
        assert e.value.code == 400
        with pytest.raises(HTTPError) as e:
            call(server, "/api/admin/settings", body={"api_key": "x"})
        assert e.value.code == 400
    finally:
        server.shutdown()


def test_admin_block_reset_delete(admin_env):
    owner, users, chats, _ = admin_env
    ann = short_params(users.get(7, {"first_name": "Ann"}, create=True))
    ann.on_candle_close()
    assert ann.store.position("SOL") is not None
    server = api.serve(owner, "", 0, tg_token="123:ABC", owner_id="42", users=users)
    try:
        call(server, "/api/admin/users/7/block", body={})
        with pytest.raises(HTTPError) as e:
            call(server, "/api/status", 7)
        assert e.value.code == 403 and "закрыт" in json.loads(e.value.read())["error"]
        assert call(server, "/api/admin")["users"][0]["blocked"] is True
        call(server, "/api/admin/users/7/unblock", body={})
        assert call(server, "/api/status", 7)["paused"] is None

        call(server, "/api/admin/users/7/reset", body={})
        fresh = users.get(7)
        assert fresh is not ann and fresh.store.position("SOL") is None
        assert fresh.equity()["total"] == pytest.approx(1000) and fresh.store.get("profile")["name"] == "Ann"
        assert chats["7"].sent[-1][0].startswith("🔄 Демо-счёт сброшен")

        call(server, "/api/admin/users/7/delete", body={})
        assert users.get(7) is None and not (users.dir / "7.db").exists()
        with pytest.raises(HTTPError) as e:
            call(server, "/api/admin/users/7/reset", body={})
        assert e.value.code == 404
    finally:
        server.shutdown()


def test_broadcast_skips_blocked_and_daily_line_replaces_new_user_messages(admin_env):
    owner, users, chats, _ = admin_env
    users.get(7, create=True)
    users.get(8, create=True)
    users.set_blocked("8", True)
    import time
    assert users.broadcast("Обновление!", sleep=0) == 1
    for _ in range(50):
        if any("Обновление" in t for t, _ in chats["7"].sent):
            break
        time.sleep(0.02)
    assert any(t == "📣 Обновление!" for t, _ in chats["7"].sent)
    assert not any("Обновление" in t for t, _ in chats["8"].sent)
    with pytest.raises(ValueError):
        users.broadcast("   ")
    owner.report_extras.append(users.daily_line)
    assert "Демо-счетов: 2 (+2 за сутки)" in owner.daily_report_text()


def test_error_log_and_bybit_health():
    import logging
    from tradetrust.bot import admin, bybit
    from test_bot import CaptureSession
    log = logging.getLogger("tradetrust.test")
    log.addHandler(admin.ERRORS)
    try:
        log.error("биржа не ответила")
    finally:
        log.removeHandler(admin.ERRORS)
    assert admin.ERRORS.recent()[0]["text"] == "биржа не ответила"
    from tradetrust.bot.bybit import BybitClient
    BybitClient("mainnet", session=CaptureSession({"list": [{"lastPrice": "1"}]})).last_price("SOLUSDT")
    assert bybit.HEALTH["ok_at"] is not None

    class Down:
        def request(self, *a, **k):
            raise ConnectionError("нет сети")
    with pytest.raises(ConnectionError):
        BybitClient("mainnet", session=Down()).last_price("SOLUSDT")
    assert "нет сети" in bybit.HEALTH["error"] and bybit.HEALTH["error_at"] >= bybit.HEALTH["ok_at"]
