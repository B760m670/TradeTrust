"""Секундные свечи для графика «1с», как на биржах: история сразу при открытии, дальше — живой поток.

У Bybit нет свечей по секундам, поэтому сервер сам всё время слушает поток сделок (publicTrade) по монетам
бота и помнит последние KEEP секунд по каждой. Приложение берёт эту историю через /api/seconds и дальше
дорисовывает свечи по тому же потоку сделок у себя. Секунды без сделок здесь не хранятся — их дорисовывает
приложение ровными свечами.
"""
from __future__ import annotations

import collections
import json
import logging
import threading
import time
from typing import Callable

log = logging.getLogger("tradetrust.seconds")

URL = "wss://stream.bybit.com/v5/public/spot"
KEEP = 900          # 15 минут
MAX_ARGS = 10       # спот Bybit принимает до 10 тем в одной подписке
PING_SECONDS = 20
RECHECK_SECONDS = 60


class SecondBars:
    """Свечи по секундам из сделок: [секунда, открытие, максимум, минимум, закрытие, объём]."""

    def __init__(self, keep: int = KEEP):
        self.keep = keep
        self.bars: dict[str, collections.deque] = {}
        self.lock = threading.Lock()

    def add(self, coin: str, t_ms: int, price: float, size: float) -> None:
        sec = int(t_ms // 1000)
        with self.lock:
            dq = self.bars.setdefault(coin, collections.deque(maxlen=self.keep))
            if dq and sec <= dq[-1][0]:
                # та же секунда или запоздавшая сделка — в свою свечу; секунды без сделок в истории нет
                for bar in reversed(dq):
                    if bar[0] == sec:
                        bar[2], bar[3], bar[4], bar[5] = max(bar[2], price), min(bar[3], price), price, bar[5] + size
                        return
                    if bar[0] < sec:
                        if len(dq) == dq.maxlen:
                            dq.popleft()  # иначе deque с пределом не даст вставить
                        dq.insert(dq.index(bar) + 1, [sec, price, price, price, price, size])
                        return
                return
            dq.append([sec, price, price, price, price, size])

    def get(self, coin: str) -> list[list]:
        with self.lock:
            return [list(b) for b in self.bars.get(coin, ())]


class SecondsFeed:
    """Поток сделок Bybit в фоне: переподключается сам, подписки — по списку монет coins()."""

    def __init__(self, coins: Callable[[], list[str]], url: str = URL, connect=None):
        self.coins, self.url = coins, url
        self.store = SecondBars()
        self.connect = connect  # для тестов: фабрика соединения
        self.subscribed: set[str] = set()
        self.ok_at: float | None = None

    def handle(self, raw: str) -> None:
        msg = json.loads(raw)
        topic = msg.get("topic", "")
        if not topic.startswith("publicTrade."):
            return
        coin = topic.split(".", 1)[1].removesuffix("USDT")
        for t in msg.get("data") or ():
            try:
                self.store.add(coin, int(t["T"]), float(t["p"]), float(t["v"]))
            except (KeyError, TypeError, ValueError):
                continue
        self.ok_at = time.time()

    def _send(self, ws, op: str, coins: list[str]) -> None:
        topics = [f"publicTrade.{c}USDT" for c in coins]
        for i in range(0, len(topics), MAX_ARGS):
            ws.send(json.dumps({"op": op, "args": topics[i:i + MAX_ARGS]}))

    def _sync(self, ws) -> None:
        want = set(self.coins())
        if add := sorted(want - self.subscribed):
            self._send(ws, "subscribe", add)
        if drop := sorted(self.subscribed - want):
            self._send(ws, "unsubscribe", drop)
        self.subscribed = want

    def run_once(self) -> None:
        """Одно соединение: подписаться и читать, пока не оборвётся."""
        import websocket  # websocket-client

        ws = self.connect() if self.connect else websocket.create_connection(self.url, timeout=10)
        self.subscribed = set()
        try:
            self._sync(ws)
            ping = recheck = time.time()
            ws.settimeout(5)
            while True:
                try:
                    self.handle(ws.recv())
                except websocket.WebSocketTimeoutException:
                    pass
                now = time.time()
                if now - ping > PING_SECONDS:
                    ws.send(json.dumps({"op": "ping"}))
                    ping = now
                if now - recheck > RECHECK_SECONDS:
                    self._sync(ws)
                    recheck = now
        finally:
            ws.close()

    def run(self) -> None:
        delay = 2
        while True:
            started = time.time()
            try:
                self.run_once()
            except Exception as exc:
                log.warning("поток сделок для графика «1с»: %s", exc)
            if time.time() - started > 60:
                delay = 2  # соединение жило долго — значит, это обычный обрыв
            time.sleep(delay)
            delay = min(60, delay * 2)

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self.run, name="seconds", daemon=True)
        t.start()
        return t
