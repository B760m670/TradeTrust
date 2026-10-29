"""Счета владельца: основной (BYBIT_ENV — обычно демо-счёт Bybit) и реальный, если в .env есть его ключ.
У основного может быть раздел «Фьючерсы» (BYBIT_FUTURES=1) — тот же счёт Bybit и тот же кошелёк, но свой бот:
лонг 1x на фьючерсах USDT для копитрейдинга, со своим капиталом, позициями и историей.

У каждого счёта свой бот, своя база и свои настройки. Какой из них открыт в приложении и в командах
Telegram — выбирает владелец («активный счёт», хранится в базе основного). Уведомления реального счёта
приходят с пометкой, чтобы их нельзя было спутать с демо.
"""
from __future__ import annotations

from .engine import Bot

LABELS = {"paper": "Бумажный счёт", "demo": "Демо-счёт Bybit", "testnet": "Тестовая сеть Bybit",
          "mainnet": "Реальный счёт Bybit"}
REAL_TAG = "💰 Реальный счёт\n"
FUTURES_TAG = "📈 Фьючерсы\n"


def check_key(info: dict, market: str = "spot") -> tuple[str, str]:
    """Проверка ключа реального счёта: (ошибка, предупреждение). С ошибкой счёт не подключается."""
    perms = info.get("permissions") or {}
    if any("Withdraw" in (v or []) for v in perms.values()):
        return "у ключа есть право на вывод средств — создайте ключ без вывода", ""
    read_only = info.get("readOnly") == 1
    if read_only and market == "linear":
        return "ключ только для чтения — для копитрейдинга нужен ключ с торговлей", ""
    if not read_only and market == "spot" and "SpotTrade" not in (perms.get("Spot") or []):
        return "у ключа нет права «Спот — торговля»", ""
    if market == "linear" and not {"Order", "Position"} <= set(perms.get("ContractTrade") or []):
        return "у ключа нет права «Контракты — ордера и позиции» (нужно для копитрейдинга)", ""
    ips = [ip for ip in info.get("ips") or [] if ip and ip != "*"]
    warn = "" if ips else "ключ не привязан к IP сервера — привяжите его в настройках ключа на Bybit"
    if read_only:
        warn = "; ".join(w for w in ("ключ только для чтения: счёт виден, торговля и бот на нём недоступны", warn) if w)
    return "", warn


class TaggedNotifier:
    """Уведомления с пометкой счёта в начале."""

    def __init__(self, notifier, tag: str):
        self.notifier, self.tag = notifier, tag

    def send(self, text: str, buttons=None) -> int | None:
        return self.notifier.send(self.tag + text, buttons)

    def edit(self, message_id: int, text: str) -> None:
        self.notifier.edit(message_id, self.tag + text)


class Accounts:
    def __init__(self, main: Bot, real: Bot | None = None, real_error: str = "", futures: Bot | None = None,
                 show_demo: bool = True):
        """real_error — почему реальный счёт задан в .env, но не подключился (ключ не прошёл проверку);
        futures — раздел «Фьючерсы» основного счёта; show_demo=False — когда подключён реальный счёт, демо
        и фьючерсы (тоже демо) скрыты: не видны в приложении и в Telegram, бот на них не торгует."""
        self.main, self.real, self.real_error, self.futures = main, real, real_error, futures
        self.show_demo = show_demo or real is None
        self.p2p = None  # P2P владельца (P2PDesk), если включён — к счетам не относится
        self.exchanges = None  # «Мои биржи» (MyExchanges): балансы на всех биржах владельца, только чтение

    def bots(self) -> dict[str, Bot]:
        if not self.show_demo:
            return {"real": self.real}
        return {"main": self.main, **({"futures": self.futures} if self.futures is not None else {}),
                **({"real": self.real} if self.real is not None else {})}

    def all(self) -> list[Bot]:
        return list(self.bots().values())

    @property
    def active_id(self) -> str:
        name = self.main.store.get("active_account", "main")
        return name if name in self.bots() else next(iter(self.bots()))

    def active(self) -> Bot:
        return self.bots()[self.active_id]

    def switch(self, name: str) -> str:
        if name not in self.bots():
            raise ValueError({"real": "реальный счёт не подключён",
                              "futures": "раздел «Фьючерсы» не включён (BYBIT_FUTURES=1 в .env)"}.get(name, f"нет счёта {name}"))
        self.main.store.set("active_account", name)
        return f"Счёт: {self.label(name)}"

    def label(self, name: str) -> str:
        cfg = self.bots()[name].cfg
        return LABELS.get(cfg.env, name) + (" · фьючерсы" if cfg.market == "linear" else "")

    def by_proposal(self, pid: str) -> Bot | None:
        """Чьё предложение — по нему кнопка «Купить» в Telegram находит нужный счёт."""
        return next((b for b in self.all() if b.store.proposal(pid) is not None), None)

    def info(self) -> dict:
        return {
            "active": self.active_id,
            "list": [{"id": k, "label": self.label(k), "env": b.cfg.env, "real": b.cfg.env == "mainnet",
                      "market": b.cfg.market}
                     for k, b in self.bots().items()],
            "real_configured": self.real is not None or bool(self.real_error),
            "real_error": self.real_error,
            "demo_hidden": not self.show_demo,
        }
