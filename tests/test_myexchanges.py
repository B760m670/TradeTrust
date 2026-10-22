"""«Мои биржи»: ключи только для чтения, балансы со всех кошельков в $, статусы ввода/вывода, сводка."""
import base64
import hashlib
import hmac
from urllib.parse import parse_qs, urlparse

import pytest

from tradetrust.bot.config import Config
from tradetrust.bot.myexchanges import OKX, Binance, KeyRejected, KuCoin, MyExchanges

from test_bot import FakeResponse


class Resp(FakeResponse):
    status_code = 200


class Route:
    """HTTP по путям: путь → ответ (или функция от параметров)."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def _answer(self, url, headers):
        u = urlparse(url)
        self.calls.append((u.path, {k: v[0] for k, v in parse_qs(u.query).items()}, headers or {}))
        r = self.routes[u.path]
        return Resp(r(self.calls[-1][1]) if callable(r) else r)

    def get(self, url, headers=None, timeout=None):
        return self._answer(url, headers)

    def request(self, method, url, headers=None, timeout=None):
        return self._answer(url, headers)


def test_binance_signature_matches_documented_example():
    q = "symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559"
    assert Binance.sign("NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j", q) == \
        "c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71"


def test_okx_and_kucoin_signatures():
    raw = hmac.new(b"S", b"2020-12-08T09:08:57.715ZGET/api/v5/account/config", hashlib.sha256).digest()
    assert OKX.sign("S", "2020-12-08T09:08:57.715Z", "GET", "/api/v5/account/config") == base64.b64encode(raw).decode()
    s = Route({"/api/v1/user/api-key": {"code": "200000", "data": {"permission": "General"}}})
    KuCoin("K", "S", "pass", session=s).check()
    h = s.calls[0][2]
    assert h["KC-API-PASSPHRASE"] == base64.b64encode(hmac.new(b"S", b"pass", hashlib.sha256).digest()).decode()
    assert h["KC-API-SIGN"] == base64.b64encode(
        hmac.new(b"S", (h["KC-API-TIMESTAMP"] + "GET/api/v1/user/api-key").encode(), hashlib.sha256).digest()).decode()
    assert h["KC-API-KEY-VERSION"] == "3"


@pytest.mark.parametrize("restrictions, ok", [
    ({"enableReading": True, "ipRestrict": True}, True),
    ({"enableReading": True, "enableWithdrawals": True}, False),
    ({"enableReading": True, "enableSpotAndMarginTrading": True}, False),
])
def test_binance_accepts_only_read_only_keys(restrictions, ok):
    ex = Binance("K", "S", session=Route({"/sapi/v1/account/apiRestrictions": restrictions}))
    if ok:
        assert ex.check() == []
    else:
        with pytest.raises(KeyRejected):
            ex.check()


def test_okx_and_kucoin_reject_trade_and_withdraw():
    for perm, ok in (("read_only", True), ("read_only,trade", False), ("read_only,withdraw", False)):
        ex = OKX("K", "S", "P", session=Route({"/api/v5/account/config": {"code": "0", "data": [{"perm": perm, "ip": ""}]}}))
        if ok:
            assert ex.check() == ["ключ OKX не привязан к IP сервера"]
        else:
            with pytest.raises(KeyRejected):
                ex.check()
    with pytest.raises(KeyRejected, match="торговли"):
        KuCoin("K", "S", "P", session=Route({"/api/v1/user/api-key": {"code": "200000", "data": {"permission": "General,Spot"}}})).check()


def binance_fake():
    return Route({
        "/sapi/v1/account/apiRestrictions": {"enableReading": True, "ipRestrict": True},
        "/api/v3/account": {"balances": [{"asset": "ETH", "free": "1.5", "locked": "0.5"}, {"asset": "USDT", "free": "100", "locked": "0"},
                                         {"asset": "DUST", "free": "3", "locked": "0"}]},
        "/sapi/v1/asset/get-funding-asset": [{"asset": "USDT", "free": "50", "locked": "0", "freeze": "0"}],
        "/api/v3/ticker/price": [{"symbol": "ETHUSDT", "price": "2400"}, {"symbol": "DUSTUSDT", "price": "0.0001"}],
        "/sapi/v1/capital/config/getall": [
            {"coin": "ETH", "depositAllEnable": True, "withdrawAllEnable": True, "networkList": [{"depositEnable": True, "withdrawEnable": True}]},
            {"coin": "NIGHT", "depositAllEnable": True, "withdrawAllEnable": False, "networkList": [{"depositEnable": True, "withdrawEnable": False}]}],
    })


def test_balances_statuses_and_summary():
    okx = Route({
        "/api/v5/account/config": {"code": "0", "data": [{"perm": "read_only", "ip": "1.2.3.4"}]},
        "/api/v5/account/balance": {"code": "0", "data": [{"details": [{"ccy": "ETH", "eq": "1"}]}]},
        "/api/v5/asset/balances": {"code": "0", "data": [{"ccy": "NIGHT", "bal": "1000"}]},
        "/api/v5/market/tickers": {"code": "0", "data": [{"instId": "ETH-USDT", "last": "2401"}, {"instId": "NIGHT-USDT", "last": "0.04"}]},
        "/api/v5/asset/currencies": {"code": "0", "data": [{"ccy": "NIGHT", "canDep": True, "canWd": False},
                                                           {"ccy": "NIGHT", "canDep": True, "canWd": False}]},
    })
    hub = MyExchanges([Binance("K", "S", session=binance_fake()), OKX("K", "S", "P", session=okx)])
    assert hub.connect() == ["✅ Binance", "✅ OKX"]
    hub.refresh(force=True)
    v = hub.view()
    binance = v["exchanges"][0]
    assert [a["coin"] for a in binance["assets"]] == ["ETH", "USDT"]  # пыль дешевле 1 $ скрыта
    assert binance["total"] == pytest.approx(2 * 2400 + 150)
    eth = next(c for c in v["coins"] if c["coin"] == "ETH")
    assert eth["qty"] == 3 and eth["where"] == {"Binance": 2.0, "OKX": 1.0}
    night = next(c for c in v["coins"] if c["coin"] == "NIGHT")
    assert night["closed"] == {"OKX": {"deposit": True, "withdraw": False}}
    assert v["total"] == pytest.approx(4950 + 2401 + 40)
    assert hub.coin_status("NIGHT") == {"Binance": {"deposit": True, "withdraw": False}, "OKX": {"deposit": True, "withdraw": False}}


def test_rejected_key_is_not_used_and_errors_are_shown():
    bad = Binance("K", "S", session=Route({"/sapi/v1/account/apiRestrictions": {"enableWithdrawals": True}}))
    hub = MyExchanges([bad])
    assert hub.connect()[0].startswith("⛔ Binance: у ключа Binance включён вывод")
    hub.refresh(force=True)
    s = hub.view()["exchanges"][0]
    assert not s["connected"] and "assets" not in s


def test_config_needs_all_parts_of_a_key():
    with pytest.raises(ValueError, match="OKX"):
        Config(okx_api_key="k", okx_api_secret="s").validate()
    Config(kucoin_api_key="k", kucoin_api_secret="s", kucoin_passphrase="p").validate()
