"""Настройки бота из переменных окружения (файл .env на сервере)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from ..research import COINS

ENVS = ("paper", "demo", "testnet", "mainnet")
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
    mode: str = "confirm"              # signals — только сигналы, confirm — сделка после подтверждения, auto — сам
    coins: list[str] = field(default_factory=lambda: list(COINS))
    risk_pct: float = 1.0
    atr_mult: float = 2.0
    ema_fast: int = 20
    ema_slow: int = 50
    btc_filter: bool = False
    capital_usdt: float = 0.0          # сколько USDT отдано боту; 0 — весь свободный USDT
    max_positions: int = 5
    max_position_pct: float = 25.0     # не больше этой доли капитала в одной монете
    max_total_risk_pct: float = 5.0    # суммарный риск по всем открытым позициям
    daily_loss_limit_pct: float = 3.0  # дневной убыток, после которого бот встаёт на паузу
    proposal_ttl_min: int = 60
    telegram_token: str = ""
    telegram_chat_id: str = ""
    api_token: str = ""
    api_port: int = 8080
    db_path: str = "bot.db"
    paper_start_usdt: float = 1000.0

    @classmethod
    def from_env(cls) -> "Config":
        cfg = cls(
            env=_env("BYBIT_ENV", "paper").lower(),
            api_key=_env("BYBIT_API_KEY"),
            api_secret=_env("BYBIT_API_SECRET"),
            base_url=_env("BYBIT_BASE_URL"),
            mode=_env("MODE", "confirm").lower(),
            coins=[c.strip().upper() for c in _env("COINS", ",".join(COINS)).split(",") if c.strip()],
            risk_pct=_float("RISK_PCT", 1.0),
            atr_mult=_float("ATR_MULT", 2.0),
            ema_fast=int(_float("EMA_FAST", 20)),
            ema_slow=int(_float("EMA_SLOW", 50)),
            btc_filter=_env("BTC_FILTER", "0").lower() in ("1", "true", "yes", "да"),
            capital_usdt=_float("BOT_CAPITAL_USDT", 0.0),
            max_positions=int(_float("MAX_POSITIONS", 5)),
            max_position_pct=_float("MAX_POSITION_PCT", 25.0),
            max_total_risk_pct=_float("MAX_TOTAL_RISK_PCT", 5.0),
            daily_loss_limit_pct=_float("DAILY_LOSS_LIMIT_PCT", 3.0),
            proposal_ttl_min=int(_float("PROPOSAL_TTL_MIN", 60)),
            telegram_token=_env("TELEGRAM_TOKEN"),
            telegram_chat_id=_env("TELEGRAM_CHAT_ID"),
            api_token=_env("API_TOKEN"),
            api_port=int(_float("API_PORT", 8080)),
            db_path=_env("DB_PATH", "bot.db"),
            paper_start_usdt=_float("PAPER_START_USDT", 1000.0),
        )
        cfg.validate()
        return cfg

    def validate(self) -> None:
        if self.env not in ENVS:
            raise ValueError(f"BYBIT_ENV должен быть одним из {ENVS}")
        if self.mode not in MODES:
            raise ValueError(f"MODE должен быть одним из {MODES}")
        if self.env != "paper" and not (self.api_key and self.api_secret):
            raise ValueError("Для торговли на Bybit нужны BYBIT_API_KEY и BYBIT_API_SECRET")
        if not 0 < self.risk_pct <= 5:
            raise ValueError("RISK_PCT должен быть в диапазоне (0, 5]")
        if not 2 <= self.ema_fast < self.ema_slow:
            raise ValueError("EMA_FAST должна быть меньше EMA_SLOW")
        if self.telegram_token and not self.telegram_chat_id:
            raise ValueError("Задан TELEGRAM_TOKEN, но не задан TELEGRAM_CHAT_ID")
