"""Фьючерсы USDT для копитрейдинга: бот торгует ими так же, как спотом — лонг 1x на свои деньги, стоп на бирже."""
import json
from decimal import Decimal
from urllib.parse import parse_qs, urlparse

import pytest

from tradetrust import backtest as bt
from tradetrust.bot.accounts import check_key
from tradetrust.bot.bybit import BybitClient, LinearExchange
from tradetrust.bot.config import Config
from tradetrust.bot.engine import Bot
from tradetrust.bot.store import Store

from test_bot import FakeResponse, Recorder


class FakeLinear:
    """Биржа Bybit по HTTP: фьючерсы USDT, рыночные ордера исполняются сразу по цене, стопы ждут цену."""

    def __init__(self, usdt=1000.0, price=100.0, hedge=False, copyable=("SOLUSDT", "BTCUSDT")):
        self.usdt, self.price, self.hedge, self.copyable = usdt, price, hedge, set(copyable)
        self.positions = {}  # symbol -> (size, avg)
        self.orders = {}
        self.calls = []
        self.n = 0

    def request(self, method, url, data=None, headers=None, timeout=None):
        u = urlparse(url)
        params = json.loads(data) if data else {k: v[0] for k, v in parse_qs(u.query).items()}
        self.calls.append((u.path, params))
        assert params.get("category") in (None, "linear")
        try:
            result = getattr(self, u.path.strip("/").replace("/", "_").replace("-", "_"))(params)
        except _Err as e:
            return FakeResponse({"retCode": e.code, "retMsg": e.msg})
        return FakeResponse({"retCode": 0, "retMsg": "OK", "result": result})

    def v5_market_tickers(self, p):
        return {"list": [{"lastPrice": str(self.price)}]}

    def v5_market_instruments_info(self, p):
        return {"list": [{"symbol": p["symbol"], "copyTrading": "both" if p["symbol"] in self.copyable else "none",
                          "lotSizeFilter": {"qtyStep": "0.1", "minNotionalValue": "5", "maxMktOrderQty": "10000"},
                          "priceFilter": {"tickSize": "0.01"}}]}

    def v5_account_wallet_balance(self, p):
        return {"list": [{"coin": [{"coin": "USDT", "walletBalance": str(self.usdt), "locked": "0", "usdValue": str(self.usdt)}]}]}

    def v5_position_list(self, p):
        return {"list": [{"symbol": s, "side": "Buy", "size": str(q), "avgPrice": str(a), "markPrice": str(self.price),
                          "positionIdx": 1 if self.hedge else 0} for s, (q, a) in self.positions.items() if q > 0]}

    def v5_position_set_leverage(self, p):
        assert p["buyLeverage"] == p["sellLeverage"] == "1"
        return {}

    def v5_order_create(self, p):
        if p["positionIdx"] != (1 if self.hedge else 0):
            raise _Err(10001, "position idx not match position mode")
        self.n += 1
        oid = f"o{self.n}"
        order = {"orderId": oid, "symbol": p["symbol"], "side": p["side"], "qty": float(p["qty"]), "params": p}
        if "triggerPrice" in p:
            assert p["reduceOnly"] is True and p["triggerDirection"] == 2
            order["orderStatus"] = "Untriggered"
        else:
            self._fill(order)
        self.orders[oid] = order
        return {"orderId": oid}

    def _fill(self, order):
        size, avg = self.positions.get(order["symbol"], (0.0, 0.0))
        q = order["qty"]
        if order["side"] == "Buy":
            self.positions[order["symbol"]] = (size + q, (size * avg + q * self.price) / (size + q))
        else:
            assert order["params"].get("reduceOnly") is True
            self.usdt += (self.price - avg) * min(q, size)
            self.positions[order["symbol"]] = (size - min(q, size), avg)
        fee = q * self.price * 0.00055
        self.usdt -= fee
        order.update(orderStatus="Filled", cumExecQty=str(q), avgPrice=str(self.price), cumExecFee=str(fee))

    def trigger_stops(self):
        for o in self.orders.values():
            if o["orderStatus"] == "Untriggered" and self.price <= float(o["params"]["triggerPrice"]):
                self._fill(o)

    def v5_order_realtime(self, p):
        o = self.orders.get(p["orderId"])
        return {"list": [{k: v for k, v in o.items() if k != "params"}] if o else []}

    v5_order_history = v5_order_realtime

    def v5_order_cancel(self, p):
        o = self.orders.get(p["orderId"])
        assert "orderFilter" not in p  # у фьючерсов фильтр не нужен
        if not o or o["orderStatus"] != "Untriggered":
            raise _Err(110001, "order not exists or too late to cancel")
        o["orderStatus"] = "Cancelled"
        return {}


