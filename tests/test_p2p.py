"""P2P владельца: стакан и спред по вашим фильтрам, уведомления по ордерам, статистика — только чтение."""
import json
import time
import urllib.request
from urllib.error import HTTPError
from urllib.parse import urlparse

import pytest

from tradetrust.bot import api
from tradetrust.bot import p2p as p2pmod
from tradetrust.bot.bybit import BybitClient
from tradetrust.bot.p2p import P2PClient, P2PDesk, fits, parse_ad, spread, stats
from tradetrust.bot.store import Store

from test_bot import FakeResponse, init_data, make_bot  # noqa: F401 — фикстура


def ad(id, price, side, pays=("75",), lo=1000, hi=100000, qty=1000, rate=98, orders=200, online=True):
    return {"id": id, "nickName": f"u{id}", "price": str(price), "side": side, "lastQuantity": str(qty),
            "minAmount": str(lo), "maxAmount": str(hi), "payments": list(pays), "recentOrderNum": orders,
            "recentExecuteRate": rate, "isOnline": online, "authTag": ["GA"]}


def order(id, status, side=1, amount=8240, price=82.4, **kw):
    return {"id": id, "status": status, "side": side, "amount": str(amount), "price": str(price), "currencyId": "RUB",
            "tokenId": "USDT", "targetNickName": "Ivan", "buyerRealName": "Иван И.", "createDate": "1700000000000", **kw}


class FakeP2P:
    """P2P API Bybit по HTTP: все запросы — POST, ответы в стиле ret_code, как в документации."""

    def __init__(self):
        self.buyers = [ad("b1", 81.9, "0"), ad("b2", 82.3, "0", pays=("14",)), ad("b3", 82.0, "0", rate=70),
                       ad("b4", 81.5, "0")]
        self.sellers = [ad("s1", 83.1, "1"), ad("s2", 82.6, "1", hi=3000), ad("s3", 82.9, "1", online=False),
                        ad("s4", 83.4, "1")]
        self.pending, self.history, self.calls, self.details, self.my = [], [], [], {}, []

    def request(self, method, url, data=None, headers=None, timeout=None):
        assert method == "POST" and headers["X-BAPI-API-KEY"] == "K"
        path, body = urlparse(url).path, json.loads(data or "{}")
        self.calls.append((path, body))
        result = {
            "/v5/p2p/item/online": lambda: {"count": 4, "items": self.buyers if body["side"] == "0" else self.sellers},
            "/v5/p2p/user/personal/info": lambda: {"nickName": "owner", "recentRate": 100, "recentFinishCount": 3},
            "/v5/p2p/user/payment/list": lambda: [
                {"id": "-1", "paymentType": 377, "paymentConfigVo": {"paymentType": "377", "paymentName": "Balance"}},
                {"id": "7110", "paymentType": 75, "paymentConfigVo": {"paymentType": "75", "paymentName": "Tinkoff"}}],
            "/v5/p2p/item/personal/list": lambda: {"items": self.my or [{"currencyId": "RUB", "feeRate": "0.1"}]},
            "/v5/p2p/order/pending/simplifyList": lambda: {"count": len(self.pending), "items": self.pending},
            "/v5/p2p/order/simplifyList": lambda: {"count": len(self.history), "items": self.history},
            "/v5/p2p/order/info": lambda: self.details.get(body["orderId"], {}),
        }[path]()
        return FakeResponse({"ret_code": 0, "ret_msg": "SUCCESS", "result": result, "time_now": "1"})


@pytest.fixture
def desk(tmp_path):
    fake, sent = FakeP2P(), []
    d = P2PDesk(P2PClient(BybitClient("mainnet", "K", "S", session=fake)), Store(str(tmp_path / "bot.db")),
                sent.append, ["RUB", "USD"])
    return d, fake, sent


def test_ads_request_and_parse(desk):
    d, fake, _ = desk
    ads = d.p2p.online_ads("RUB", "1")
    assert fake.calls[-1] == ("/v5/p2p/item/online", {"tokenId": "USDT", "currencyId": "RUB", "side": "1",
                                                      "page": "1", "size": "100"})
    assert ads[0].price == 83.1 and ads[0].payments == ["75"] and ads[0].online


def test_filters_and_spread_math():
    a = parse_ad(ad("x", 82, "1", lo=1000, hi=5000))
    assert fits(a, 3000, ["75"], 90, 20)
    assert not fits(a, 6000, [], 90, 20)            # сумма больше лимита объявления
    assert not fits(a, 0, ["14"], 90, 20)           # нет вашего способа оплаты
    assert not fits(parse_ad(ad("y", 82, "1", rate=80)), 0, [], 90, 20)
    s = spread(82.0, 83.0, fee_buy=0.3, fee_sell=0.0, extra=0.05)
    assert s["gross_pct"] == pytest.approx((83 / 82 - 1) * 100) and s["costs_pct"] == pytest.approx(0.35)
    assert s["maker_pct"] == pytest.approx(s["gross_pct"] - 0.35) and s["taker_pct"] < 0


