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
