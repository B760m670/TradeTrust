"""HTTP API для Android-приложения. Доступ только с токеном (заголовок Authorization: Bearer <API_TOKEN>).

Снаружи API должен быть закрыт HTTPS — в docker-compose это делает Caddy.
"""
from __future__ import annotations

import hmac
import json
import logging
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import MODES
from .engine import Bot

log = logging.getLogger("tradetrust.api")


def make_handler(bot: Bot, token: str):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            log.info("%s %s", self.address_string(), fmt % args)

        def _send(self, code: int, payload) -> None:
            body = json.dumps(payload, ensure_ascii=False, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _authorized(self) -> bool:
            got = self.headers.get("Authorization", "").removeprefix("Bearer ").strip()
            if token and hmac.compare_digest(got, token):
                return True
            self._send(401, {"error": "unauthorized"})
            return False

        def _body(self) -> dict:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n) or b"{}") if n else {}

        def do_GET(self):
            if self.path == "/health":
                return self._send(200, {"ok": True})
            if not self._authorized():
                return
            if self.path == "/api/status":
                try:
                    return self._send(200, bot.status())
                except Exception as exc:
                    log.exception("status")
                    return self._send(502, {"error": str(exc)})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if not self._authorized():
                return
            parts = self.path.strip("/").split("/")  # api/<...>
            try:
                if parts[:2] == ["api", "proposals"] and len(parts) == 4 and parts[3] in ("confirm", "reject"):
                    msg = bot.confirm(parts[2]) if parts[3] == "confirm" else bot.reject(parts[2])
                    return self._send(200, {"message": msg})
                if parts == ["api", "mode"]:
                    mode = self._body().get("mode")
                    if mode not in MODES:
                        return self._send(400, {"error": f"mode: {MODES}"})
                    bot.set_mode(mode)
                    return self._send(200, {"message": f"режим {mode}"})
                if parts == ["api", "pause"]:
                    bot.pause("из приложения")
                    return self._send(200, {"message": "пауза"})
                if parts == ["api", "resume"]:
                    bot.resume()
                    return self._send(200, {"message": "пауза снята"})
                if parts[:2] == ["api", "positions"] and len(parts) == 4 and parts[3] == "close":
                    return self._send(200, {"message": bot.close(parts[2].upper(), "manual")})
            except Exception as exc:
                log.exception("api")
                return self._send(500, {"error": str(exc)})
            self._send(404, {"error": "not found"})

    return Handler


def serve(bot: Bot, token: str, port: int) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer(("0.0.0.0", port), make_handler(bot, token))
    threading.Thread(target=server.serve_forever, name="api", daemon=True).start()
    log.info("API на порту %s", port)
    return server
