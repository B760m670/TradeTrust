"""P2P Bybit для владельца — только чтение: стакан объявлений, спред, ваши ордера, статистика, уведомления.

Бот ничего не покупает, не продаёт, не отпускает монеты и не меняет объявления: в P2P главный риск — люди
(чужие деньги, фальшивые чеки), и отпускать USDT можно только после того, как вы сами увидели оплату в банке.

API: https://bybit-exchange.github.io/docs/p2p/guide — доступен только рекламодателям (General Advertiser и выше).
Все запросы — POST с JSON, подпись как у V5.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import asdict, dataclass

from .bybit import BybitClient

log = logging.getLogger(__name__)

TOKEN = "USDT"
# статусы ордера из документации Bybit
STATUS = {
    5: "ждёт сеть", 10: "ждём оплату покупателя", 20: "оплачен — ждём, пока продавец отпустит монеты",
    30: "апелляция", 40: "отменён", 50: "завершён", 60: "оплата онлайн", 70: "оплата не прошла",
    80: "отменён (обмен)", 90: "покупатель выбирает монету", 100: "возражение", 110: "ждём возражение",
}
OPEN = {5, 10, 20, 30, 60, 90, 100, 110}
CACHE_SECONDS = 20       # стакан не чаще раза в 20 секунд: лимиты Bybit и бережём ключ
ALERT_EVERY = 300        # проверка спреда для уведомления — раз в 5 минут
ALERT_COOLDOWN = 2 * 3600
PAY_WARN_SECONDS = 300   # «осталось 5 минут оплатить»
DEFAULT_PREFS = {"amount": 0.0, "payments": [], "min_rate": 90, "min_orders": 20, "alert_pct": 0.0}


@dataclass
class Ad:
    id: str
    nick: str
    price: float
    quantity: float     # сколько USDT ещё можно купить/продать по объявлению
    min_amount: float   # лимиты в валюте
    max_amount: float
    payments: list[str]
    orders: int         # сделок за 30 дней
    rate: int           # процент выполнения за 30 дней
    online: bool
    tags: list[str]


def _num(x, default=0.0) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return default


def parse_ad(item: dict) -> Ad:
    return Ad(str(item.get("id", "")), item.get("nickName", ""), _num(item.get("price")),
              _num(item.get("lastQuantity", item.get("quantity"))), _num(item.get("minAmount")),
              _num(item.get("maxAmount")), [str(p) for p in item.get("payments") or []],
              int(_num(item.get("recentOrderNum"))), int(_num(item.get("recentExecuteRate"))),
              bool(item.get("isOnline")), list(item.get("authTag") or []))


def fits(ad: Ad, amount: float, payments: list[str], min_rate: int, min_orders: int) -> bool:
    """Объявление подходит: продавец/покупатель онлайн и надёжен, ваша сумма в его лимитах, есть ваш способ оплаты."""
    if not ad.online or ad.rate < min_rate or ad.orders < min_orders or ad.price <= 0:
        return False
    if amount and not (ad.min_amount <= amount <= ad.max_amount and ad.quantity * ad.price >= amount):
        return False
    return not payments or bool(set(payments) & set(ad.payments))


def spread(bid: float | None, ask: float | None, fee_pct: float = 0.0) -> dict:
    """bid — лучшая цена, по которой у вас купят USDT (объявления на покупку), ask — по которой вам продадут.

    maker — круг через свои объявления: покупаете по цене лучших покупателей, продаёте по цене лучших продавцов;
    taker — сразу по чужим объявлениям: купить у продавца и продать покупателю (обычно в минусе)."""
    if not bid or not ask:
        return {"bid": bid, "ask": ask, "maker_pct": None, "taker_pct": None, "fee_pct": fee_pct}
    return {"bid": bid, "ask": ask, "fee_pct": fee_pct,
            "maker_pct": (ask / bid - 1) * 100 - 2 * fee_pct, "taker_pct": (bid / ask - 1) * 100}


class P2PClient:
    def __init__(self, client: BybitClient):
        self.c = client

    def _post(self, path: str, body: dict | None = None):
        return self.c._request("POST", path, body or {}, auth=True)

    def online_ads(self, currency: str, side: str, size: int = 100) -> list[Ad]:
        """side — сторона автора объявления: "0" — он покупает USDT, "1" — продаёт."""
        res = self._post("/v5/p2p/item/online", {"tokenId": TOKEN, "currencyId": currency, "side": side,
                                                 "page": "1", "size": str(size)})
        return [parse_ad(i) for i in res.get("items") or []]

    def account(self) -> dict:
        return self._post("/v5/p2p/user/personal/info") or {}

    def payments(self) -> list[dict]:
        res = self._post("/v5/p2p/user/payment/list")
        return res if isinstance(res, list) else []

    def my_ads(self) -> list[dict]:
        return (self._post("/v5/p2p/item/personal/list", {"page": "1", "size": "30"}) or {}).get("items") or []

    def pending_orders(self) -> list[dict]:
        return (self._post("/v5/p2p/order/pending/simplifyList", {"page": 1, "size": 30}) or {}).get("items") or []

    def orders(self, since_ms: int, pages: int = 5) -> list[dict]:
        out = []
        for page in range(1, pages + 1):
            items = (self._post("/v5/p2p/order/simplifyList", {"page": page, "size": 30, "beginTime": str(since_ms)})
                     or {}).get("items") or []
            out += items
            if len(items) < 30:
                break
        return out


def order_view(o: dict) -> dict:
    """Ордер с вашей стороны: вы покупаете или продаёте USDT, за сколько, с кем, в каком он статусе."""
    status = int(_num(o.get("status")))
    price, amount = _num(o.get("price")), _num(o.get("amount"))
    side = "buy" if int(_num(o.get("side"))) == 0 else "sell"
    return {
        "id": str(o.get("id", "")), "side": side, "status": status, "status_text": STATUS.get(status, str(status)),
        "price": price, "amount": amount, "qty": amount / price if price else 0.0, "currency": o.get("currencyId", ""),
        "token": o.get("tokenId", TOKEN), "who": o.get("targetNickName", ""),
        "buyer_name": o.get("buyerRealName", ""), "seller_name": o.get("sellerRealName", ""),
        "created": int(_num(o.get("createDate"))), "seconds_left": int(_num(o.get("transferLastSeconds"))),
    }


def stats(orders: list[dict]) -> dict:
    """Завершённые ордера по валютам: сколько куплено и продано, средние цены, прибыль на совпавшем объёме."""
    out: dict[str, dict] = {}
    for o in map(order_view, orders):
        if o["status"] != 50 or not o["qty"]:
            continue
        s = out.setdefault(o["currency"], {"buy_qty": 0.0, "buy_fiat": 0.0, "sell_qty": 0.0, "sell_fiat": 0.0, "orders": 0})
        s[f"{o['side']}_qty"] += o["qty"]
        s[f"{o['side']}_fiat"] += o["amount"]
        s["orders"] += 1
    for s in out.values():
        s["buy_price"] = s["buy_fiat"] / s["buy_qty"] if s["buy_qty"] else None
        s["sell_price"] = s["sell_fiat"] / s["sell_qty"] if s["sell_qty"] else None
        matched = min(s["buy_qty"], s["sell_qty"])
        s["profit"] = matched * (s["sell_price"] - s["buy_price"]) if matched else 0.0
    return out


class P2PDesk:
    """Слежение за P2P владельца: стакан и спред (с кэшем), ордера и их статусы, уведомления в Telegram."""

    def __init__(self, client: P2PClient, store, notify, currencies: list[str]):
        self.p2p, self.store, self.notify = client, store, notify
        self.currencies = currencies or ["RUB"]
        self.error = ""
        self._cache: dict[str, tuple[float, dict]] = {}
        self._names: dict[str, str] | None = None
        self._last_alert_check = 0.0
        self.lock = threading.Lock()

    # --- настройки экрана: сумма, способы оплаты, фильтры, порог уведомления ----------
    def prefs(self, currency: str) -> dict:
        saved = (self.store.get("p2p_prefs") or {}).get(currency) or {}
        prefs = {**DEFAULT_PREFS, **saved}
        if "payments" not in saved:  # по умолчанию — ваши собственные способы оплаты
            prefs["payments"] = [p for p in self.payment_names() if p not in ("377",)]
        return prefs

    def set_prefs(self, currency: str, changes: dict) -> dict:
        if currency not in self.currencies:
            raise ValueError(f"валюта: {', '.join(self.currencies)}")
        prefs = self.prefs(currency)
        for key, kind, lo, hi in (("amount", float, 0, 1e9), ("min_rate", int, 0, 100), ("min_orders", int, 0, 100000),
                                  ("alert_pct", float, 0, 50)):
            if key in changes:
                value = changes[key]
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not lo <= value <= hi:
                    raise ValueError(f"{key}: число от {lo} до {hi:g}")
                prefs[key] = kind(value)
        if "payments" in changes:
            pays = changes["payments"]
            if not isinstance(pays, list) or not all(isinstance(p, str) for p in pays) or len(pays) > 20:
                raise ValueError("payments: список id способов оплаты")
            prefs["payments"] = pays
        all_prefs = self.store.get("p2p_prefs") or {}
        all_prefs[currency] = prefs
        self.store.set("p2p_prefs", all_prefs)
        return prefs

    def payment_names(self) -> dict[str, str]:
        """Названия способов оплаты, которые есть у вас: id типа → «Tinkoff», «Sberbank»… (у Bybit нет общего списка)."""
        if self._names is None:
            names = {}
            for p in self.p2p.payments():
                cfg = p.get("paymentConfigVo") or {}
                ptype = str(p.get("paymentType") or cfg.get("paymentType") or "")
                if ptype:
                    names[ptype] = cfg.get("paymentName") or p.get("bankName") or ptype
            self._names = names
        return self._names

    # --- стакан ---------------------------------------------------------------------
    def market(self, currency: str) -> dict:
        now = time.time()
        hit = self._cache.get(currency)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
        prefs = self.prefs(currency)
        buyers, sellers = self.p2p.online_ads(currency, "0"), self.p2p.online_ads(currency, "1")
        pick = lambda ads: [a for a in ads if fits(a, prefs["amount"], prefs["payments"],  # noqa: E731
                                                   prefs["min_rate"], prefs["min_orders"])]
        bids = sorted(pick(buyers), key=lambda a: -a.price)
        asks = sorted(pick(sellers), key=lambda a: a.price)
        seen: dict[str, int] = {}
        for a in buyers + sellers:
            for p in a.payments:
                seen[p] = seen.get(p, 0) + 1
        names = self.payment_names()
        result = {
            "currency": currency, "prefs": prefs, "updated_at": int(now),
            **spread(bids[0].price if bids else None, asks[0].price if asks else None, self.fee_pct(currency)),
            "bids": [asdict(a) for a in bids[:5]], "asks": [asdict(a) for a in asks[:5]],
            "total": {"bids": len(buyers), "asks": len(sellers)},
            "payments": sorted(({"id": p, "name": names.get(p, f"способ #{p}"), "ads": n, "mine": p in names}
                                for p, n in seen.items()), key=lambda x: (not x["mine"], -x["ads"]))[:30],
        }
        self._cache[currency] = (now, result)
        return result

    def fee_pct(self, currency: str) -> float:
        """Комиссия мейкера по вашим объявлениям в этой валюте (feeRate), если есть; иначе 0."""
        try:
            rates = [_num(a.get("feeRate")) for a in self.p2p.my_ads() if a.get("currencyId") == currency]
        except Exception:
            return 0.0
        rate = max(rates, default=0.0)
        return rate * 100 if 0 < rate < 0.05 else rate  # Bybit может отдавать долю (0.001) или проценты

    # --- ордера и уведомления --------------------------------------------------------
    def poll(self) -> None:
        """Раз в минуту: новые ордера и смена статуса — в Telegram; раз в 5 минут — проверка спреда для уведомления."""
        with self.lock:
            try:
                self._watch_orders()
                if time.time() - self._last_alert_check >= ALERT_EVERY:
                    self._last_alert_check = time.time()
                    self._spread_alerts()
                self.error = ""
            except Exception as exc:
                self.error = explain(exc)
                raise

    def _watch_orders(self) -> None:
        saved = self.store.get("p2p_seen")
        first_run = saved is None  # при первом запуске старые ордера не объявляем
        seen: dict = saved or {}
        current = {}
        for o in map(order_view, self.p2p.pending_orders()):
            current[o["id"]] = o["status"]
            before = seen.get(o["id"])
            if not first_run and before != o["status"]:
                self.notify(self._order_text(o, new=before is None))
            if o["status"] == 10 and o["side"] == "buy" and 0 < o["seconds_left"] <= PAY_WARN_SECONDS:
                warned = self.store.get("p2p_warned") or []
                if o["id"] not in warned:
                    self.notify(f"⏰ {self._head(o)}: осталось {max(1, o['seconds_left'] // 60)} мин, чтобы оплатить "
                                "и нажать «Оплачено» в Bybit")
                    self.store.set("p2p_warned", (warned + [o["id"]])[-50:])
        # ордер пропал из «в процессе» — узнаём, чем закончился
        gone = [oid for oid in seen if oid not in current]
        if gone and not first_run:
            recent = {o["id"]: o for o in map(order_view, self.p2p.orders(int((time.time() - 3 * 86400) * 1000), pages=1))}
            for oid in gone:
                o = recent.get(oid)
                if o and o["status"] in (40, 50, 80):
                    self.notify(self._order_text(o, new=False))
        self.store.set("p2p_seen", current)

    def _head(self, o: dict) -> str:
        what = "вы покупаете" if o["side"] == "buy" else "вы продаёте"
        return (f"{what} {o['qty']:,.2f} {o['token']} по {o['price']:,.2f} = {o['amount']:,.0f} {o['currency']}"
                .replace(",", " "))

    def _order_text(self, o: dict, new: bool) -> str:
        head, who = self._head(o), o["who"] or "контрагент"
        if o["status"] == 20 and o["side"] == "sell":
            name = f" (в Bybit: {o['buyer_name']})" if o["buyer_name"] else ""
            return (f"💰 Покупатель {who} отметил оплату: {head}.\nПроверьте поступление в банке именно от этого "
                    f"человека{name} и только потом отпустите USDT в Bybit. Бот монеты не отпускает.")
        if o["status"] == 20:
            return f"⏳ Вы отметили оплату: {head}. Ждём, пока продавец {who} отпустит USDT."
        if o["status"] == 30:
            return f"⚠️ Апелляция: {head}, контрагент {who}. Ответьте в чате ордера в Bybit."
        if o["status"] == 50:
            return f"✅ Ордер завершён: {head}."
        if o["status"] in (40, 80):
            return f"❌ Ордер отменён: {head}."
        prefix = "🆕 Новый ордер" if new else "🔄 Ордер"
        return f"{prefix}: {head}, контрагент {who} — {o['status_text']}."

    def _spread_alerts(self) -> None:
        sent: dict = self.store.get("p2p_alerts") or {}
        for currency in self.currencies:
            prefs = self.prefs(currency)
            if not prefs["alert_pct"]:
                continue
            m = self.market(currency)
            if m["maker_pct"] is None or m["maker_pct"] < prefs["alert_pct"]:
                continue
            if time.time() - sent.get(currency, 0) < ALERT_COOLDOWN:
                continue
            self.notify(f"📊 Спред {currency}: {m['maker_pct']:.2f}% (порог {prefs['alert_pct']:g}%). Покупают по "
                        f"{m['bid']:,.2f}, продают по {m['ask']:,.2f} — ваши фильтры и способы оплаты.".replace(",", " "))
            sent[currency] = time.time()
        self.store.set("p2p_alerts", sent)

    # --- экран P2P ---------------------------------------------------------------------
    def view(self, currency: str) -> dict:
        out = {"available": True, "currencies": self.currencies, "currency": currency, "error": ""}
        try:
            acc = self.p2p.account()
            out["account"] = {k: acc.get(k) for k in ("nickName", "recentRate", "recentFinishCount", "totalFinishCount",
                                                      "averageReleaseTime", "averageTransferTime", "recentTradeAmount",
                                                      "goodAppraiseRate", "authStatus", "isOnline")}
            out["market"] = self.market(currency)
            out["pending"] = [order_view(o) for o in self.p2p.pending_orders()]
            out["stats"] = stats(self.p2p.orders(int((time.time() - 30 * 86400) * 1000)))
        except Exception as exc:
            log.warning("p2p view: %s", exc)
            out["error"] = explain(exc)
        return out


def explain(exc: Exception) -> str:
    text = str(exc)
    if "403" in text or "permission" in text.lower() or "advertiser" in text.lower():
        return ("Bybit не дал доступ к P2P API. Он открыт только рекламодателям (General Advertiser и выше), "
                f"и у ключа должны быть права P2P. Ответ Bybit: {text[:200]}")
    return text[:300]
