"""P2P Bybit для владельца: стакан объявлений, спред, ваши ордера, статистика, уведомления — и ваши объявления
(цена, количество, снять или вернуть в выдачу) по вашей команде из приложения.

Бот ничего не покупает, не продаёт и не отпускает монеты: в P2P главный риск — люди (чужие деньги, фальшивые
чеки), и отпускать USDT можно только после того, как вы сами увидели оплату в банке. Цену объявления бот не
поставит дальше MAX_PRICE_MOVE от лучшего конкурента — защита от опечатки.

API: https://bybit-exchange.github.io/docs/p2p/guide — доступен только рекламодателям (General Advertiser и выше).
Все запросы — POST с JSON, подпись как у V5.
"""
from __future__ import annotations

import csv
import io
import logging
import statistics
import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone

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
RELEASE_REMIND = 600     # покупатель отметил оплату, а монеты не отпущены 10 минут — напомнить
LEVEL_CACHE = 600        # прогресс уровня мейкера — раз в 10 минут (история ордеров — тяжёлый запрос)
# уровни мейкера Bybit: уникальные контрагенты за всё время и объём за 30 дней (USDT) — как на экране «Уровни»
LEVELS = [("Регулярный", 5, 2000.0, "объявления на покупку и продажу, до 20 000 USDT, по 2 объявления"),
          ("Опытный", 5, 10000.0, "до 50 000 USDT на объявление, по 3 объявления")]
# уведомления по ордерам: important — только то, чего нет в приложении Bybit (апелляция, напоминания);
# all — ещё и каждый новый ордер и смена статуса
NOTIFY_MODES = ("important", "all")
MAX_PRICE_MOVE = 1.5     # %, дальше от лучшего конкурента цену объявления не ставим
TICK = 0.01              # шаг цены: «Стать #1» — на копейку лучше лучшего конкурента
LOW_LEFT = 0.1           # объявление «заканчивается»: осталось меньше 10% или меньше минимальной сделки
DEFAULT_PREFS = {"amount": 0.0, "payments": [], "min_rate": 90, "min_orders": 20, "alert_pct": 0.0,
                 # расходы на круг, % от суммы: комиссия мейкера за объявление на покупку (у Bybit по RUB ~0,25–0,3%
                 # с 19.01.2026 — сверьте в кабинете), за объявление на продажу, банк/сеть/прочее
                 "fee_buy_pct": 0.0, "fee_sell_pct": 0.0, "extra_pct": 0.0,
                 # лимиты по способам оплаты: id способа → {"day": сумма, "month": сумма}; общий месячный оборот
                 "limits": {}, "month_cap": 0.0}
RUB_DEFAULTS = {"fee_buy_pct": 0.3, "month_cap": 3_500_000.0}  # порог «систематичности» по 282-ФЗ — по пересказам СМИ
MSK = timezone(timedelta(hours=3))
WARN_AT = 0.8  # предупреждать при 80% лимита


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


def n(x: float, digits: int = 2) -> str:
    """Число по-русски: 12 360,50."""
    return f"{x:,.{digits}f}".replace(",", " ").replace(".", ",")


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