def test_market_uses_your_payments_and_filters(desk):
    d, fake, _ = desk
    d.set_prefs("RUB", {"amount": 5000})
    m = d.market("RUB")
    # по умолчанию — ваши способы оплаты (Tinkoff, без внутреннего баланса Bybit); b2 — другой банк, b3 — 70% выполнения,
    # s2 — сумма больше лимита, s3 — не в сети
    assert m["prefs"]["payments"] == ["75"]
    assert [a["id"] for a in m["bids"]] == ["b1", "b4"] and [a["id"] for a in m["asks"]] == ["s1", "s4"]
    assert m["bid"] == 81.9 and m["ask"] == 83.1 and m["ad_fee_pct"] == pytest.approx(0.1)
    assert m["costs_pct"] == pytest.approx(0.3)  # по рублю по умолчанию — комиссия мейкера за объявление на покупку
    assert m["payments"][0] == {"id": "75", "name": "Tinkoff", "ads": 7, "mine": True}
    n = len(fake.calls)
    d.market("RUB")
    assert len(fake.calls) == n  # стакан из кэша, Bybit не дёргаем


def test_orders_notifications(desk, monkeypatch):
    d, fake, sent = desk
    d.set_prefs("RUB", {"notify": "all"})  # «все» — как в приложении Bybit: каждый ордер и смена статуса
    fake.pending = [order("o1", 10)]
    d.poll()
    assert sent == []  # первый запуск: уже открытые ордера не объявляем
    fake.pending = [order("o1", 20), order("o2", 10, side=0, transferLastSeconds="200")]
    d.poll()
    assert "отметил оплату" in sent[0] and "Иван И." in sent[0] and "Бот монеты не отпускает" in sent[0]
    assert sent[1].startswith("🆕 Новый ордер: вы покупаете 100,00 USDT по 82,40 = 8 240 RUB") and "осталось 3 мин" in sent[2]
    d.poll()
    assert len(sent) == 3  # без изменений — тишина, напоминание об оплате — один раз
    fake.pending = [order("o2", 20, side=0)]
    fake.history = [order("o1", 50)]
    d.poll()
    assert any(t.startswith("⏳ Вы отметили оплату") for t in sent) and sent[-1].startswith("✅ Ордер завершён")


def test_spread_alert_threshold_and_cooldown(desk, monkeypatch):
    d, _, sent = desk
    d.set_prefs("RUB", {"alert_pct": 0.5})
    d.poll()
    assert sent and sent[0].startswith("📊 Чистый спред RUB: 0,55%")  # 82.6/81.9 − 1 − 0.3% комиссии мейкера
    d._last_alert_check = 0
    d.poll()
    assert len(sent) == 1  # повторно — не раньше чем через 2 часа
    d.set_prefs("RUB", {"alert_pct": 5.0})
    monkeypatch.setattr(p2pmod, "ALERT_COOLDOWN", 0)
    d._last_alert_check = 0
    d.poll()
    assert len(sent) == 1


def test_stats_of_finished_orders():
    s = stats([order("1", 50, side=0, amount=8200, price=82), order("2", 50, side=1, amount=4150, price=83),
               order("3", 40, side=1, amount=99999, price=90)])["RUB"]
    assert s["buy_qty"] == 100 and s["sell_qty"] == 50 and s["orders"] == 2
    assert s["profit"] == pytest.approx(50 * (83 - 82))


def test_prefs_validation(desk):
    d, _, _ = desk
    with pytest.raises(ValueError):
        d.set_prefs("EUR", {})
    with pytest.raises(ValueError):
        d.set_prefs("RUB", {"min_rate": 150})
    assert d.set_prefs("USD", {"payments": ["14"], "amount": 200})["payments"] == ["14"]


def test_api_owner_only(make_bot, desk):
    bot, _, _ = make_bot()
    d, _, _ = desk
    server = api.serve(bot, "", 0, tg_token="123:ABC", owner_id="42", p2p=d)
    base = f"http://127.0.0.1:{server.server_address[1]}"

    def call(path, body=None, user=42):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None,
                                     method="POST" if body is not None else "GET",
                                     headers={"Authorization": "tma " + init_data(user_id=user)})
        return json.loads(urllib.request.urlopen(req).read())

    try:
        view = call("/api/p2p?currency=rub")
        assert view["available"] and view["account"]["nickName"] == "owner" and view["market"]["bid"] == 81.9
        assert call("/api/p2p/prefs", {"currency": "RUB", "alert_pct": 0.5})["prefs"]["alert_pct"] == 0.5
        with pytest.raises(HTTPError) as e:
            call("/api/p2p", user=7)
        assert e.value.code in (401, 403)
    finally:
        server.shutdown()


