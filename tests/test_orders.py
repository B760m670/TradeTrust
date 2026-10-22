"""Открытые ордера владельца на бирже (например, тейк-профит на ETH) — в портфеле приложения, стопы бота помечены."""
from tradetrust.bot.bybit import BybitClient, BybitExchange

from test_bot import CaptureSession, cross_on_last_bar, make_bot  # noqa: F401 — фикстура

ETH_TP = {"orderId": "tp1", "symbol": "ETHUSDT", "side": "Sell", "orderType": "Market", "price": "0", "qty": "4.10297",
          "triggerPrice": "3142", "triggerDirection": 1, "stopOrderType": "tpslOrder", "createdTime": "1700000000000"}
LIMIT = {"orderId": "l1", "symbol": "SOLUSDT", "side": "Buy", "orderType": "Limit", "price": "90", "qty": "1",
         "triggerPrice": "0", "stopOrderType": "", "createdTime": "1700000001000"}
STOP = {"orderId": "s1", "symbol": "BTCUSDT", "side": "Sell", "orderType": "Market", "price": "0", "qty": "0.01",
        "triggerPrice": "80000", "triggerDirection": 2, "stopOrderType": "Stop", "createdTime": "1600000000000"}


def test_spot_open_orders_from_all_filters_without_duplicates():
    s = CaptureSession({"list": [ETH_TP, LIMIT, STOP, {**LIMIT, "symbol": "ETHBTC", "orderId": "x"}]})
    orders = BybitExchange(BybitClient("mainnet", "K", "S", session=s)).open_orders()
    filters = [url.split("orderFilter=")[1].split("&")[0] for _, url, _, _ in s.calls]
    assert filters == ["Order", "tpslOrder", "StopOrder"]  # на споте условные ордера — отдельными запросами
    assert [(o["id"], o["kind"]) for o in orders] == [("l1", "limit"), ("tp1", "tp"), ("s1", "sl")]
    tp = orders[1]
    assert tp == {"id": "tp1", "coin": "ETH", "side": "sell", "kind": "tp", "type": "market", "price": None,
                  "trigger": 3142.0, "qty": 4.10297, "created": 1700000000000}


def test_portfolio_lists_open_orders_and_marks_bot_stops(make_bot):
    bot, ex, _ = make_bot()
    ex.set("SOL", cross_on_last_bar())
    bot.on_candle_close()
    pos = bot.store.positions()[0]
    bot.ex.open_orders = lambda: [{"id": pos.stop_order_id, "coin": pos.coin}, {"id": "tp1", "coin": "ETH"}]
    assert [(o["id"], o["bot"]) for o in bot.portfolio()["open_orders"]] == [(pos.stop_order_id, True), ("tp1", False)]
    bot.ex.open_orders = lambda: (_ for _ in ()).throw(RuntimeError("bybit down"))
    assert bot.portfolio()["open_orders"] == []  # без ордеров портфель всё равно отдаётся