def spread(bid: float | None, ask: float | None, fee_buy: float = 0.0, fee_sell: float = 0.0, extra: float = 0.0) -> dict:
    """bid — лучшая цена, по которой у вас купят USDT (объявления на покупку), ask — по которой вам продадут.

    maker — круг через свои объявления: покупаете по цене лучших покупателей, продаёте по цене лучших продавцов;
    gross — до расходов, maker_pct — чистыми: минус комиссии мейкера за оба объявления и прочие расходы на круг;
    taker — сразу по чужим объявлениям: купить у продавца и продать покупателю (обычно в минусе)."""
    costs = fee_buy + fee_sell + extra
    if not bid or not ask:
        return {"bid": bid, "ask": ask, "gross_pct": None, "maker_pct": None, "taker_pct": None, "costs_pct": costs,
                "crossed": False}
    gross = (ask / bid - 1) * 100
    # перекрытый стакан: покупают дороже, чем продают — почти всегда разные способы оплаты или лимиты, а не прибыль
    return {"bid": bid, "ask": ask, "gross_pct": gross, "costs_pct": costs, "maker_pct": gross - costs,
            "taker_pct": (bid / ask - 1) * 100, "crossed": bid > ask}


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

    def ad_detail(self, ad_id: str) -> dict:
        return self._post("/v5/p2p/item/info", {"itemId": ad_id}) or {}

    def update_ad(self, body: dict) -> dict:
        """Изменить объявление (actionType MODIFY) или вернуть в выдачу (ACTIVE): Bybit ждёт все поля целиком."""
        return self._post("/v5/p2p/item/update", body) or {}

    def remove_ad(self, ad_id: str) -> None:
        self._post("/v5/p2p/item/cancel", {"itemId": ad_id})

    def pending_orders(self) -> list[dict]:
        return (self._post("/v5/p2p/order/pending/simplifyList", {"page": 1, "size": 30}) or {}).get("items") or []

    def order_detail(self, order_id: str) -> dict:
        return self._post("/v5/p2p/order/info", {"orderId": order_id}) or {}

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
        "who_id": str(o.get("targetUserId", "")),
    }


def my_ad_view(item: dict, names: dict[str, str]) -> dict:
    """Ваше объявление: сторона, цена, сколько осталось, лимиты, способы оплаты, статус."""
    terms = item.get("paymentTerms") or []
    pays = [str(t.get("paymentType")) for t in terms if t.get("paymentType") is not None] or \
        [str(x) for x in item.get("payments") or []]
    status = int(_num(item.get("status")))
    return {
        "id": str(item.get("id", "")), "side": "buy" if str(item.get("side")) == "0" else "sell",
        "token": item.get("tokenId", TOKEN), "currency": item.get("currencyId", ""), "price": _num(item.get("price")),
        "left": _num(item.get("lastQuantity")), "total": _num(item.get("quantity")),
        "done": _num(item.get("executedQuantity")), "min_amount": _num(item.get("minAmount")),
        "max_amount": _num(item.get("maxAmount")), "payments": [names.get(x, f"способ #{x}") for x in pays],
        "pay_ids": pays, "online": status == 10, "status": status,
        "status_text": {10: "в сети", 20: "снято с публикации", 30: "завершено"}.get(status, str(status)),
        "fee_pct": (lambda r: r * 100 if 0 < r < 0.05 else r)(_num(item.get("feeRate"))),
        "remark": item.get("remark", ""),
    }


def rank(price: float, side: str, ads: list[Ad], pays: list[str] | None = None, skip: str = "") -> int:
    """Место объявления в выдаче Bybit: продаёте — выше вас те, кто дешевле; покупаете — кто дороже.
    pays — считать только конкурентов с теми же способами оплаты."""
    rivals = [a for a in ads if a.id != skip and a.online and (not pays or set(pays) & set(a.payments))]
    better = [a for a in rivals if (a.price < price if side == "sell" else a.price > price)]
    return len(better) + 1


def rivals(ads: list[Ad], side: str, pays: list[str], lo: float, hi: float, skip: str = "",
           min_rate: int = 90, min_orders: int = 20) -> list[Ad]:
    """Настоящие конкуренты объявления, лучшие первыми: в сети, с вашими способами оплаты, с пересекающимися лимитами
    сделки и надёжные (выполнение и число сделок). Без этого «лучшим» оказывается объявление на 500 ₽ или от
    новичка с ценой не по рынку."""
    out = [a for a in ads if a.id != skip and a.online and a.price > 0 and (not pays or set(pays) & set(a.payments))
           and a.rate >= min_rate and a.orders >= min_orders
           and (not hi or a.min_amount <= hi) and (not lo or (a.max_amount >= lo and a.quantity * a.price >= lo))]
    return sorted(out, key=lambda a: a.price if side == "sell" else -a.price)


def reference(prices: list[float]) -> float | None:
    """Опорная цена рынка — медиана пяти лучших конкурентов: одно объявление-выброс её не сдвигает."""
    top = prices[:5]
    return statistics.median(top) if top else None


