"""Секундные свечи на сервере для графика «1с»."""
import json

from tradetrust.bot.seconds import SecondBars, SecondsFeed


def test_bars_from_trades_including_late_ones():
    s = SecondBars(keep=5)
    s.add("BTC", 100_100, 10.0, 1)
    s.add("BTC", 100_900, 12.0, 2)
    s.add("BTC", 100_950, 9.0, 1)
    s.add("BTC", 103_000, 11.0, 1)
    s.add("BTC", 101_500, 9.5, 4)   # запоздала — встаёт на своё место
    s.add("BTC", 102_200, 9.7, 1)
    assert s.get("BTC") == [[100, 10, 12, 9, 9, 4], [101, 9.5, 9.5, 9.5, 9.5, 4], [102, 9.7, 9.7, 9.7, 9.7, 1],
                            [103, 11, 11, 11, 11, 1]]
    for k in range(10):
        s.add("BTC", (104 + 2 * k) * 1000, 1.0, 1)   # свечи через секунду: …116, 118, 120, 122
    assert len(s.get("BTC")) == 5 and s.get("ETH") == []
    s.add("BTC", 121_500, 2.0, 3)  # запоздавшая сделка в пропущенную секунду, когда история уже полная
    assert [b[0] for b in s.get("BTC")] == [116, 118, 120, 121, 122] and s.get("BTC")[3][5] == 3


class FakeWS:
    def __init__(self, messages):
        self.messages, self.sent, self.closed = list(messages), [], False

    def settimeout(self, t):
        pass

    def send(self, text):
        self.sent.append(json.loads(text))

    def recv(self):
        if not self.messages:
            raise ConnectionError("обрыв")
        return self.messages.pop(0)

    def close(self):
        self.closed = True


def test_feed_subscribes_in_chunks_and_collects_trades():
    coins = [f"C{i}" for i in range(12)] + ["BTC"]
    trade = {"topic": "publicTrade.BTCUSDT", "data": [{"T": 5_000, "p": "100.5", "v": "0.2", "S": "Buy"},
                                                       {"T": 5_400, "p": "101", "v": "0.1", "S": "Sell"}]}
    ws = FakeWS([json.dumps({"op": "subscribe", "success": True}), json.dumps(trade)])
    feed = SecondsFeed(lambda: coins, connect=lambda: ws)
    try:
        feed.run_once()
    except ConnectionError:
        pass
    assert [len(m["args"]) for m in ws.sent] == [10, 3] and ws.closed
    assert feed.store.get("BTC") == [[5, 100.5, 101.0, 100.5, 101.0, 0.30000000000000004]]
    assert feed.ok_at is not None
