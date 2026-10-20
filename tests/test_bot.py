import hashlib
import hmac
import json
import threading
import urllib.request
from decimal import Decimal
from urllib.error import HTTPError

import numpy as np
import pandas as pd
import pytest

from tradetrust import backtest as bt
from tradetrust.bot import api
from tradetrust.bot.bybit import BybitClient, Fill, Instrument
from tradetrust.bot.config import Config
from tradetrust.bot.engine import Bot, next_bar_close
from tradetrust.bot.store import Store
from tradetrust.bot.telegram import Telegram


# --- поддельная биржа --------------------------------------------------------

def candles(closes, start="2026-01-01", spread=0.05):
    closes = np.asarray(closes, dtype=float)
    idx = pd.date_range(start, periods=len(closes), freq="4h", tz="UTC")
    opens = np.r_[closes[0], closes[:-1]]
    return pd.DataFrame({"open": opens, "high": np.maximum(opens, closes) * (1 + spread),
                         "low": np.minimum(opens, closes) * (1 - spread), "close": closes, "volume": 1.0}, index=idx)


def cross_on_last_bar():
    full = candles([100.0] * 20 + list(np.linspace(100, 200, 40)))
    p = bt.Params(fast=3, slow=6, atr_period=3)
    i = int(np.argmax(bt.prepare(full, p)["cross_up"].to_numpy()))
    return full.iloc[: i + 1]


def trend_down_last_bar():
    return candles([100.0] * 20 + list(np.linspace(100, 200, 30)) + list(np.linspace(200, 150, 10)))


class FakeExchange:
    def __init__(self, usdt=1000.0):
        self.data = {}
        self.prices = {}
        self.balances = {"USDT": usdt}
        self.stops = {}
        self.fail_stop = False
        self.n = 0
        self.inst = Instrument("X", Decimal("0.001"), Decimal("0.01"), Decimal("5"), Decimal("1e9"))

    def set(self, coin, df, price=None):
        self.data[f"{coin}USDT"] = df
        self.prices[f"{coin}USDT"] = float(df["close"].iloc[-1]) if price is None else price

    def candles(self, symbol, interval, limit=1000):
        if symbol not in self.data:
            raise RuntimeError("no data")
        return self.data[symbol]

    def last_price(self, symbol):
        return self.prices[symbol]

    def instrument(self, symbol):
        return self.inst

    def balance(self, coin):
        return self.balances.get(coin, 0.0)

    def market_buy(self, symbol, coin, qty):
        price = self.prices[symbol]
        self.balances["USDT"] -= float(qty) * price
        got = float(qty) * 0.999
        self.balances[coin] = self.balances.get(coin, 0.0) + got
        self.n += 1
        return Fill(f"b{self.n}", got, price, 0.0)

    def market_sell(self, symbol, qty):
        coin = symbol.removesuffix("USDT")
        price = self.prices[symbol]
        self.balances[coin] -= float(qty)
        self.balances["USDT"] += float(qty) * price
        self.n += 1
        return Fill(f"s{self.n}", float(qty), price, 0.0)

    def place_stop(self, symbol, qty, trigger):
        if self.fail_stop:
            raise RuntimeError("stop rejected")
        self.n += 1
        oid = f"st{self.n}"
        self.stops[oid] = {"symbol": symbol, "qty": float(qty), "trigger": float(trigger), "status": "open"}
        return oid

    def stop_state(self, symbol, oid):
        s = self.stops.get(oid)
        if s is None or s["status"] == "cancelled":
            return "gone", None
        if s["status"] == "open" and self.prices[symbol] <= s["trigger"]:
            fill = self.market_sell(symbol, Decimal(str(s["qty"])))
            s["status"] = "filled"
            s["fill"] = fill
        if s["status"] == "filled":
            return "filled", s["fill"]
        return "open", None

    def cancel_stop(self, symbol, oid):
        if oid in self.stops and self.stops[oid]["status"] == "open":
            self.stops[oid]["status"] = "cancelled"


class Recorder:
    def __init__(self):
        self.sent, self.edits = [], []

    def send(self, text, buttons=None):
        self.sent.append((text, buttons))
        return len(self.sent)

    def edit(self, mid, text):
        self.edits.append((mid, text))