def top_price(side: str, best_rival: float | None) -> float | None:
    """Цена, с которой объявление станет первым: на копейку лучше лучшего конкурента с теми же банками."""
    if best_rival is None:
        return None
    return round(best_rival - TICK if side == "sell" else best_rival + TICK, 2)


def update_body(d: dict, *, price: float | None = None, quantity: float | None = None, relist: bool = False) -> dict:
    """Тело запроса на изменение объявления из его текущих данных (/item/info): Bybit требует все поля.
    quantity у Bybit — всё количество объявления, вместе с уже проданным и замороженным в ордерах; поэтому
    по умолчанию отправляем его без изменений, а quantity здесь — сколько должно ОСТАТЬСЯ в продаже."""
    pref = {k: str(v) for k, v in (d.get("tradingPreferenceSet") or {}).items() if v is not None}
    pays = [str(t.get("id")) for t in d.get("paymentTerms") or [] if t.get("id") is not None] or \
        [str(x) for x in d.get("payments") or []]
    return {
        "id": str(d.get("id", "")), "priceType": str(d.get("priceType", 0)), "premium": str(d.get("premium") or ""),
        "price": str(price if price is not None else d.get("price", "")),
        "minAmount": str(d.get("minAmount", "")), "maxAmount": str(d.get("maxAmount", "")),
        "remark": d.get("remark") or "", "tradingPreferenceSet": pref, "paymentIds": pays,
        "actionType": "ACTIVE" if relist else "MODIFY",
        "quantity": str(_qty(d, quantity)),
        "paymentPeriod": str(d.get("paymentPeriod", 15)),
    }


def _qty(d: dict, left: float | None) -> str:
    """Всё количество объявления для запроса: без изменений — как есть; иначе — нужный остаток плюс уже
    использованное (продано и заморожено в ордерах = всё − остаток)."""
    total = _num(d.get("quantity"))
    if left is None:
        return str(d.get("quantity", ""))
    used = max(0.0, total - _num(d.get("lastQuantity", total)))
    return f"{round(left + used, 4):g}"


def level_progress(orders: list[dict], now: float | None = None) -> dict:
    """Прогресс уровня мейкера по завершённым ордерам: уникальные контрагенты (за доступную историю) и объём
    за 30 дней в USDT. Bybit считает сам и может расходиться на 1–2 сделки — это ориентир."""
    now = now or time.time()
    done = [o for o in map(order_view, orders) if o["status"] == 50]
    people = {o["who_id"] or o["who"] for o in done if o["who_id"] or o["who"]}
    volume = sum(o["qty"] for o in done if o["created"] >= (now - 30 * 86400) * 1000)
    levels = [{"name": name, "people": need_p, "volume": need_v, "perks": perks,
               "done": len(people) >= need_p and volume >= need_v} for name, need_p, need_v, perks in LEVELS]
    nxt = next((lv for lv in levels if not lv["done"]), None)
    return {"counterparties": len(people), "volume_30d": volume, "levels": levels, "next": nxt["name"] if nxt else None}


def fifo_journal(orders: list[dict]) -> list[dict]:
    """Журнал завершённых ордеров по времени с результатом продаж по FIFO (себестоимость — цены ваших покупок).
    Партии считаются отдельно по каждой валюте: рубли с долларами не смешиваются."""
    lots: dict[str, list[list[float]]] = {}
    out = []
    for o in sorted(orders, key=lambda x: x["created"]):
        row = {**o, "cost": None, "result": None, "uncovered": 0.0}
        q = lots.setdefault(o["currency"], [])
        if o["side"] == "buy":
            q.append([o["qty"], o["price"]])
        else:
            need, cost = o["qty"], 0.0
            while need > 1e-12 and q:
                take = min(need, q[0][0])
                cost += take * q[0][1]
                q[0][0] -= take
                need -= take
                if q[0][0] <= 1e-12:
                    q.pop(0)
            row["uncovered"] = need  # продано больше, чем куплено за период: себестоимость части неизвестна
            row["cost"] = cost
            row["result"] = (o["qty"] - need) * o["price"] - cost
        out.append(row)
    return out


