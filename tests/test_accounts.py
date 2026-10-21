"""Счета владельца: основной (демо) и реальный — переключение, бот выключен по умолчанию, защита от «не того» счёта."""
import json
import urllib.request
from dataclasses import replace
from urllib.error import HTTPError

import pytest

from test_bot import FakeExchange, FakeTelegram, Recorder, cross_on_last_bar, init_data, trend_down_last_bar
from tradetrust import backtest as bt
from tradetrust.bot import api
from tradetrust.bot.accounts import REAL_TAG, Accounts, TaggedNotifier, check_key
from tradetrust.bot.config import Config
from tradetrust.bot.engine import Bot
from tradetrust.bot.store import Store


def make(cfg, ex, notifier):
    bot = Bot(cfg, ex, Store(cfg.db_path), notifier)
    bot.params = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=cfg.atr_mult, risk=cfg.risk_pct / 100)
    return bot


@pytest.fixture
def owner(tmp_path):
    """Основной счёт и реальный — как их собирает connect_real: режим «с подтверждением», бот выключен."""
    cfg = Config(env="demo", mode="auto", coins=["SOL"], ema_fast=3, ema_slow=6, db_path=str(tmp_path / "bot.db"),
                 telegram_chat_id="42", risk_pct=1.0, max_positions=5, max_total_risk_pct=5.0,
                 trend_filter=False, btc_filter=False)
    main_ex, real_ex, rec = FakeExchange(), FakeExchange(), Recorder()
    for ex in (main_ex, real_ex):
        ex.set("SOL", cross_on_last_bar())
    real_cfg = replace(cfg, env="mainnet", account="real", db_path=str(tmp_path / "real.db"), coins=["SOL"],
                       mode="confirm", capital_usdt=0.0, bot_enabled=False)
    main = make(cfg, main_ex, rec)
    real = make(real_cfg, real_ex, TaggedNotifier(rec, REAL_TAG))
    return Accounts(main, real), main_ex, real_ex, rec


def test_key_check_refuses_withdrawal_and_read_only():
    ok = {"readOnly": 0, "permissions": {"Spot": ["SpotTrade"], "Wallet": []}, "ips": ["148.135.203.10"]}
    assert check_key(ok) == ("", "")
    assert "вывод" in check_key({**ok, "permissions": {"Spot": ["SpotTrade"], "Wallet": ["Withdraw"]}})[0]
    assert "чтения" in check_key({**ok, "readOnly": 1})[0]
    assert "Спот" in check_key({**ok, "permissions": {"Spot": []}})[0]
    assert check_key({**ok, "ips": ["*"]}) == ("", check_key({**ok, "ips": []})[1])
    assert "IP" in check_key({**ok, "ips": ["*"]})[1]


def test_real_bot_is_off_and_silent_until_enabled_with_capital(owner):
    acc, main_ex, real_ex, rec = owner
    acc.real.on_candle_close()
    assert acc.real.store.position("SOL") is None and not acc.real.store.pending_proposals()
    assert not any(t.startswith(REAL_TAG) for t, _ in rec.sent)   # выключенный бот молчит
    with pytest.raises(ValueError, match="капитал"):
        acc.real.set_enabled(True)
    acc.real.update_settings({"capital_usdt": 300})
    assert acc.real.set_enabled(True) == "Бот включён"
    assert rec.sent[-1][0].startswith(REAL_TAG + "▶️ Бот включён")
    with pytest.raises(ValueError, match="всем балансом"):   # включённый — только со своим капиталом
        acc.real.update_settings({"capital_usdt": 0})
    with pytest.raises(ValueError):
        acc.real.reset_settings()
    assert acc.real.cfg.capital_usdt == 300
    acc.main.on_candle_close()
    assert acc.main.store.position("SOL") is not None and acc.real.store.position("SOL") is None  # счета раздельны


def test_switched_off_bot_still_exits_its_positions(owner):
    acc, main_ex, _, rec = owner
    bot = acc.main
    bot.on_candle_close()
    assert bot.store.position("SOL") is not None
    bot.set_enabled(False)
    assert "веду до конца" in rec.sent[-1][0]
    main_ex.set("SOL", trend_down_last_bar())
    bot.on_candle_close()
    assert bot.store.position("SOL") is None and bot.store.trades(1)[0]["reason"] == "signal"


def test_switching_off_cancels_pending_proposals(owner):
    acc, _, _, _ = owner
    bot = acc.main
    bot.set_mode("confirm")
    bot.on_candle_close()
    pid = bot.store.pending_proposals()[0].id
    bot.set_enabled(False)
    assert not bot.store.pending_proposals() and bot.confirm(pid).startswith("Уже обработано")