@pytest.fixture
def make_bot(tmp_path):
    def _make(mode="auto", coins=("SOL",), **kw):
        cfg = Config(mode=mode, coins=list(coins), ema_fast=3, ema_slow=6, db_path=str(tmp_path / "bot.db"), **kw)
        ex, rec = FakeExchange(), Recorder()
        bot = Bot(cfg, ex, Store(cfg.db_path), rec)
        bot.params = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=cfg.atr_mult, risk=cfg.risk_pct / 100)
        return bot, ex, rec
    return _make


# --- клиент Bybit --------------------------------------------------------------

class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class CaptureSession:
    def __init__(self, result):
        self.result, self.calls = result, []

    def request(self, method, url, data=None, headers=None, timeout=None):
        self.calls.append((method, url, data, headers))
        return FakeResponse({"retCode": 0, "retMsg": "OK", "result": self.result})


def test_post_signature_covers_exact_body():
    s = CaptureSession({"orderId": "1"})
    c = BybitClient("mainnet", "KEY", "SECRET", session=s)
    c.place_order(symbol="SOLUSDT", side="Buy", orderType="Market", qty="1.5", marketUnit="baseCoin")
    method, url, body, h = s.calls[0]
    assert url == "https://api.bybit.com/v5/order/create"
    sent = json.loads(body)
    assert sent["category"] == "spot" and sent["isLeverage"] == 0 and sent["marketUnit"] == "baseCoin"
    expected = hmac.new(b"SECRET", (h["X-BAPI-TIMESTAMP"] + "KEY" + "5000" + body).encode(), hashlib.sha256).hexdigest()
    assert h["X-BAPI-SIGN"] == expected


def test_get_signature_covers_query():
    s = CaptureSession({"list": []})
    c = BybitClient("demo", "KEY", "SECRET", session=s)
    c.wallet(["USDT"])
    _, url, _, h = s.calls[0]
    assert url == "https://api-demo.bybit.com/v5/account/wallet-balance?accountType=UNIFIED&coin=USDT"
    expected = hmac.new(b"SECRET", (h["X-BAPI-TIMESTAMP"] + "KEY5000accountType=UNIFIED&coin=USDT").encode(),
                        hashlib.sha256).hexdigest()
    assert h["X-BAPI-SIGN"] == expected


def test_error_code_raises():
    class Err(CaptureSession):
        def request(self, *a, **k):
            return FakeResponse({"retCode": 170131, "retMsg": "Balance insufficient"})
    with pytest.raises(Exception, match="170131"):
        BybitClient("mainnet", "K", "S", session=Err(None)).place_order(symbol="X", side="Buy", orderType="Market", qty="1")


def test_candles_sorted_and_unclosed_dropped():
    now_ms = int(pd.Timestamp.now(tz="UTC").timestamp() * 1000)
    bar = 4 * 3_600_000
    start = now_ms // bar * bar  # текущая, ещё не закрытая свеча
    rows = [[str(start - k * bar), "1", "2", "0.5", str(10 + k), "1", "1"] for k in range(3)]  # обратный порядок
    c = BybitClient("mainnet", session=CaptureSession({"list": rows}))
    df = c.candles("SOLUSDT", "4h")
    assert len(df) == 2 and df.index.is_monotonic_increasing
    assert df["close"].tolist() == [12.0, 11.0]


def test_instrument_rounding():
    inst = Instrument("X", Decimal("0.001"), Decimal("0.01"), Decimal("5"), Decimal("1e9"))
    assert inst.floor_qty(1.23456) == Decimal("1.234")
    assert inst.stop_price(0.17909) == Decimal("0.18")


def test_next_bar_close():
    t = pd.Timestamp("2026-10-19 21:30", tz="UTC").timestamp()
    assert next_bar_close(t) == pd.Timestamp("2026-10-20 00:00:20", tz="UTC").timestamp()


# --- логика бота -----------------------------------------------------------------