class _Err(Exception):
    def __init__(self, code, msg):
        self.code, self.msg = code, msg


def exchange(fake):
    return LinearExchange(BybitClient("demo", "K", "S", session=fake, category="linear"), poll_seconds=0)


def make_bot(tmp_path, fake):
    cfg = Config(env="demo", market="linear", mode="auto", coins=["SOL"], db_path=str(tmp_path / "bot.db"),
                 risk_pct=1.0, max_position_pct=50.0)
    bot = Bot(cfg, exchange(fake), Store(cfg.db_path), Recorder())
    bot.params = bt.Params(fast=3, slow=6, atr_period=3, atr_mult=cfg.atr_mult, risk=cfg.risk_pct / 100)
    return bot


def test_long_1x_with_exchange_stop_and_spot_like_balances(tmp_path):
    fake = FakeLinear()
    bot = make_bot(tmp_path, fake)
    text = bot.open("SOL", stop=90.0, ref_price=100.0)
    assert text.startswith("✅"), text
    pos = bot.store.position("SOL")
    # риск 1% от 1000 при стопе в 10 USDT — 1 SOL; деньги, вложенные в позицию, не считаются свободными
    assert pos.qty == 1.0 and pos.stop == 90.0
    assert bot.ex.balance("SOL") == 1.0 and bot.ex.balance("USDT") == pytest.approx(900 - 0.055)
    assert bot.equity()["total"] == pytest.approx(1000 - 0.055)
    paths = [c[0] for c in fake.calls]
    assert paths.count("/v5/position/set-leverage") == 1
    create = [p for path, p in fake.calls if path == "/v5/order/create"]
    assert "isLeverage" not in create[0] and create[0]["side"] == "Buy"
    assert Decimal(create[1]["triggerPrice"]) == 90 and create[1]["reduceOnly"] is True

    fake.price = 89.0  # стоп сработал на бирже
    fake.trigger_stops()
    bot.reconcile()
    assert bot.store.position("SOL") is None
    trade = bot.store.trades(1)[0]
    assert trade["reason"] == "stop" and trade["exit"] == 89.0


def test_signal_exit_cancels_stop_and_sells_reduce_only(tmp_path):
    fake = FakeLinear()
    bot = make_bot(tmp_path, fake)
    bot.open("SOL", stop=90.0, ref_price=100.0)
    fake.price = 120.0
    assert "выход по сигналу" in bot.close("SOL", "signal")
    assert fake.positions["SOLUSDT"][0] == 0
    assert [o["orderStatus"] for o in fake.orders.values()] == ["Filled", "Cancelled", "Filled"]
    assert bot.store.trades(1)[0]["pnl_usdt"] > 19


def test_hedge_mode_account_is_detected(tmp_path):
    """Счёт копитрейдинга — в режиме хеджирования: лонг идёт с positionIdx=1."""
    fake = FakeLinear(hedge=True)
    ex = exchange(fake)
    ex.market_buy("SOLUSDT", "SOL", Decimal("1"))
    ex.place_stop("SOLUSDT", Decimal("1"), Decimal("90"))
    assert ex.position_idx == 1 and fake.positions["SOLUSDT"][0] == 1.0
    assert sum(path == "/v5/order/create" for path, _ in fake.calls) == 3  # одна повторная попытка


def test_only_copy_trading_pairs_and_no_manual_orders(tmp_path):
    fake = FakeLinear(copyable=("BTCUSDT",))
    bot = make_bot(tmp_path, fake)
    plan, why = bot.plan("SOL", 100.0, 90.0)
    assert plan is None and "копитрейдинг" in why
    with pytest.raises(ValueError, match="ручные сделки"):
        bot.manual_order("BTC", "buy", usdt=50)


def test_key_for_copy_trading_needs_contract_rights():
    ok = {"readOnly": 0, "permissions": {"ContractTrade": ["Order", "Position"]}, "ips": ["148.135.203.10"]}
    assert check_key(ok, "linear") == ("", "")
    assert "Контракты" in check_key({**ok, "permissions": {"Spot": ["SpotTrade"]}}, "linear")[0]
    assert "вывод" in check_key({**ok, "permissions": {**ok["permissions"], "Wallet": ["Withdraw"]}}, "linear")[0]


def test_config_rejects_paper_futures():
    with pytest.raises(ValueError, match="BYBIT_MARKET"):
        Config(env="demo", api_key="a", api_secret="b", market="margin").validate()
    with pytest.raises(ValueError, match="спот"):
        Config(env="paper", market="linear").validate()