def journal_csv(rows: list[dict]) -> bytes:
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["Дата (МСК)", "Ордер", "Сторона", "Монета", "Количество", "Цена", "Сумма", "Валюта", "Контрагент",
                "Способ оплаты", "Себестоимость проданного (FIFO)", "Результат продажи (FIFO)", "Без себестоимости, шт."])
    num = lambda x: "" if x is None else f"{x:.8f}".rstrip("0").rstrip(".").replace(".", ",")  # noqa: E731
    for r in rows:
        when = datetime.fromtimestamp(r["created"] / 1000, MSK).strftime("%d.%m.%Y %H:%M")
        w.writerow([when, r["id"], "покупка" if r["side"] == "buy" else "продажа", r["token"], num(r["qty"]),
                    num(r["price"]), num(r["amount"]), r["currency"], r["who"], r.get("pay_name", ""),
                    num(r["cost"]), num(r["result"]), num(r["uncovered"]) if r["uncovered"] else ""])
    return ("\ufeff" + buf.getvalue()).encode("utf-8")  # BOM — чтобы Excel открыл кириллицу


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
        self._raw: dict[str, tuple[list[Ad], list[Ad]]] = {}  # все объявления (без фильтров) — для места в выдаче
        self._level: tuple[float, dict] | None = None
        self._last_alert_check = 0.0
        self.lock = threading.Lock()

    # --- настройки экрана: сумма, способы оплаты, фильтры, порог уведомления ----------
    def prefs(self, currency: str) -> dict:
        saved = (self.store.get("p2p_prefs") or {}).get(currency) or {}
        prefs = {**DEFAULT_PREFS, **(RUB_DEFAULTS if currency == "RUB" else {}), **saved}
        if "payments" not in saved:  # по умолчанию — ваши собственные способы оплаты
            prefs["payments"] = [p for p in self.payment_names() if p not in ("377",)]
        return prefs

    @property
    def notify_mode(self) -> str:
        mode = self.store.get("p2p_notify")
        return mode if mode in NOTIFY_MODES else "important"

    def set_prefs(self, currency: str, changes: dict) -> dict:
        if "notify" in changes:
            if changes["notify"] not in NOTIFY_MODES:
                raise ValueError(f"notify: {' или '.join(NOTIFY_MODES)}")
            self.store.set("p2p_notify", changes["notify"])
        if currency not in self.currencies:
            raise ValueError(f"валюта: {', '.join(self.currencies)}")
        prefs = self.prefs(currency)
        for key, kind, lo, hi in (("amount", float, 0, 1e9), ("min_rate", int, 0, 100), ("min_orders", int, 0, 100000),
                                  ("alert_pct", float, 0, 50), ("fee_buy_pct", float, 0, 5), ("fee_sell_pct", float, 0, 5),
                                  ("extra_pct", float, 0, 10), ("month_cap", float, 0, 1e12)):
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
        if "limits" in changes:
            limits = changes["limits"]
            ok = isinstance(limits, dict) and len(limits) <= 20 and all(
                isinstance(k, str) and isinstance(v, dict) and all(
                    p in ("day", "month") and isinstance(x, (int, float)) and not isinstance(x, bool) and 0 <= x <= 1e12
                    for p, x in v.items()) for k, v in limits.items())
            if not ok:
                raise ValueError("limits: {способ: {day: сумма, month: сумма}}")
            prefs["limits"] = {k: {p: float(x) for p, x in v.items() if x} for k, v in limits.items()}
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
        self._raw[currency] = (buyers, sellers)
        bids = sorted(pick(buyers), key=lambda a: -a.price)
        asks = sorted(pick(sellers), key=lambda a: a.price)
        seen: dict[str, int] = {}
        for a in buyers + sellers:
            for p in a.payments:
                seen[p] = seen.get(p, 0) + 1
        names = self.payment_names()
        result = {
            "currency": currency, "prefs": prefs, "updated_at": int(now),
            **spread(bids[0].price if bids else None, asks[0].price if asks else None,
                     prefs["fee_buy_pct"], prefs["fee_sell_pct"], prefs["extra_pct"]),
            "ad_fee_pct": self.fee_pct(currency),  # что Bybit пишет в ваших объявлениях — для сверки
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
                    try:
                        self._ad_alerts()
                    except Exception as exc:  # подсказки по объявлениям не важнее ордеров
                        log.warning("p2p ad alerts: %s", exc)
                self.error = ""
            except Exception as exc:
                self.error = explain(exc)
                raise

    def _watch_orders(self) -> None:
        saved = self.store.get("p2p_seen")
        first_run = saved is None  # при первом запуске старые ордера не объявляем
        seen: dict = saved or {}
        current = {}
        everything = self.notify_mode == "all"
        paid_at: dict = self.store.get("p2p_paid_at") or {}
        for o in map(order_view, self.p2p.pending_orders()):
            current[o["id"]] = o["status"]
            before = seen.get(o["id"])
            if not first_run and before != o["status"] and (everything or o["status"] == 30):
                self.notify(self._order_text(o, new=before is None))
            if o["status"] == 20 and o["side"] == "sell":  # ждут, пока вы отпустите монеты
                since = paid_at.setdefault(o["id"], time.time())
                reminded = self.store.get("p2p_reminded") or []
                if time.time() - since >= RELEASE_REMIND and o["id"] not in reminded:
                    name = f" ({o['buyer_name']})" if o["buyer_name"] else ""
                    self.notify(f"⏳ {self._head(o)}: покупатель{name} отметил оплату {int((time.time() - since) // 60)} "
                                "мин назад. Проверьте банк: деньги пришли от него — отпустите USDT; не пришли или "
                                "от другого человека — не отпускайте, напишите в чат ордера.")
                    self.store.set("p2p_reminded", (reminded + [o["id"]])[-50:])
            if o["status"] == 10 and o["side"] == "buy" and 0 < o["seconds_left"] <= PAY_WARN_SECONDS:
                warned = self.store.get("p2p_warned") or []
                if o["id"] not in warned:
                    self.notify(f"⏰ {self._head(o)}: осталось {max(1, o['seconds_left'] // 60)} мин, чтобы оплатить "
                                "и нажать «Оплачено» в Bybit")
                    self.store.set("p2p_warned", (warned + [o["id"]])[-50:])
        self.store.set("p2p_paid_at", {k: v for k, v in paid_at.items() if k in current})
        # ордер пропал из «в процессе» — узнаём, чем закончился
        gone = [oid for oid in seen if oid not in current]
        if gone and not first_run:
            recent = {o["id"]: o for o in map(order_view, self.p2p.orders(int((time.time() - 3 * 86400) * 1000), pages=1))}
            finished = False
            for oid in gone:
                o = recent.get(oid)
                if o and o["status"] in (40, 50, 80):
                    if everything:
                        self.notify(self._order_text(o, new=False))
                    finished |= o["status"] == 50
            if finished:
                try:
                    self._check_limits()
                except Exception as exc:  # лимиты — подсказка, ордера важнее
                    log.warning("p2p limits: %s", exc)
        self.store.set("p2p_seen", current)

    def _head(self, o: dict) -> str:
        what = "вы покупаете" if o["side"] == "buy" else "вы продаёте"
        return f"{what} {n(o['qty'])} {o['token']} по {n(o['price'])} = {n(o['amount'], 0)} {o['currency']}"

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
            self.notify(f"📊 Чистый спред {currency}: {n(m['maker_pct'])}% (порог {n(prefs['alert_pct'])}%). Покупают по "
                        f"{n(m['bid'])}, продают по {n(m['ask'])}; расходы на круг {n(m['costs_pct'])}% учтены.")
            sent[currency] = time.time()
        self.store.set("p2p_alerts", sent)

    # --- карты, лимиты, журнал ------------------------------------------------------------
    def completed(self, since_ms: int, pages: int = 5) -> list[dict]:
        """Завершённые ордера с вашей стороны и способом оплаты (берём из деталей ордера, один раз на ордер)."""
        rows = [o for o in map(order_view, self.p2p.orders(since_ms, pages)) if o["status"] == 50]
        meta: dict = self.store.get("p2p_meta") or {}
        names = self.payment_names()
        for o in rows:
            if o["id"] not in meta:
                try:
                    d = self.p2p.order_detail(o["id"])
                except Exception as exc:
                    log.warning("p2p order detail %s: %s", o["id"], exc)
                    continue
                term = d.get("confirmedPayTerm") or {}
                ptype = str(term.get("paymentType") or d.get("paymentType") or "")
                name = (term.get("paymentConfigVo") or {}).get("paymentName") or names.get(ptype) or (f"способ #{ptype}" if ptype else "")
                meta[o["id"]] = {"pay": ptype, "pay_name": name}
            o.update(meta.get(o["id"], {"pay": "", "pay_name": ""}))
        if len(meta) > 2000:  # храним только недавние
            meta = dict(list(meta.items())[-1500:])
        self.store.set("p2p_meta", meta)
        return rows

    def ledger(self, currency: str, rows: list[dict] | None = None) -> dict:
        """Обороты по каждому способу оплаты за сегодня и за месяц (МСК), число разных контрагентов, лимиты."""
        now = datetime.now(MSK)
        day0 = int(now.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        month0 = int(now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        if rows is None:
            rows = self.completed(month0)
        prefs = self.prefs(currency)
        cards: dict[str, dict] = {}
        people_day, people_month = set(), set()
        turnover = 0.0
        for o in rows:
            if o["currency"] != currency or o["created"] < month0:
                continue
            c = cards.setdefault(o["pay"], {"pay": o["pay"], "name": o["pay_name"] or "без способа", "day_in": 0.0,
                                            "day_out": 0.0, "month_in": 0.0, "month_out": 0.0, "people": set()})
            way = "in" if o["side"] == "sell" else "out"  # продаёте USDT — деньги приходят на карту
            c[f"month_{way}"] += o["amount"]
            c["people"].add(o["who_id"] or o["who"])
            people_month.add(o["who_id"] or o["who"])
            if o["created"] >= day0:
                c[f"day_{way}"] += o["amount"]
                people_day.add(o["who_id"] or o["who"])
            turnover += o["amount"]
        warnings = []
        for c in cards.values():
            c["people"] = len(c["people"])
            lim = prefs["limits"].get(c["pay"], {})
            c["limit"] = lim
            for period, label in (("day", "за день"), ("month", "за месяц")):
                used = c[f"{period}_in"] + c[f"{period}_out"]
                if lim.get(period) and used >= WARN_AT * lim[period]:
                    warnings.append({"key": f"{c['pay']}:{period}", "text": f"{c['name']}: оборот {label} "
                                     f"{n(used, 0)} из {n(lim[period], 0)} {currency} ({used / lim[period]:.0%})"})
        cap = prefs["month_cap"]
        if cap and turnover >= WARN_AT * cap:
            warnings.append({"key": "cap:month", "text": f"Оборот за месяц {n(turnover, 0)} из {n(cap, 0)} {currency} "
                             f"({turnover / cap:.0%}) — порог, который вы задали"})
        return {"currency": currency, "cards": sorted(cards.values(), key=lambda c: -(c["month_in"] + c["month_out"])),
                "turnover": turnover, "month_cap": cap, "people_day": len(people_day), "people_month": len(people_month),
                "warnings": warnings, "month": now.strftime("%m.%Y")}

    def _check_limits(self) -> None:
        """После завершённого ордера: предупредить один раз за период, когда оборот подходит к лимиту."""
        warned: dict = self.store.get("p2p_limit_warned") or {}
        period = datetime.now(MSK)
        for currency in self.currencies:
            prefs = self.prefs(currency)
            if not prefs["limits"] and not prefs["month_cap"]:
                continue
            for w in self.ledger(currency)["warnings"]:
                stamp = period.strftime("%Y-%m-%d") if w["key"].endswith(":day") else period.strftime("%Y-%m")
                if warned.get(f"{currency}:{w['key']}") != stamp:
                    self.notify(f"🧾 {w['text']}")
                    warned[f"{currency}:{w['key']}"] = stamp
        self.store.set("p2p_limit_warned", warned)

    def journal(self, days: int = 180) -> tuple[bytes, int]:
        """CSV всех завершённых ордеров за полгода (столько хранит Bybit) с FIFO — для учёта и 3-НДФЛ."""
        rows = fifo_journal(self.completed(int((time.time() - days * 86400) * 1000), pages=40))
        return journal_csv(rows), len(rows)

    def level(self) -> dict:
        """Прогресс до следующего уровня мейкера — история ордеров за полгода, раз в 10 минут."""
        if self._level and time.time() - self._level[0] < LEVEL_CACHE:
            return self._level[1]
        result = level_progress(self.p2p.orders(int((time.time() - 180 * 86400) * 1000), pages=10))
        self._level = (time.time(), result)
        return result

    def my_ads(self, currency: str) -> list[dict]:
        """Ваши объявления с местом в выдаче: среди всех и среди тех, у кого те же способы оплаты."""
        names = self.payment_names()
        out = []
        for item in self.p2p.my_ads():
            ad = my_ad_view(item, names)
            if ad["status"] == 30:
                continue
            buyers, sellers = self._raw.get(ad["currency"], ([], []))
            pool = sellers if ad["side"] == "sell" else buyers
            if pool:
                ad["rank"] = rank(ad["price"], ad["side"], pool, skip=ad["id"])
                real = rivals(pool, ad["side"], ad["pay_ids"], ad["min_amount"], ad["max_amount"], skip=ad["id"])
                ad["rank_pay"] = rank(ad["price"], ad["side"], real)
                ad["best_rival"] = real[0].price if real else None
                ad["rivals"] = len(real)
                ad["top_price"] = top_price(ad["side"], ad["best_rival"])
            out.append(ad)
        return sorted(out, key=lambda a: (a["currency"] != currency, not a["online"]))

    # --- ваши объявления: по команде из приложения -----------------------------------
    def ad_action(self, ad_id: str, action: str, value: float | None = None) -> str:
        """price — новая цена (не дальше MAX_PRICE_MOVE от лучшего конкурента); quantity — сколько USDT в объявлении;
        offline — снять с публикации; online — вернуть в выдачу. Монеты, ордера и способы оплаты не трогаем."""
        d = self.p2p.ad_detail(ad_id)
        if not d or str(d.get("id")) != str(ad_id):
            raise ValueError("объявление не найдено")
        currency, side = d.get("currencyId", ""), "buy" if str(d.get("side")) == "0" else "sell"
        status = int(_num(d.get("status")))
        if action == "offline":
            self.p2p.remove_ad(ad_id)
            text = "Объявление снято с публикации"
        elif action == "online":
            if status == 10:
                return "Объявление уже в сети"
            self.p2p.update_ad(update_body(d, relist=True))
            text = "Объявление снова в выдаче"
        elif action == "price":
            if value is None or value <= 0:
                raise ValueError("цена: положительное число")
            if int(_num(d.get("priceType"))) != 0:
                raise ValueError("у объявления плавающая цена — меняйте её в Bybit")
            self.market(currency)  # свежий стакан — для проверки цены
            buyers, sellers = self._raw.get(currency, ([], []))
            pays = [str(t.get("paymentType")) for t in d.get("paymentTerms") or []]
            pool = sellers if side == "sell" else buyers
            real = rivals(pool, side, pays, _num(d.get("minAmount")), _num(d.get("maxAmount")), skip=str(ad_id))
            ref = reference([a.price for a in real]) or reference([a.price for a in rivals(pool, side, pays, 0, 0,
                                                                                            skip=str(ad_id))])
            if ref is None:
                raise ValueError("нет данных рынка по вашим банкам — цену меняйте в Bybit")
            if abs(value / ref - 1) * 100 > MAX_PRICE_MOVE:
                raise ValueError(f"цена {n(value)} дальше {n(MAX_PRICE_MOVE, 1)}% от рынка ({n(ref)} — середина пяти лучших "
                                 "конкурентов) — похоже на опечатку; если так и задумано, поменяйте в Bybit")
            self.p2p.update_ad(update_body(d, price=round(value, 2)))
            text = f"Цена объявления: {n(value)} {currency}"
        elif action == "quantity":
            if value is None or value <= 0:
                raise ValueError("количество: положительное число")
            self.p2p.update_ad(update_body(d, quantity=round(value, 4)))
            text = f"В объявлении: {n(value)} {d.get('tokenId', TOKEN)}"
        else:
            raise ValueError("действие: price, quantity, offline или online")
        self._cache.pop(currency, None)
        self.store.log(f"P2P: {text}")
        return text

    def _ad_alerts(self) -> None:
        """Раз в 5 минут: вас обогнали в выдаче (были первым среди своих банков — стали ниже) и объявление
        заканчивается. Каждое — один раз, пока не изменится."""
        ranks: dict = self.store.get("p2p_ad_rank") or {}
        low: list = self.store.get("p2p_ad_low") or []
        for c in {str(i.get("currencyId", "")) for i in self.p2p.my_ads()} & set(self.currencies):
            self.market(c)  # свежий стакан по валютам ваших объявлений — для места в выдаче
        ads = [a for a in self.my_ads(self.currencies[0]) if a["online"]]
        for a in ads:
            r = a.get("rank_pay")
            if r is not None and ranks.get(a["id"]) == 1 and r > 1:
                top = f" Стать первым — {n(a['top_price'])}, кнопкой в приложении." if a.get("top_price") else ""
                self.notify(f"📉 Вас обогнали: объявление на {'продажу' if a['side'] == 'sell' else 'покупку'} по "
                            f"{n(a['price'])} теперь #{r} среди ваших банков, лучший конкурент {n(a['best_rival'])}.{top}")
            if r is not None:
                ranks[a["id"]] = r
            short = a["total"] and (a["left"] / a["total"] < LOW_LEFT or a["left"] * a["price"] < a["min_amount"])
            if short and a["id"] not in low:
                self.notify(f"🪫 Объявление по {n(a['price'])} заканчивается: осталось {n(a['left'])} {a['token']}. "
                            "Пополните количество в приложении или в Bybit.")
                low.append(a["id"])
            elif not short and a["id"] in low:
                low.remove(a["id"])
        self.store.set("p2p_ad_rank", {k: v for k, v in ranks.items() if k in {a["id"] for a in ads}})
        self.store.set("p2p_ad_low", low[-50:])

    # --- экран P2P ---------------------------------------------------------------------
    def view(self, currency: str) -> dict:
        out = {"available": True, "currencies": self.currencies, "currency": currency, "error": ""}
        try:
            acc = self.p2p.account()
            out["account"] = {k: acc.get(k) for k in ("nickName", "recentRate", "recentFinishCount", "totalFinishCount",
                                                      "averageReleaseTime", "averageTransferTime", "recentTradeAmount",
                                                      "goodAppraiseRate", "authStatus", "isOnline")}
            out["market"] = self.market(currency)
            out["my_ads"] = self.my_ads(currency)
            out["pending"] = [order_view(o) for o in self.p2p.pending_orders()]
            out["stats"] = stats(self.p2p.orders(int((time.time() - 30 * 86400) * 1000)))
            out["ledger"] = self.ledger(currency)
            out["level"] = self.level()
            out["notify"] = self.notify_mode
        except Exception as exc:
            log.warning("p2p view: %s", exc)
            out["error"] = explain(exc)
        return out


def explain(exc: Exception) -> str:
    text = str(exc)
    if "item/update" in text or "item/cancel" in text:
        if "permission" in text.lower() or "10005" in text:
            return ("У ключа P2P нет права менять объявления: на Bybit в настройках ключа включите в разделе P2P "
                    f"«Объявления» на изменение (ордера можно оставить только на чтение). Ответ Bybit: {text[:200]}")
    if "403" in text or "permission" in text.lower() or "advertiser" in text.lower():
        return ("Bybit не дал доступ к P2P API. Он открыт только рекламодателям (General Advertiser и выше), "
                f"и у ключа должны быть права P2P. Ответ Bybit: {text[:200]}")
    return text[:300]
