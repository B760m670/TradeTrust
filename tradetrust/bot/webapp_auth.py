"""Проверка initData Telegram Mini App.

https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
hash   = hex(HMAC_SHA256(key=secret, msg=data_check_string)),
где data_check_string — все поля, кроме hash, в виде key=value, по алфавиту, через \\n.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

MAX_AGE_SECONDS = 24 * 3600


def data_check_string(fields: dict[str, str]) -> str:
    return "\n".join(f"{k}={v}" for k, v in sorted(fields.items()) if k != "hash")


def sign(fields: dict[str, str], bot_token: str) -> str:
    secret = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
    return hmac.new(secret, data_check_string(fields).encode(), hashlib.sha256).hexdigest()


def validate(init_data: str, bot_token: str, owner_id: str, max_age: int = MAX_AGE_SECONDS) -> dict | None:
    """Пользователь Telegram, если подпись верна, данные свежие и это владелец бота; иначе None."""
    if not init_data or not bot_token:
        return None
    try:
        fields = dict(parse_qsl(init_data, keep_blank_values=True, strict_parsing=True))
    except ValueError:
        return None
    got = fields.get("hash", "")
    if not hmac.compare_digest(got, sign(fields, bot_token)):
        return None
    if time.time() - int(fields.get("auth_date", "0")) > max_age:
        return None
    user = json.loads(fields.get("user", "{}"))
    if str(user.get("id")) != str(owner_id):
        return None
    return user
