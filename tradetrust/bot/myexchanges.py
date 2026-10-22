"""«Мои биржи»: балансы владельца на Bybit, Binance, OKX и KuCoin и статусы ввода/вывода монет — только чтение.

Ключи — только в .env на сервере. Ключ Binance/OKX/KuCoin с правом торговли или вывода бот не принимает:
этот раздел ничего не покупает, не продаёт и не переводит. Bybit — ключ реального счёта, уже подключённый.
Данные обновляются в фоне (балансы — раз в 5 минут, статусы ввода/вывода — раз в 30), приложение берёт готовое.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import threading
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests

log = logging.getLogger(__name__)

STABLES = {"USDT", "USDC", "FDUSD", "DAI", "TUSD", "USDE", "BUSD", "PYUSD"}
DUST_USD = 1.0
BALANCE_EVERY, STATUS_EVERY = 300, 1800


class KeyRejected(RuntimeError):
    """Ключ не подходит для раздела (например, с правом вывода) — счёт не подключаем."""


def _f(x) -> float:
    try:
        return float(x)
    except (TypeError, ValueError):
        return 0.0


class Exchange:
    """Общее для бирж: имя, HTTP, сведение балансов из нескольких кошельков, цены в USD."""

    name = ""

    def __init__(self, session: requests.Session | None = None):
        self.http = session or requests.Session()
        self.notes: list[str] = []  # что не удалось показать при последнем обновлении (не мешает остальному)

    def check(self) -> list[str]:  # → предупреждения; KeyRejected — ключ не принят
        raise NotImplementedError

    def balances(self) -> dict[str, float]:
        raise NotImplementedError

    def prices(self) -> dict[str, float]:
        raise NotImplementedError

    def transfer_status(self) -> dict[str, dict]:  # монета → {"deposit": bool, "withdraw": bool}
        raise NotImplementedError

    def _json(self, resp) -> dict | list:
        try:
            data = resp.json()
        except ValueError:
            resp.raise_for_status()
            raise
        if resp.status_code >= 400:
            raise RuntimeError(f"{self.name}: HTTP {resp.status_code} {str(data)[:200]}")
        return data


def _add(out: dict[str, float], coin: str, qty: float) -> None:
    if qty:
        out[coin.upper()] = out.get(coin.upper(), 0.0) + qty


# --- Binance ------------------------------------------------------------------------------
class Binance(Exchange):
    name = "Binance"
    BASE = "https://api.binance.com"

    def __init__(self, key: str, secret: str, **kw):
        super().__init__(**kw)
        self.key, self.secret = key, secret

    @staticmethod
    def sign(secret: str, query: str) -> str:
        return hmac.new(secret.encode(), query.encode(), hashlib.sha256).hexdigest()

    def _signed(self, method: str, path: str, params: dict | None = None):
        query = urlencode({**(params or {}), "recvWindow": 10000, "timestamp": int(time.time() * 1000)})
        url = f"{self.BASE}{path}?{query}&signature={self.sign(self.secret, query)}"
        data = self._json(self.http.request(method, url, headers={"X-MBX-APIKEY": self.key}, timeout=20))
        if isinstance(data, dict) and "code" in data and data.get("code", 0) < 0:
            raise RuntimeError(f"Binance: {data.get('code')} {data.get('msg')}")
        return data

    def check(self) -> list[str]:
        r = self._signed("GET", "/sapi/v1/account/apiRestrictions")
        if r.get("enableWithdrawals"):
            raise KeyRejected("у ключа Binance включён вывод средств — создайте ключ только для чтения")
        trading = [k for k in ("enableSpotAndMarginTrading", "enableFutures", "enableMargin", "enableVanillaOptions",
                               "enableInternalTransfer", "permitsUniversalTransfer") if r.get(k)]
        if trading:
            raise KeyRejected(f"у ключа Binance включены торговля или переводы ({', '.join(trading)}) — "
                              "для этого раздела нужен ключ только для чтения")
        return [] if r.get("ipRestrict") else ["ключ Binance не привязан к IP сервера"]

    def balances(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for b in self._signed("GET", "/api/v3/account", {"omitZeroBalances": "true"}).get("balances", []):
            _add(out, b["asset"], _f(b.get("free")) + _f(b.get("locked")))
        for b in self._signed("POST", "/sapi/v1/asset/get-funding-asset") or []:
            _add(out, b["asset"], _f(b.get("free")) + _f(b.get("locked")) + _f(b.get("freeze")))
        return out

    def prices(self) -> dict[str, float]:
        rows = self._json(self.http.get(f"{self.BASE}/api/v3/ticker/price", timeout=20))
        return {r["symbol"][:-4]: _f(r["price"]) for r in rows if r["symbol"].endswith("USDT")}

    def transfer_status(self) -> dict[str, dict]:
        out = {}
        for c in self._signed("GET", "/sapi/v1/capital/config/getall") or []:
            nets = c.get("networkList") or []
            out[c["coin"].upper()] = {"deposit": any(n.get("depositEnable") for n in nets) and c.get("depositAllEnable", True),
                                      "withdraw": any(n.get("withdrawEnable") for n in nets) and c.get("withdrawAllEnable", True)}
        return out


# --- OKX ------------------------------------------------------------------------------------
class OKX(Exchange):
    name = "OKX"
    BASE = "https://www.okx.com"

    def __init__(self, key: str, secret: str, passphrase: str, **kw):
        super().__init__(**kw)
        self.key, self.secret, self.passphrase = key, secret, passphrase

    @staticmethod
    def sign(secret: str, ts: str, method: str, path: str, body: str = "") -> str:
        return base64.b64encode(hmac.new(secret.encode(), f"{ts}{method}{path}{body}".encode(), hashlib.sha256).digest()).decode()

    def _signed(self, path: str):
        ts = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        headers = {"OK-ACCESS-KEY": self.key, "OK-ACCESS-SIGN": self.sign(self.secret, ts, "GET", path),
                   "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": self.passphrase, "Content-Type": "application/json"}
        data = self._json(self.http.get(self.BASE + path, headers=headers, timeout=20))
        if str(data.get("code")) != "0":
            raise RuntimeError(f"OKX: {data.get('code')} {data.get('msg')}")
        return data.get("data") or []

    def check(self) -> list[str]:
        cfg = (self._signed("/api/v5/account/config") or [{}])[0]
        perm = {p.strip() for p in str(cfg.get("perm", "")).split(",") if p.strip()}
        if "withdraw" in perm:
            raise KeyRejected("у ключа OKX есть право вывода (withdraw) — создайте ключ только для чтения")
        if "trade" in perm:
            raise KeyRejected("у ключа OKX есть право торговли (trade) — для этого раздела нужен ключ только для чтения")
        return [] if cfg.get("ip") else ["ключ OKX не привязан к IP сервера"]

    def balances(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for acc in self._signed("/api/v5/account/balance"):
            for d in acc.get("details") or acc.get("balData") or []:
                _add(out, d["ccy"], _f(d.get("eq") or d.get("cashBal")))
        for b in self._signed("/api/v5/asset/balances"):
            _add(out, b["ccy"], _f(b.get("bal")))
        return out

    def prices(self) -> dict[str, float]:
        rows = self._json(self.http.get(f"{self.BASE}/api/v5/market/tickers?instType=SPOT", timeout=20)).get("data") or []
        return {r["instId"][:-5]: _f(r["last"]) for r in rows if r["instId"].endswith("-USDT")}

    def transfer_status(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for c in self._signed("/api/v5/asset/currencies"):
            s = out.setdefault(c["ccy"].upper(), {"deposit": False, "withdraw": False})
            s["deposit"] |= bool(c.get("canDep"))
            s["withdraw"] |= bool(c.get("canWd"))
        return out


# --- KuCoin ---------------------------------------------------------------------------------
class KuCoin(Exchange):
    name = "KuCoin"
    BASE = "https://api.kucoin.com"
    WITHDRAW = {"Withdrawal", "Withdraw", "Transfer"}
    TRADE = {"Spot", "Margin", "Futures", "LeverageToken"}

    def __init__(self, key: str, secret: str, passphrase: str, version: str = "3", **kw):
        super().__init__(**kw)
        self.key, self.secret, self.passphrase, self.version = key, secret, passphrase, version

    @staticmethod
    def sign(secret: str, text: str) -> str:
        return base64.b64encode(hmac.new(secret.encode(), text.encode(), hashlib.sha256).digest()).decode()

    def _signed(self, path: str):
        ts = str(int(time.time() * 1000))
        headers = {"KC-API-KEY": self.key, "KC-API-SIGN": self.sign(self.secret, f"{ts}GET{path}"),
                   "KC-API-TIMESTAMP": ts, "KC-API-PASSPHRASE": self.sign(self.secret, self.passphrase),
                   "KC-API-KEY-VERSION": self.version, "Content-Type": "application/json"}
        data = self._json(self.http.get(self.BASE + path, headers=headers, timeout=20))
        if str(data.get("code")) != "200000":
            raise RuntimeError(f"KuCoin: {data.get('code')} {data.get('msg')}")
        return data.get("data")

    def check(self) -> list[str]:
        info = self._signed("/api/v1/user/api-key") or {}
        perm = {p.strip() for p in str(info.get("permission", "")).split(",") if p.strip()}
        if perm & self.WITHDRAW:
            raise KeyRejected("у ключа KuCoin есть право вывода или переводов — создайте ключ только для чтения (General)")
        if perm & self.TRADE:
            raise KeyRejected(f"у ключа KuCoin есть право торговли ({', '.join(sorted(perm & self.TRADE))}) — "
                              "для этого раздела нужен ключ только с правом General")
        return []

    def balances(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for a in self._signed("/api/v1/accounts") or []:
            _add(out, a["currency"], _f(a.get("balance")))
        return out

    def prices(self) -> dict[str, float]:
        rows = (self._json(self.http.get(f"{self.BASE}/api/v1/market/allTickers", timeout=20)).get("data") or {}).get("ticker") or []
        return {r["symbol"][:-5]: _f(r.get("last")) for r in rows if r["symbol"].endswith("-USDT")}

    def transfer_status(self) -> dict[str, dict]:
        out = {}
        for c in self._json(self.http.get(f"{self.BASE}/api/v3/currencies", timeout=20)).get("data") or []:
            chains = c.get("chains") or []
            out[c["currency"].upper()] = {"deposit": any(ch.get("isDepositEnabled") for ch in chains),
                                          "withdraw": any(ch.get("isWithdrawEnabled") for ch in chains)}
        return out


# --- Bybit (ключ реального счёта) ----------------------------------------------------------------
class Bybit(Exchange):
    name = "Bybit"

    def __init__(self, client, **kw):
        super().__init__(**kw)
        self.c = client  # BybitClient реального счёта

    def check(self) -> list[str]:
        return []  # ключ уже проверен при подключении реального счёта

    def balances(self) -> dict[str, float]:
        out: dict[str, float] = {}
        for coin, b in self.c.wallet().items():
            _add(out, coin, b["wallet"])
        self.notes = []
        try:  # кошелёк Funding Bybit отдаёт только ключу с правом «Переводы»; без него — только Единый торговый
            fund = self.c._request("GET", "/v5/asset/transfer/query-account-coins-balance", {"accountType": "FUND"},
                                   auth=True)
            for b in fund.get("balance") or []:
                _add(out, b["coin"], _f(b.get("walletBalance")))
        except Exception as exc:
            log.info("bybit funding: %s", exc)
            self.notes.append("показан только Единый торговый счёт: Funding-кошелёк Bybit отдаёт ключу с правом "
                              "«Переводы»")
        return out

    def prices(self) -> dict[str, float]:
        rows = self.c._request("GET", "/v5/market/tickers", {"category": "spot"}).get("list") or []
        return {r["symbol"][:-4]: _f(r["lastPrice"]) for r in rows if r["symbol"].endswith("USDT")}

    def transfer_status(self) -> dict[str, dict]:
        out = {}
        for c in self.c._request("GET", "/v5/asset/coin/query-info", {}, auth=True).get("rows") or []:
            chains = c.get("chains") or []
            out[c["coin"].upper()] = {"deposit": any(str(ch.get("chainDeposit")) == "1" for ch in chains),
                                      "withdraw": any(str(ch.get("chainWithdraw")) == "1" for ch in chains)}
        return out


# --- всё вместе ---------------------------------------------------------------------------------
class MyExchanges:
    """Подключение, фоновое обновление и сводка по всем биржам владельца."""

    def __init__(self, exchanges: list[Exchange]):
        self.exchanges = exchanges
        self.state: dict[str, dict] = {e.name: {"name": e.name, "connected": False, "error": "", "warnings": []}
                                       for e in exchanges}
        self.status: dict[str, dict[str, dict]] = {}  # биржа → монета → ввод/вывод
        self._checked: set[str] = set()
        self._balances_at = self._status_at = 0.0
        self.lock = threading.Lock()

    def connect(self) -> list[str]:
        """Проверка ключей: что подключено, что нет и почему — для сообщения при запуске."""
        lines = []
        for e in self.exchanges:
            s = self.state[e.name]
            try:
                s["key_warnings"] = s["warnings"] = e.check()
                s["connected"], s["error"] = True, ""
                self._checked.add(e.name)
                lines.append(f"✅ {e.name}" + (f" ({'; '.join(s['warnings'])})" if s["warnings"] else ""))
            except KeyRejected as exc:
                s["connected"], s["error"] = False, str(exc)
                lines.append(f"⛔ {e.name}: {exc}")
            except Exception as exc:
                s["connected"], s["error"] = False, f"не удалось проверить ключ: {str(exc)[:200]}"
                lines.append(f"❗ {e.name}: {s['error']}")
        return lines

    def refresh(self, force: bool = False) -> None:
        """Раз в минуту из главного цикла; сами запросы — по своим интервалам."""
        now = time.time()
        with self.lock:
            if force or now - self._balances_at >= BALANCE_EVERY:
                self._balances_at = now
                for e in self.exchanges:
                    if e.name in self._checked:
                        self._refresh_balances(e)
            if force or now - self._status_at >= STATUS_EVERY:
                self._status_at = now
                for e in self.exchanges:
                    try:
                        self.status[e.name] = e.transfer_status()
                    except Exception as exc:
                        log.warning("transfer status %s: %s", e.name, exc)

    def _refresh_balances(self, e: Exchange) -> None:
        s = self.state[e.name]
        try:
            qty, prices = e.balances(), e.prices()
            assets = []
            for coin, q in qty.items():
                price = 1.0 if coin in STABLES else prices.get(coin)
                value = q * price if price else None
                if value is not None and value < DUST_USD:
                    continue
                assets.append({"coin": coin, "qty": q, "price": price, "value": value})
            assets.sort(key=lambda a: -(a["value"] or 0))
            s.update(assets=assets, total=sum(a["value"] or 0 for a in assets), updated_at=int(time.time()), error="",
                     warnings=s.get("key_warnings", []) + e.notes)
        except Exception as exc:
            log.warning("balances %s: %s", e.name, exc)
            s["error"] = f"не удалось обновить: {str(exc)[:200]}"

    def view(self) -> dict:
        exchanges = [dict(s) for s in self.state.values()]
        coins: dict[str, dict] = {}
        for s in exchanges:
            for a in s.get("assets") or []:
                c = coins.setdefault(a["coin"], {"coin": a["coin"], "qty": 0.0, "value": 0.0, "where": {}})
                c["qty"] += a["qty"]
                c["value"] += a["value"] or 0
                c["where"][s["name"]] = a["qty"]
        for c in coins.values():  # закрытый ввод/вывод там, где монета лежит
            c["closed"] = {ex: st for ex in c["where"] if (st := self.status.get(ex, {}).get(c["coin"]))
                           and not (st["deposit"] and st["withdraw"])}
        return {"exchanges": exchanges, "total": sum(s.get("total") or 0 for s in exchanges),
                "coins": sorted(coins.values(), key=lambda c: -c["value"])}

    def coin_status(self, coin: str) -> dict[str, dict]:
        """Биржа → ввод/вывод по монете — для вкладки «Биржи» в карточке монеты."""
        return {ex: st[coin] for ex, st in self.status.items() if coin in st}


def from_config(cfg, bybit_client=None, session=None) -> MyExchanges | None:
    kw = {"session": session} if session else {}
    exchanges: list[Exchange] = []
    if bybit_client is not None:
        exchanges.append(Bybit(bybit_client, **kw))
    if cfg.binance_api_key:
        exchanges.append(Binance(cfg.binance_api_key, cfg.binance_api_secret, **kw))
    if cfg.okx_api_key:
        exchanges.append(OKX(cfg.okx_api_key, cfg.okx_api_secret, cfg.okx_passphrase, **kw))
    if cfg.kucoin_api_key:
        exchanges.append(KuCoin(cfg.kucoin_api_key, cfg.kucoin_api_secret, cfg.kucoin_passphrase,
                                cfg.kucoin_key_version, **kw))
    return MyExchanges(exchanges) if exchanges else None

