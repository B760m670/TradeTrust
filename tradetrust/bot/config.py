"""Настройки бота из переменных окружения (файл .env на сервере)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from ..research import COINS

ENVS = ("paper", "demo", "testnet", "mainnet")
MARKETS = ("spot", "linear")  # спот или бессрочные фьючерсы USDT (раздел для копитрейдинга Bybit)
MODES = ("signals", "confirm", "auto")


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _float(name: str, default: float) -> float:
    return float(_env(name, str(default)) or default)


@dataclass
class Config:
    env: str = "paper"                 # paper — без биржи, demo/testnet — ненастоящие деньги, mainnet — реальные
    api_key: str = ""
    api_secret: str = ""
    base_url: str = ""                 # свой адрес API (например, региональный), иначе по env
    real_api_key: str = ""             # второй счёт владельца — реальный Bybit (mainnet), переключается в приложении
    real_api_secret: str = ""
    real_base_url: str = ""
    p2p: bool = False                  # P2P Bybit владельца: стакан, спред, ордера, уведомления — только чтение
    p2p_api_key: str = ""              # отдельный ключ с правами P2P; иначе ключ реального счёта
    p2p_api_secret: str = ""
    p2p_currencies: list[str] = field(default_factory=lambda: ["RUB", "USD"])
    binance_api_key: str = ""          # «Мои биржи»: ключи только для чтения (с правом торговли/вывода не принимаются)
    binance_api_secret: str = ""
    okx_api_key: str = ""
    okx_api_secret: str = ""
    okx_passphrase: str = ""
    kucoin_api_key: str = ""
    kucoin_api_secret: str = ""
    kucoin_passphrase: str = ""
    kucoin_key_version: str = "3"
    coingecko_api_key: str = ""        # бесплатный demo-ключ CoinGecko — выше лимиты для «Цены на биржах»
    futures: bool = False              # раздел «Фьючерсы» на том же счёте Bybit: лонг 1x, для копитрейдинга
    market: str = "spot"               # рынок этого бота: spot или linear (у раздела фьючерсов), из .env не задаётся
    mode: str = "confirm"              # signals — только сигналы, confirm — сделка после подтверждения, auto — сам
    coins: list[str] = field(default_factory=lambda: list(COINS))
    # ошибки в настройках необязательных разделов (P2P, «Мои биржи»): раздел выключается, бот запускается
    problems: list[str] = field(default_factory=list)
    risk_pct: float = 0.3              # маленький риск на все монеты — см. scripts/portfolio_study.py
    atr_mult: float = 2.0
    ema_fast: int = 20
    ema_slow: int = 50
    btc_filter: bool = True            # не входить, когда BTC ниже средней за btc_days — scripts/context_study.py
    btc_days: int = 50
    capital_usdt: float = 0.0          # сколько USDT отдано боту; 0 — весь свободный USDT
    max_positions: int = 25
    max_position_pct: float = 25.0     # не больше этой доли капитала в одной монете
    max_total_risk_pct: float = 10.0   # суммарный риск по всем открытым позициям
    trend_filter: bool = True          # входить только в монеты, выросшие за trend_days дней
    trend_days: int = 120
    daily_loss_limit_pct: float = 3.0  # дневной убыток, после которого бот встаёт на паузу
    proposal_ttl_min: int = 60
    daily_report: bool = True          # сводка в Telegram раз в сутки
    report_hour_utc: int = 7           # в какой час (UTC) её присылать
    telegram_token: str = ""
    telegram_chat_id: str = ""
    api_token: str = ""
    api_port: int = 8080
    domain: str = ""                   # адрес сервера для мини-приложения: https://<domain>
    db_path: str = "bot.db"
    paper_start_usdt: float = 1000.0
    public_demo: bool = True           # любой пользователь Telegram получает свой демо-счёт (бумажный, 1000 USDT)
    max_users: int = 100               # сколько демо-счетов максимум (память сервера)
    account: str = "owner"             # owner — основной счёт владельца; real — его реальный счёт; demo — пользователя
    bot_enabled: bool = True           # бот торгует на этом счёте; на реальном по умолчанию выключен
    read_only: bool = False            # ключ только для чтения: счёт виден, торговли и бота нет

    @property
    def has_real(self) -> bool:
        """Есть второй, реальный счёт (если основной и так mainnet — переключать не на что)."""
        return bool(self.real_api_key and self.real_api_secret) and self.env != "mainnet"

    @property
    def webapp_url(self) -> str:
        return f"https://{self.domain}" if self.domain else ""

    @classmethod
    def from_env(cls) -> "Config":
        cfg = cls(
            env=_env("BYBIT_ENV", "paper").lower(),
            api_key=_env("BYBIT_API_KEY"),
            api_secret=_env("BYBIT_API_SECRET"),
            base_url=_env("BYBIT_BASE_URL"),
            real_api_key=_env("BYBIT_REAL_API_KEY"),
            real_api_secret=_env("BYBIT_REAL_API_SECRET"),
            real_base_url=_env("BYBIT_REAL_BASE_URL"),
            futures=_env("BYBIT_FUTURES", "0").lower() in ("1", "true", "yes", "да"),
            coingecko_api_key=_env("COINGECKO_API_KEY"),
            binance_api_key=_env("BINANCE_API_KEY"), binance_api_secret=_env("BINANCE_API_SECRET"),
            okx_api_key=_env("OKX_API_KEY"), okx_api_secret=_env("OKX_API_SECRET"), okx_passphrase=_env("OKX_PASSPHRASE"),
            kucoin_api_key=_env("KUCOIN_API_KEY"), kucoin_api_secret=_env("KUCOIN_API_SECRET"),
            kucoin_passphrase=_env("KUCOIN_PASSPHRASE"), kucoin_key_version=_env("KUCOIN_API_KEY_VERSION", "3"),
            p2p=_env("BYBIT_P2P", "0").lower() in ("1", "true", "yes", "да"),
            p2p_api_key=_env("BYBIT_P2P_API_KEY"),
            p2p_api_secret=_env("BYBIT_P2P_API_SECRET"),
            p2p_currencies=[c.strip().upper() for c in _env("P2P_CURRENCIES", "RUB,USD").split(",") if c.strip()],
            mode=_env("MODE", "confirm").lower(),
            coins=[c.strip().upper() for c in _env("COINS", ",".join(COINS)).split(",") if c.strip()],
            risk_pct=_float("RISK_PCT", 0.3),
            atr_mult=_float("ATR_MULT", 2.0),
            ema_fast=int(_float("EMA_FAST", 20)),
            ema_slow=int(_float("EMA_SLOW", 50)),
            btc_filter=_env("BTC_FILTER", "1").lower() in ("1", "true", "yes", "да"),
            btc_days=int(_float("BTC_DAYS", 50)),
            capital_usdt=_float("BOT_CAPITAL_USDT", 0.0),
            max_positions=int(_float("MAX_POSITIONS", 25)),
            max_position_pct=_float("MAX_POSITION_PCT", 25.0),
            max_total_risk_pct=_float("MAX_TOTAL_RISK_PCT", 10.0),
            trend_filter=_env("TREND_FILTER", "1").lower() in ("1", "true", "yes", "да"),
            trend_days=int(_float("TREND_DAYS", 120)),
            daily_loss_limit_pct=_float("DAILY_LOSS_LIMIT_PCT", 3.0),
            proposal_ttl_min=int(_float("PROPOSAL_TTL_MIN", 60)),
            daily_report=_env("DAILY_REPORT", "1").lower() in ("1", "true", "yes", "да"),
            report_hour_utc=int(_float("REPORT_HOUR_UTC", 7)) % 24,
            telegram_token=_env("TELEGRAM_TOKEN"),
            telegram_chat_id=_env("TELEGRAM_CHAT_ID"),
            api_token=_env("API_TOKEN"),
            api_port=int(_float("API_PORT", 8080)),
            domain=_env("DOMAIN").removeprefix("https://").strip("/"),
            db_path=_env("DB_PATH", "bot.db"),
            paper_start_usdt=_float("PAPER_START_USDT", 1000.0),
            public_demo=_env("PUBLIC_DEMO", "0").lower() in ("1", "true", "yes", "да"),
            max_users=int(_float("MAX_USERS", 100)),
        )
        if cfg.env in ("demo", "testnet") and cfg.real_api_key:
            # есть реальный счёт — демо не нужно: основной счёт без ключей, только для общих публичных данных и настроек
            cfg.env, cfg.futures, cfg.api_key, cfg.api_secret = "paper", False, "", ""
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.env not in ENVS:
            raise ValueError(f"BYBIT_ENV должен быть одним из {ENVS}")
        if self.market not in MARKETS:
            raise ValueError(f"рынок: {' или '.join(MARKETS)}")
        if self.env == "paper" and (self.futures or self.market != "spot"):
            raise ValueError("Бумажный счёт торгует только спот — для фьючерсов нужен счёт Bybit (BYBIT_ENV=demo)")
        # необязательные разделы: ошибка в их ключах не должна останавливать бота — раздел выключаем и сообщаем
        if bool(self.p2p_api_key) != bool(self.p2p_api_secret):
            self.problems.append("Для P2P нужны оба: BYBIT_P2P_API_KEY и BYBIT_P2P_API_SECRET")
            self.p2p_api_key = self.p2p_api_secret = ""
        if self.p2p and not (self.p2p_api_key or self.real_api_key or self.env == "mainnet"):
            self.problems.append("Для P2P нужен ключ реального счёта (BYBIT_REAL_API_KEY) или BYBIT_P2P_API_KEY")
            self.p2p = False
        for name, attrs in (("BINANCE", ("binance_api_key", "binance_api_secret")),
                            ("OKX", ("okx_api_key", "okx_api_secret", "okx_passphrase")),
                            ("KUCOIN", ("kucoin_api_key", "kucoin_api_secret", "kucoin_passphrase"))):
            parts = [getattr(self, a) for a in attrs]
            if any(parts) and not all(parts):
                need = "ключ, секрет и пароль ключа (PASSPHRASE)" if len(parts) == 3 else "ключ и секрет"
                self.problems.append(f"Для {name} нужны {need} — биржа не подключена")
                for a in attrs:
                    setattr(self, a, "")
        if self.mode not in MODES:
            raise ValueError(f"MODE должен быть одним из {MODES}")
        if self.env != "paper" and not (self.api_key and self.api_secret):
            raise ValueError("Для торговли на Bybit нужны BYBIT_API_KEY и BYBIT_API_SECRET")
        if bool(self.real_api_key) != bool(self.real_api_secret):
            raise ValueError("Для реального счёта нужны оба: BYBIT_REAL_API_KEY и BYBIT_REAL_API_SECRET")
        if not 0 < self.risk_pct <= 5:
            raise ValueError("RISK_PCT должен быть в диапазоне (0, 5]")
        if not 2 <= self.ema_fast < self.ema_slow:
            raise ValueError("EMA_FAST должна быть меньше EMA_SLOW")
        if self.telegram_token and not self.telegram_chat_id:
            raise ValueError("Задан TELEGRAM_TOKEN, но не задан TELEGRAM_CHAT_ID")