def test_cards_ledger_limits_and_journal(desk):
    d, fake, sent = desk
    now_ms = int(time.time() * 1000)
    fake.history = [  # три завершённых ордера за сегодня: две покупки USDT (вы платите) и продажа (вам платят)
        order("h1", 50, side=0, amount=8200, price=82, createDate=str(now_ms - 3000), targetUserId="u1"),
        order("h2", 50, side=0, amount=4150, price=83, createDate=str(now_ms - 2000), targetUserId="u2"),
        order("h3", 50, side=1, amount=12450, price=83, createDate=str(now_ms - 1000), targetUserId="u3"),
        order("h4", 40, side=1, amount=999, price=83, createDate=str(now_ms - 500)),  # отменён — не считается
    ]
    fake.details = {"h1": {"paymentType": 75}, "h2": {"confirmedPayTerm": {"paymentType": "582",
                    "paymentConfigVo": {"paymentName": "Sberbank"}}}, "h3": {"paymentType": 75}}
    d.set_prefs("RUB", {"limits": {"75": {"day": 25000}}, "month_cap": 20000})
    led = d.ledger("RUB")
    tinkoff = next(c for c in led["cards"] if c["pay"] == "75")
    assert tinkoff["name"] == "Tinkoff" and tinkoff["day_out"] == 8200 and tinkoff["day_in"] == 12450 and tinkoff["people"] == 2
    assert led["turnover"] == 8200 + 4150 + 12450 and led["people_month"] == 3
    assert [w["key"] for w in led["warnings"]] == ["75:day", "cap:month"]  # 20 650 из 25 000 и 24 800 из 20 000
    n = len(fake.calls)
    d.ledger("RUB")
    assert sum(1 for p, _ in fake.calls[n:] if p == "/v5/p2p/order/info") == 0  # детали ордеров — один раз
    d._check_limits()
    d._check_limits()
    assert len(sent) == 2 and sent[0].startswith("🧾 Tinkoff: оборот за день 20 650 из 25 000 RUB")  # один раз за период
    data, count = d.journal()
    text = data.decode("utf-8-sig").splitlines()
    assert count == 3 and text[0].startswith("Дата (МСК);Ордер;Сторона")
    sale = text[-1].split(";")
    # продано 150 USDT по 83: 100 по 82 + 50 по 83 → себестоимость 12 350, результат +100
    assert sale[2] == "продажа" and sale[9] == "Tinkoff" and sale[10] == "12350" and sale[11] == "100"


def test_fifo_marks_sales_without_purchases():
    from tradetrust.bot.p2p import fifo_journal, order_view
    rows = fifo_journal([order_view(order("s", 50, side=1, amount=8300, price=83))])
    assert rows[0]["uncovered"] == pytest.approx(100) and rows[0]["result"] == 0


def test_important_mode_skips_duplicates_and_reminds_to_check_bank(desk, monkeypatch):
    d, fake, sent = desk
    assert d.notify_mode == "important"  # по умолчанию — без дублей уведомлений Bybit
    fake.pending = []
    d.poll()
    fake.pending = [order("o1", 10)]
    d.poll()
    fake.pending = [order("o1", 20)]  # покупатель отметил оплату — это Bybit покажет сам
    d.poll()
    assert sent == []
    clock = [time.time() + p2pmod.RELEASE_REMIND + 5]
    monkeypatch.setattr(p2pmod.time, "time", lambda: clock[0])
    d.poll()
    assert len(sent) == 1 and "отметил оплату" in sent[0] and "не отпускайте" in sent[0]
    d.poll()
    assert len(sent) == 1  # напоминание — один раз
    fake.pending = [order("o1", 30)]
    d.poll()
    assert sent[-1].startswith("⚠️ Апелляция")


def test_my_ads_rank_and_level_progress(desk):
    from tradetrust.bot.p2p import level_progress
    d, fake, _ = desk
    d.market("RUB")
    fake.my = [{"id": "m1", "side": "1", "tokenId": "USDT", "currencyId": "RUB", "price": "82.8", "lastQuantity": "900",
                "quantity": "995", "executedQuantity": "95", "minAmount": "5000", "maxAmount": "30000", "status": 10,
                "paymentTerms": [{"paymentType": 75}], "feeRate": "0.003"}]
    ad = d.my_ads("RUB")[0]
    # продавцы дешевле 82,8: s2 (82,6, тот же Tinkoff); s3 не в сети — не считается
    assert ad["side"] == "sell" and ad["rank"] == 2 and ad["rank_pay"] == 2 and ad["best_rival"] == 82.6
    assert ad["payments"] == ["Tinkoff"] and ad["fee_pct"] == 0.3 and ad["online"]
    now = time.time()
    orders = [order(str(i), 50, amount=8300, price=83, createDate=str(int(now * 1000) - i), targetUserId=f"u{i % 6}")
              for i in range(24)]
    lv = level_progress(orders, now)
    assert lv["counterparties"] == 6 and lv["volume_30d"] == 2400 and lv["levels"][0]["done"] and lv["next"] == "Опытный"
