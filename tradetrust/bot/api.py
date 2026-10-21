"""HTTP: мини-приложение Telegram (сборка miniapp/ в web/) и JSON API.

Доступ к /api/* — одним из двух способов:
  * Authorization: tma <initData>   — мини-приложение, подпись Telegram: владелец видит свой счёт,
    остальные (если включены демо-счета) — свой демо-счёт, который открывается при первом входе;
  * Authorization: Bearer <API_TOKEN> — Android-приложение владельца.
Снаружи всё закрыто HTTPS — в docker-compose это делает Caddy.
"""
from __future__ import annotations

import hmac
import json
import logging
import mimetypes
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from . import admin, webapp_auth
from .config import MODES
from .engine import CHART_INTERVALS, Bot

mimetypes.add_type("font/woff2", ".woff2")  # шрифты мини-приложения; в старых Python типа нет

log = logging.getLogger("tradetrust.api")
WEB_DIR = Path(__file__).resolve().parent / "web"


NOT_BUILT = ("<!doctype html><meta charset=utf-8><p>Мини-приложение не собрано: "
             "<code>cd miniapp &amp;&amp; npm ci &amp;&amp; npm run build</code></p>").encode()


def make_handler(owner_bot: Bot, token: str, tg_token: str = "", owner_id: str = "", web_dir: Path = WEB_DIR,
                 users=None, telegram=None, accounts=None):
    """accounts — счета владельца (основной и реальный): владельцу отвечает тот, что сейчас выбран."""
    web_dir = web_dir.resolve()

    def owner_now() -> Bot:
        return accounts.active() if accounts is not None else owner_bot

    def admin_data() -> dict:
        rows = users.rows() if users is not None else []
        return {
            "available": users is not None,
            "settings": users.settings() if users is not None else None,
            "stats": users.stats(rows) if users is not None else None,
            "users": rows,
            "system": admin.system_info(owner_bot, telegram),
        }

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, code: int, payload) -> None:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _static(self, path: str) -> None:
            name = "index.html" if path in ("", "/") else path.lstrip("/")
            file = (web_dir / name).resolve()
            if name == "index.html" and not file.is_file():
                self.send_response(503)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                return self.wfile.write(NOT_BUILT)
            if not file.is_file() or web_dir not in file.parents:
                return self._send(404, {"error": "not found"})
            body = file.read_bytes()
            self.send_response(200)
            ctype = mimetypes.guess_type(file.name)[0] or "application/octet-stream"
            self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or
                                                      ctype.endswith("javascript") else ""))
            self.send_header("Content-Length", str(len(body)))
            # файлы в assets/ с хешем в имени — их можно кешировать надолго
            self.send_header("Cache-Control", "public, max-age=31536000, immutable" if name.startswith("assets/")
                             else "no-cache")
            self.end_headers()
            self.wfile.write(body)

        owner = False  # спрашивает владелец — ему админка и переключение счетов

        def _bot(self) -> Bot | None:
            """Счёт того, кто спрашивает; None — ответ 401/403 уже отправлен."""
            header = self.headers.get("Authorization", "")
            if header.startswith("tma "):
                user = webapp_auth.validate(header[4:], tg_token)
                if user and str(user["id"]) == str(owner_id):
                    self.owner = True
                    return owner_now()
                if user and users is not None:
                    bot = users.get(user["id"], user, create=True)
                    if bot is not None:
                        return bot
                    self._send(403, {"error": users.closed_reason(user["id"])})
                    return None
            if header.startswith("Bearer ") and token and hmac.compare_digest(header[7:].strip(), token):
                self.owner = True
                return owner_now()
            self._send(401, {"error": "unauthorized"})
            return None

        def _admin_post(self, parts: list[str]) -> None:
            if users is None:
                return self._send(400, {"error": "демо-счета недоступны: не настроен Telegram"})
            try:
                if parts == ["settings"]:
                    body = self._body()
                    if not isinstance(body, dict):
                        return self._send(400, {"error": "нужен объект с настройками"})
                    return self._send(200, {"message": "Сохранено", "settings": users.update_settings(body)})
                if parts == ["broadcast"]:
                    n = users.broadcast(str(self._body().get("text", "")))
                    return self._send(200, {"message": f"Отправляется {n} пользователям"})
                if len(parts) == 3 and parts[0] == "users" and parts[2] in ("reset", "block", "unblock", "delete"):
                    uid, action = parts[1], parts[2]
                    msg = (users.reset(uid) if action == "reset" else users.delete(uid) if action == "delete"
                           else users.set_blocked(uid, action == "block"))
                    return self._send(200, {"message": msg})
            except ValueError as exc:
                return self._send(400, {"error": str(exc)})
            except KeyError:
                return self._send(404, {"error": "пользователь не найден"})
            return self._send(404, {"error": "not found"})

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_GET(self):
            url = urlparse(self.path)
            if url.path == "/health":
                return self._send(200, {"ok": True})
            if not url.path.startswith("/api/"):
                return self._static(url.path)
            bot = self._bot()
            if bot is None:
                return
            try:
                if url.path == "/api/status":
                    status = bot.status()
                    status["admin"] = self.owner  # админка — только владельцу
                    if self.owner and accounts is not None:
                        status["accounts"] = accounts.info()
                    return self._send(200, status)
                if url.path == "/api/admin":
                    if not self.owner:
                        return self._send(403, {"error": "только для владельца"})
                    return self._send(200, admin_data())
                if url.path == "/api/portfolio":
                    return self._send(200, bot.portfolio())
                if url.path == "/api/candles":
                    query = parse_qs(url.query)
                    coin = (query.get("coin") or [""])[0].upper()
                    interval = (query.get("interval") or ["4h"])[0]
                    if coin not in bot.watched_coins():
                        return self._send(400, {"error": "unknown coin"})
                    if interval not in CHART_INTERVALS:
                        return self._send(400, {"error": "unknown interval"})
                    return self._send(200, bot.chart(coin, interval))
                if url.path == "/api/trades":
                    coin = (parse_qs(url.query).get("coin") or [""])[0].upper()
                    if coin not in bot.watched_coins():
                        return self._send(400, {"error": "unknown coin"})
                    return self._send(200, bot.trades(coin))
            except Exception as exc:
                log.exception("api")
                return self._send(502, {"error": str(exc)})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            bot = self._bot()
            if bot is None:
                return
            parts = urlparse(self.path).path.strip("/").split("/")  # api/<...>
            if self.owner and accounts is not None and parts[:2] not in (["api", "account"], ["api", "admin"]):
                # приложение говорит, на каком счёте нажата кнопка: если счёт успели переключить
                # (например, из Telegram), действие не выполняется — на реальном счёте только так
                seen = self.headers.get("X-Account", "")
                if (seen or accounts.active_id == "real") and seen != accounts.active_id:
                    return self._send(409, {"error": f"Счёт переключён на «{accounts.label(accounts.active_id)}» — "
                                                     "обновите экран и повторите"})
            try:
                if parts[:2] == ["api", "admin"]:
                    if not self.owner:
                        return self._send(403, {"error": "только для владельца"})
                    return self._admin_post(parts[2:])
                if parts == ["api", "account"]:
                    if not self.owner or accounts is None:
                        return self._send(403, {"error": "только для владельца"})
                    try:
                        return self._send(200, {"message": accounts.switch(str(self._body().get("account", "")))})
                    except ValueError as exc:
                        return self._send(400, {"error": str(exc)})
                if parts == ["api", "bot"]:
                    enabled = self._body().get("enabled")
                    if not isinstance(enabled, bool):
                        return self._send(400, {"error": "enabled: true или false"})
                    try:
                        return self._send(200, {"message": bot.set_enabled(enabled)})
                    except ValueError as exc:
                        return self._send(400, {"error": str(exc)})
                if parts[:2] == ["api", "proposals"] and len(parts) == 4 and parts[3] in ("confirm", "reject"):
                    msg = bot.confirm(parts[2]) if parts[3] == "confirm" else bot.reject(parts[2])
                    return self._send(200, {"message": msg})
                if parts == ["api", "mode"]:
                    mode = self._body().get("mode")
                    if mode not in MODES:
                        return self._send(400, {"error": f"mode: {MODES}"})
                    bot.set_mode(mode)
                    return self._send(200, {"message": f"режим {mode}"})
                if parts == ["api", "order"]:
                    body = self._body()
                    try:
                        msg = bot.manual_order(str(body.get("coin", "")), str(body.get("side", "")),
                                               usdt=body.get("usdt"), qty=body.get("qty"))
                    except ValueError as exc:
                        return self._send(400, {"error": str(exc)})
                    return self._send(200, {"message": msg})
                if parts == ["api", "pause"]:
                    bot.pause("из приложения")
                    return self._send(200, {"message": "пауза"})
                if parts == ["api", "resume"]:
                    bot.resume()
                    return self._send(200, {"message": "пауза снята"})
                if parts == ["api", "settings"]:
                    body = self._body()
                    if not isinstance(body, dict):
                        return self._send(400, {"error": "нужен объект с настройками"})
                    try:
                        msg = bot.reset_settings() if body.get("reset") is True else bot.update_settings(body)
                    except ValueError as exc:
                        return self._send(400, {"error": str(exc)})
                    return self._send(200, {"message": msg})
                if parts[:2] == ["api", "positions"] and len(parts) == 4 and parts[3] == "close":
                    return self._send(200, {"message": bot.close(parts[2].upper(), "manual")})
            except Exception as exc:
                log.exception("api")
                return self._send(500, {"error": str(exc)})
            self._send(404, {"error": "not found"})

    return Handler


def serve(bot: Bot, token: str, port: int, tg_token: str = "", owner_id: str = "",
          web_dir: Path = WEB_DIR, users=None, telegram=None, accounts=None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port),
                                 make_handler(bot, token, tg_token, owner_id, web_dir, users, telegram, accounts))
    threading.Thread(target=server.serve_forever, name="api", daemon=True).start()
    log.info("HTTP на порту %s", port)
    return server