def test_active_account_switch_and_telegram_buttons_go_to_their_account(owner):
    acc, _, _, rec = owner
    assert acc.active() is acc.main and acc.info()["active"] == "main"
    acc.real.update_settings({"capital_usdt": 300})
    acc.real.set_enabled(True)
    acc.real.on_candle_close()
    real_prop = acc.real.store.pending_proposals()[0]
    assert rec.sent[-1][0].startswith(REAL_TAG) and real_prop.id in rec.sent[-1][1][0][0][1]
    tg = FakeTelegram()
    tg.bot, tg.accounts = acc.main, acc
    # активен основной, но кнопка «Купить» — под предложением реального счёта: покупает реальный
    tg.handle({"update_id": 1, "callback_query": {"id": "q", "data": f"buy:{real_prop.id}",
                                                  "message": {"chat": {"id": 42}}}})
    assert acc.real.store.position("SOL") is not None and acc.main.store.position("SOL") is None
    tg.handle({"update_id": 2, "message": {"chat": {"id": 42}, "text": "/account real", "from": {"id": 42}}})
    assert acc.active() is acc.real and "настоящие деньги" in tg.calls[-1][1]["text"]
    tg.handle({"update_id": 3, "message": {"chat": {"id": 42}, "text": "/status", "from": {"id": 42}}})
    assert "Реальный счёт Bybit" in tg.calls[-1][1]["text"]
    tg.handle({"update_id": 4, "message": {"chat": {"id": 42}, "text": "/account demo", "from": {"id": 42}}})
    assert acc.active() is acc.main
    with pytest.raises(ValueError):
        Accounts(acc.main).switch("real")


def test_api_switches_account_and_refuses_actions_on_a_stale_screen(owner):
    acc, _, real_ex, _ = owner
    server = api.serve(acc.main, "", 0, tg_token="123:ABC", owner_id="42", accounts=acc)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    auth = {"Authorization": "tma " + init_data()}

    def call(path, body=None, account=None):
        headers = {**auth, **({"X-Account": account} if account else {})}
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method="POST" if data else "GET", headers=headers)
        return json.loads(urllib.request.urlopen(req).read())

    try:
        status = call("/api/status")
        assert status["accounts"]["active"] == "main" and [a["id"] for a in status["accounts"]["list"]] == ["main", "real"]
        assert status["enabled"] is True
        assert call("/api/account", {"account": "real"})["message"] == "Счёт: Реальный счёт Bybit"
        status = call("/api/status")
        assert status["env"] == "mainnet" and status["enabled"] is False and status["accounts"]["list"][1]["real"]
        # на реальном счёте действие проходит, только если приложение знает, что оно на реальном
        for account in (None, "main"):
            with pytest.raises(HTTPError) as e:
                call("/api/order", {"coin": "SOL", "side": "buy", "usdt": 50}, account)
            assert e.value.code == 409
        assert real_ex.balances.get("SOL") is None
        assert call("/api/order", {"coin": "SOL", "side": "buy", "usdt": 50}, "real")["message"].startswith("🛒")
        assert real_ex.balances["SOL"] > 0
        with pytest.raises(HTTPError) as e:
            call("/api/bot", {"enabled": True}, "real")
        assert e.value.code == 400  # капитал бота не задан
        call("/api/settings", {"capital_usdt": 200}, "real")
        assert call("/api/bot", {"enabled": True}, "real")["message"] == "Бот включён"
        call("/api/account", {"account": "main"})
        with pytest.raises(HTTPError) as e:  # экран ещё показывает реальный, а счёт уже основной
            call("/api/pause", {}, "real")
        assert e.value.code == 409 and not acc.main.paused
        call("/api/pause", {}, "main")
        assert acc.main.paused
    finally:
        server.shutdown()


def test_demo_user_gets_no_account_switch(owner, tmp_path):
    acc, _, _, _ = owner
    server = api.serve(acc.main, "", 0, tg_token="123:ABC", owner_id="42", accounts=acc)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        req = urllib.request.Request(base + "/api/account", data=b'{"account":"real"}', method="POST",
                                     headers={"Authorization": "tma " + init_data(user_id=7)})
        with pytest.raises(HTTPError) as e:
            urllib.request.urlopen(req)
        assert e.value.code in (401, 403) and acc.active() is acc.main
    finally:
        server.shutdown()


def test_has_real_needs_both_keys_and_a_non_real_main_account():
    assert Config(real_api_key="k", real_api_secret="s").has_real
    assert not Config(env="mainnet", api_key="a", api_secret="b", real_api_key="k", real_api_secret="s").has_real
    with pytest.raises(ValueError):
        Config(real_api_key="k").validate()
