"""Telegram: уведомления, кнопки «Купить / Пропустить» и команды управления.

Бот отвечает только владельцу (TELEGRAM_CHAT_ID), сообщения из других чатов игнорируются.
"""
from __future__ import annotations

import logging
import threading
import time

import requests

from .config import MODES
from .engine import Bot, fmt

log = logging.getLogger("tradetrust.telegram")

HELP = """Команды:
/app — открыть приложение
/status — баланс, режим, позиции
/signals — что система видит на последней свече
/trades — последние сделки
/mode signals|confirm|auto — режим работы
/pause — не открывать новые сделки
/resume — снять паузу
/close BTC — закрыть позицию по рынку
/closeall — закрыть все позиции"""

MODE_NAMES = {"signals": "только сигналы", "confirm": "с подтверждением", "auto": "автоматически"}


class Telegram:
    def __init__(self, token: str, chat_id: str, webapp_url: str = "", session: requests.Session | None = None):
        self.url = f"https://api.telegram.org/bot{token}"
        self.chat_id = str(chat_id)
        self.webapp_url = webapp_url
        self.http = session or requests.Session()
        self.bot: Bot | None = None
        self.offset = 0

    def _call(self, method: str, **params) -> dict:
        resp = self.http.post(f"{self.url}/{method}", json=params, timeout=60)
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method}: {data.get('description')}")
        return data["result"]

    # --- Notifier ------------------------------------------------------------
    def send(self, text: str, buttons=None) -> int | None:
        params = {"chat_id": self.chat_id, "text": text, "disable_web_page_preview": True}
        if buttons:
            params["reply_markup"] = {"inline_keyboard": [[self._button(t, d) for t, d in row] for row in buttons]}
        return self._call("sendMessage", **params)["message_id"]

    @staticmethod
    def _button(text: str, data: str) -> dict:
        # "url:https://..." — кнопка, открывающая мини-приложение; иначе callback-кнопка
        if data.startswith("url:"):
            return {"text": text, "web_app": {"url": data[4:]}}
        return {"text": text, "callback_data": data}

    def edit(self, message_id: int, text: str) -> None:
        self._call("editMessageText", chat_id=self.chat_id, message_id=message_id, text=text)

    # --- входящие ------------------------------------------------------------
    def setup(self) -> None:
        """Список команд и кнопка «Открыть» слева от поля ввода."""
        self._call("setMyCommands", commands=[
            {"command": "app", "description": "Открыть приложение"},
            {"command": "status", "description": "Баланс и позиции"},
            {"command": "signals", "description": "Сигналы по монетам"},
            {"command": "trades", "description": "Последние сделки"},
            {"command": "mode", "description": "Режим: signals / confirm / auto"},
            {"command": "pause", "description": "Не открывать новые сделки"},
            {"command": "resume", "description": "Снять паузу"},
            {"command": "help", "description": "Все команды"},
        ])
        if self.webapp_url:
            self._call("setChatMenuButton", chat_id=int(self.chat_id),
                       menu_button={"type": "web_app", "text": "Открыть", "web_app": {"url": self.webapp_url}})

    def start(self, bot: Bot) -> threading.Thread:
        self.bot = bot
        try:
            self.setup()
        except Exception:
            log.exception("telegram setup")
        t = threading.Thread(target=self._loop, name="telegram", daemon=True)
        t.start()
        return t

    def _loop(self) -> None:
        while True:
            try:
                for upd in self._call("getUpdates", offset=self.offset, timeout=50,
                                      allowed_updates=["message", "callback_query"]):
                    self.offset = upd["update_id"] + 1
                    self.handle(upd)
            except Exception:
                log.exception("telegram loop")
                time.sleep(5)

    def handle(self, upd: dict) -> None:
        if "callback_query" in upd:
            q = upd["callback_query"]
            if str(q["message"]["chat"]["id"]) != self.chat_id:
                return
            answer = self.on_button(q.get("data", ""))
            self._call("answerCallbackQuery", callback_query_id=q["id"], text=answer[:190])
            return
        msg = upd.get("message") or {}
        if str(msg.get("chat", {}).get("id")) != self.chat_id:
            log.warning("сообщение из чужого чата %s проигнорировано", msg.get("chat", {}).get("id"))
            return
        reply = self.on_command(msg.get("text", "").strip())
        if reply:
            self.send(reply)

    def on_button(self, data: str) -> str:
        action, _, arg = data.partition(":")
        if action == "buy":
            return self.bot.confirm(arg)
        if action == "skip":
            return self.bot.reject(arg)
        if action == "closeall":
            results = self.bot.close_all()
            return "Закрыто позиций: %d" % len(results)
        return "?"

    def on_command(self, text: str) -> str | None:
        bot = self.bot
        cmd, *args = text.split() or [""]
        cmd = cmd.split("@")[0].lower()
        if cmd in ("/start", "/help", "/app"):
            if self.webapp_url:
                self.send("TradeTrust" if cmd == "/app" else HELP, [[("📊 Открыть приложение", f"url:{self.webapp_url}")]])
                return None
            return HELP if cmd != "/app" else "Мини-приложение недоступно: не задан DOMAIN в .env"
        if cmd == "/status":
            return self.status_text()
        if cmd == "/signals":
            return self.signals_text()
        if cmd == "/trades":
            trades = bot.store.trades(10)
            if not trades:
                return "Закрытых сделок пока нет."
            return "\n".join(f"{t['coin']}: {fmt(t['entry'])} → {fmt(t['exit'])}, {t['pnl_usdt']:+.2f} USDT "
                             f"({t['reason']})" for t in trades)
        if cmd == "/mode":
            if not args or args[0] not in MODES:
                return f"Сейчас: {MODE_NAMES[bot.mode]}. Варианты: /mode signals | confirm | auto"
            bot.set_mode(args[0])
            warn = "\n⚠️ Бот будет покупать сам, без вопросов." if args[0] == "auto" else ""
            return f"Режим: {MODE_NAMES[args[0]]}{warn}"
        if cmd == "/pause":
            bot.pause("вручную")
            return "Пауза: новые сделки не открываются. Стопы и выходы продолжают работать."
        if cmd == "/resume":
            bot.resume()
            return "Пауза снята."
        if cmd == "/close":
            if not args:
                return "Укажите монету: /close BTC"
            return bot.close(args[0].upper(), "manual")
        if cmd == "/closeall":
            n = len(bot.store.positions())
            if not n:
                return "Открытых позиций нет."
            self.send(f"Закрыть все позиции ({n}) по рынку?", [[("Да, закрыть все", "closeall:yes")]])
            return None
        return "Не понял команду.\n\n" + HELP

    def status_text(self) -> str:
        s = self.bot.status()
        eq = s["equity"]
        lines = [f"Счёт: {s['env']} · режим: {MODE_NAMES[s['mode']]}" + (f" · ПАУЗА ({s['paused']})" if s["paused"] else ""),
                 f"Капитал: {eq['total']:,.2f} USDT, свободно {eq['free']:,.2f}"]
        for p in s["positions"]:
            lines.append(f"• {p['coin']}: {p['qty']} по {fmt(p['entry'])}, сейчас {fmt(p['price'])}, "
                         f"стоп {fmt(p['stop'])}, {p['pnl_usdt']:+.2f} USDT")
        if not s["positions"]:
            lines.append("Открытых позиций нет.")
        return "\n".join(lines)

    def signals_text(self) -> str:
        sig = self.bot.store.get("signals", {})
        if not sig:
            return "Сигналов ещё нет — дождитесь закрытия свечи."
        held = {p.coin for p in self.bot.store.positions()}
        rows = []
        for coin, s in sorted(sig.items()):
            if "error" in s:
                rows.append(f"{coin}: ошибка данных")
                continue
            state = ("в позиции" if coin in held else
                     "ВХОД" if s["cross_up"] and s["regime_ok"] else
                     "тренд вниз" if s["trend_down"] else "тренд вверх")
            rows.append(f"{coin} {fmt(s['price'])}: {state}")
        return "\n".join(rows)