def test_auto_entry_buys_with_stop_and_one_percent_risk(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    assert pos is not None
    assert ex.stops[pos.stop_order_id]["status"] == "open"
    assert ex.stops[pos.stop_order_id]["trigger"] == pytest.approx(pos.stop, abs=0.01)
    assert (pos.entry - pos.stop) * pos.qty <= 10.0 + 1e-6  # 1% от 1000
    assert pos.qty <= ex.balances["SOL"]
    assert any("Куплено" in t for t, _ in rec.sent)


def test_same_bar_processed_once(make_bot):
    bot, ex, _ = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    bot.close("SOL", "manual")
    bot.on_candle_close()
    assert bot.store.position("SOL") is None


def test_confirm_mode_waits_for_button(make_bot):
    bot, ex, rec = make_bot("confirm")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    text, buttons = rec.sent[-1]
    assert "ВХОД SOL" in text
    pid = buttons[0][0][1].split(":")[1]
    assert bot.confirm(pid).startswith("✅")
    assert bot.store.position("SOL") is not None
    assert bot.confirm(pid).startswith("Уже обработано")


def test_expired_proposal_not_executed(make_bot):
    bot, ex, rec = make_bot("confirm", proposal_ttl_min=0)
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pid = rec.sent[-1][1][0][0][1].split(":")[1]
    assert "истекло" in bot.confirm(pid)
    assert bot.store.position("SOL") is None


def test_price_ran_away_is_not_chased(make_bot):
    bot, ex, rec = make_bot("confirm")
    df = cross_on_last_bar()
    ex.set("SOL", df)
    bot.on_candle_close()
    pid = rec.sent[-1][1][0][0][1].split(":")[1]
    ex.prices["SOLUSDT"] = float(df["close"].iloc[-1]) * 1.5
    assert "не догоняю" in bot.confirm(pid)
    assert bot.store.position("SOL") is None


def test_exit_on_trend_down_sells_and_records(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    ex.set("SOL", trend_down_last_bar().set_axis(
        pd.date_range("2026-03-01", periods=60, freq="4h", tz="UTC")))
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    assert ex.stops[pos.stop_order_id]["status"] == "cancelled"
    trade = bot.store.trades()[0]
    assert trade["reason"] == "signal" and trade["qty"] == pytest.approx(pos.qty)


def test_stop_fill_detected_on_reconcile(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    ex.prices["SOLUSDT"] = pos.stop * 0.99
    bot.reconcile()
    assert bot.store.position("SOL") is None
    t = bot.store.trades()[0]
    assert t["reason"] == "stop" and t["pnl_usdt"] < 0
    assert t["r"] == pytest.approx(-1, abs=0.05)
    assert "сработал стоп" in rec.sent[-1][0]


def test_failed_stop_sells_immediately(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.fail_stop = True
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    assert ex.balances["SOL"] == pytest.approx(0, abs=1e-3)


def test_manually_cancelled_stop_is_restored(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    old = bot.store.position("SOL").stop_order_id
    ex.stops[old]["status"] = "cancelled"
    bot.reconcile()
    new = bot.store.position("SOL").stop_order_id
    assert new != old and ex.stops[new]["status"] == "open"


def test_position_sold_by_hand_is_closed(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    ex.stops[pos.stop_order_id]["status"] = "cancelled"
    ex.balances["SOL"] = 0.0
    bot.reconcile()
    assert bot.store.position("SOL") is None
    assert bot.store.trades()[0]["reason"] == "manual"


def test_bot_only_sells_what_it_bought(make_bot):
    bot, ex, _ = make_bot("auto")
    ex.balances["SOL"] = 50.0  # монеты пользователя, купленные до бота
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    bought = bot.store.position("SOL").qty
    bot.close("SOL", "manual")
    assert bought > 0 and ex.balances["SOL"] == pytest.approx(50.0, abs=1e-3)


def test_max_positions_limit(make_bot):
    bot, ex, rec = make_bot("auto", coins=("SOL", "ETH"), max_positions=1)
    ex.set("SOL", cross_on_last_bar())
    ex.set("ETH", cross_on_last_bar())
    bot.on_candle_close()
    assert len(bot.store.positions()) == 1
    assert any("лимит 1" in t for t, _ in rec.sent)


def test_capital_cap_limits_position(make_bot):
    bot, ex, _ = make_bot("auto", capital_usdt=300.0, max_position_pct=100.0)
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    assert pos.qty * pos.entry <= 300.0 + 1e-6
    assert (pos.entry - pos.stop) * pos.qty <= 3.0 + 1e-6  # 1% от 300, хотя на счёте 1000


def test_too_small_order_is_skipped(make_bot):
    bot, ex, rec = make_bot("auto", capital_usdt=3.0)
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    assert any("меньше минимальной" in t for t, _ in rec.sent)


def test_paused_bot_skips_entries_but_exits(make_bot):
    bot, ex, rec = make_bot("auto")
    ex.set("SOL", cross_on_last_bar())
    bot.pause("тест")
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    assert "пауз" in rec.sent[-1][0]


def test_daily_loss_limit_pauses(make_bot):
    bot, ex, rec = make_bot("auto", daily_loss_limit_pct=0.5, coins=("SOL", "ETH"))
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    ex.prices["SOLUSDT"] = pos.stop * 0.99
    bot.reconcile()  # −1% по стопу
    ex.set("ETH", cross_on_last_bar().set_axis(pd.date_range("2026-05-01", periods=len(cross_on_last_bar()),
                                                             freq="4h", tz="UTC")))
    ex.data.pop("SOLUSDT")
    bot.on_candle_close()
    assert bot.paused == "дневной лимит убытка"
    assert bot.store.position("ETH") is None


def test_signals_mode_never_trades(make_bot):
    bot, ex, rec = make_bot("signals")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    assert bot.store.position("SOL") is None
    assert "только сигналы" in rec.sent[-1][0]


# --- Telegram ------------------------------------------------------------------

class FakeTelegram(Telegram):
    def __init__(self):
        super().__init__("T", "42")
        self.calls = []

    def _call(self, method, **params):
        self.calls.append((method, params))
        return {"message_id": len(self.calls)}


def test_telegram_ignores_strangers_and_handles_owner(make_bot):
    bot, ex, _ = make_bot("confirm")
    tg = FakeTelegram()
    tg.bot = bot
    tg.handle({"update_id": 1, "message": {"chat": {"id": 999}, "text": "/mode auto"}})
    assert bot.mode == "confirm" and tg.calls == []
    tg.handle({"update_id": 2, "message": {"chat": {"id": 42}, "text": "/mode auto"}})
    assert bot.mode == "auto"
    assert "автоматически" in tg.calls[-1][1]["text"]


def test_telegram_buy_button(make_bot):
    bot, ex, rec = make_bot("confirm")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    data = rec.sent[-1][1][0][0][1]
    tg = FakeTelegram()
    tg.bot = bot
    tg.handle({"update_id": 3, "callback_query": {"id": "q", "data": data, "message": {"chat": {"id": 42}}}})
    assert bot.store.position("SOL") is not None


# --- API -------------------------------------------------------------------------

def test_api_requires_token(make_bot):
    bot, ex, _ = make_bot("confirm")
    server = api.serve(bot, "secret-token", 0)
    port = server.server_address[1]
    try:
        with pytest.raises(HTTPError) as e:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/status")
        assert e.value.code == 401
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/status",
                                     headers={"Authorization": "Bearer secret-token"})
        status = json.loads(urllib.request.urlopen(req).read())
        assert status["mode"] == "confirm" and status["equity"]["total"] == pytest.approx(1000)
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/mode", data=b'{"mode":"auto"}', method="POST",
                                     headers={"Authorization": "Bearer secret-token",
                                              "Content-Type": "application/json"})
        urllib.request.urlopen(req)
        assert bot.mode == "auto"
    finally:
        server.shutdown()


# --- мини-приложение Telegram ---------------------------------------------------------

from urllib.parse import urlencode  # noqa: E402

from tradetrust.bot import webapp_auth  # noqa: E402


def init_data(user_id=42, token="123:ABC", age=0, **extra):
    fields = {"auth_date": str(int(pd.Timestamp.now(tz="UTC").timestamp()) - age), "query_id": "AAH",
              "user": json.dumps({"id": user_id, "first_name": "Ann"}, separators=(",", ":")), **extra}
    fields["hash"] = webapp_auth.sign(fields, token)
    return urlencode(fields)


def test_webapp_auth_accepts_owner_only():
    assert webapp_auth.validate(init_data(), "123:ABC", "42")["id"] == 42
    assert webapp_auth.validate(init_data(user_id=7), "123:ABC", "42") is None      # чужой пользователь
    assert webapp_auth.validate(init_data(token="999:X"), "123:ABC", "42") is None   # подписано другим ботом
    assert webapp_auth.validate(init_data(age=3 * 86400), "123:ABC", "42") is None   # устарело
    tampered = init_data().replace("Ann", "Bob")
    assert webapp_auth.validate(tampered, "123:ABC", "42") is None
    assert webapp_auth.validate("", "123:ABC", "42") is None


def test_webapp_auth_includes_signature_field():
    # Telegram добавляет поле signature; в проверку HMAC оно входит как обычное поле
    assert webapp_auth.validate(init_data(signature="abc"), "123:ABC", "42") is not None


def test_miniapp_not_built_message(make_bot, tmp_path):
    bot, _, _ = make_bot("confirm")
    server = api.serve(bot, "", 0, web_dir=tmp_path)
    try:
        with pytest.raises(HTTPError) as e:
            urllib.request.urlopen(f"http://127.0.0.1:{server.server_address[1]}/")
        assert e.value.code == 503 and "npm run build" in e.value.read().decode()
    finally:
        server.shutdown()


def test_miniapp_served_and_api_uses_telegram_auth(make_bot, tmp_path):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text('<script src="https://telegram.org/js/telegram-web-app.js"></script>'
                                         '<script type="module" src="./assets/index-abc.js"></script>')
    (tmp_path / "assets" / "index-abc.js").write_text("console.log(1)")
    bot, ex, _ = make_bot("confirm")
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    server = api.serve(bot, "", 0, tg_token="123:ABC", owner_id="42", web_dir=tmp_path)
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        html = urllib.request.urlopen(base + "/").read().decode()
        assert "telegram-web-app.js" in html
        js = urllib.request.urlopen(base + "/assets/index-abc.js")
        assert "javascript" in js.headers["Content-Type"] and "immutable" in js.headers["Cache-Control"]
        with pytest.raises(HTTPError) as e:
            urllib.request.urlopen(base + "/../config.py")
        assert e.value.code == 404

        def get(path, auth):
            return urllib.request.urlopen(urllib.request.Request(base + path, headers={"Authorization": auth}))

        with pytest.raises(HTTPError) as e:
            get("/api/status", "tma " + init_data(user_id=7))
        assert e.value.code == 401
        with pytest.raises(HTTPError) as e:  # пустой API_TOKEN не открывает доступ
            get("/api/status", "Bearer ")
        assert e.value.code == 401
        status = json.loads(get("/api/status", "tma " + init_data()).read())
        assert status["proposals"][0]["coin"] == "SOL"
        chart = json.loads(get("/api/candles?coin=SOL", "tma " + init_data()).read())
        assert len(chart["time"]) == len(chart["close"]) > 10 and chart["position"] is None
    finally:
        server.shutdown()


def test_each_purchase_logged_once(make_bot):
    for mode in ("confirm", "auto"):
        bot, ex, rec = make_bot(mode)
        ex.set("SOL", cross_on_last_bar())
        bot.on_candle_close()
        if mode == "confirm":
            bot.confirm(rec.sent[-1][1][0][0][1].split(":")[1])
        bought = [e for e in bot.store.events() if e["text"].startswith("✅ Куплено")]
        assert len(bought) == 1, (mode, bought)
        bot.store.db.execute("DELETE FROM events"); bot.store.db.execute("DELETE FROM positions")
        bot.store.db.execute("DELETE FROM kv")


def test_app_command_sends_webapp_button(make_bot):
    bot, ex, _ = make_bot("confirm")
    tg = FakeTelegram()
    tg.webapp_url = "https://1-2-3-4.sslip.io"
    tg.bot = bot
    tg.handle({"update_id": 5, "message": {"chat": {"id": 42}, "text": "/app"}})
    markup = tg.calls[-1][1]["reply_markup"]["inline_keyboard"][0][0]
    assert markup["web_app"]["url"] == "https://1-2-3-4.sslip.io"
    tg.setup()
    menu = [p for m, p in tg.calls if m == "setChatMenuButton"][0]
    assert menu["menu_button"]["web_app"]["url"] == "https://1-2-3-4.sslip.io" and menu["chat_id"] == 42


# --- настройки из мини-приложения ---------------------------------------------

def test_settings_change_applies_persists_and_notifies(make_bot, tmp_path):
    bot, ex, rec = make_bot("auto")
    assert bot.update_settings({"risk_pct": 0.5, "max_positions": 3, "btc_filter": True}) == "Настройки сохранены"
    assert bot.cfg.risk_pct == 0.5 and bot.params.risk == pytest.approx(0.005)
    assert bot.params.atr_period == 3  # остальные параметры системы не тронуты
    assert any("риск на сделку, %: 1 → 0,5" in t for t, _ in rec.sent)
    # после перезапуска бот берёт сохранённое, «Сбросить» возвращает .env
    again = Bot(Config(mode="auto", coins=["SOL"], ema_fast=3, ema_slow=6, db_path=bot.cfg.db_path),
                ex, Store(bot.cfg.db_path))
    assert (again.cfg.risk_pct, again.cfg.max_positions, again.cfg.btc_filter) == (0.5, 3, True)
    again.reset_settings()
    assert again.cfg.risk_pct == 1.0 and again.store.get("settings") == {}


def test_half_percent_risk_halves_position(make_bot):
    bot, ex, _ = make_bot("auto")
    bot.update_settings({"risk_pct": 0.5})
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.position("SOL")
    assert (pos.entry - pos.stop) * pos.qty <= 5.0 + 1e-6


@pytest.mark.parametrize("changes", [
    {"risk_pct": 10}, {"risk_pct": "1"}, {"max_positions": 2.5}, {"max_positions": True},
    {"coins": []}, {"coins": ["NOPE"]}, {"atr_mult": 3}, {"ema_fast": 5},
    {"risk_pct": 3, "max_total_risk_pct": 2},
])
def test_settings_outside_limits_are_rejected(make_bot, changes):
    bot, _, rec = make_bot("auto")
    with pytest.raises(ValueError):
        bot.update_settings(changes)
    assert bot.cfg.risk_pct == 1.0 and bot.cfg.coins == ["SOL"] and not rec.sent


def test_removed_coin_still_exits_but_no_new_entries(make_bot):
    bot, ex, _ = make_bot("auto", coins=("SOL", "ETH"))
    ex.set("SOL", cross_on_last_bar())
    ex.set("ETH", cross_on_last_bar())
    bot.on_candle_close()
    bot.update_settings({"coins": ["ETH"]})
    assert bot.watched_coins() == ["ETH", "SOL"]
    ex.set("SOL", trend_down_last_bar().set_axis(pd.date_range("2026-03-01", periods=60, freq="4h", tz="UTC")))
    bot.on_candle_close()
    assert bot.store.position("SOL") is None


def test_api_settings_endpoint(make_bot):
    bot, _, _ = make_bot("confirm")
    server = api.serve(bot, "secret-token", 0)
    port = server.server_address[1]

    def post(body):
        req = urllib.request.Request(f"http://127.0.0.1:{port}/api/settings", data=json.dumps(body).encode(),
                                     method="POST", headers={"Authorization": "Bearer secret-token"})
        return json.loads(urllib.request.urlopen(req).read())
    try:
        assert post({"daily_loss_limit_pct": 2})["message"] == "Настройки сохранены"
        assert bot.cfg.daily_loss_limit_pct == 2.0
        with pytest.raises(HTTPError) as e:
            post({"risk_pct": 0})
        assert e.value.code == 400 and "риск на сделку" in json.loads(e.value.read())["error"]
        post({"reset": True})
        assert bot.cfg.daily_loss_limit_pct == 3.0
        status = bot.status()
        assert status["settings_limits"]["risk_pct"] == {"min": 0.1, "max": 3.0}
        assert status["settings_defaults"]["daily_loss_limit_pct"] == 3.0 and "SOL" in status["all_coins"]
    finally:
        server.shutdown()
