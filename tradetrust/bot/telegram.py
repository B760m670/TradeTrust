"""Telegram: уведомления, кнопки «Купить / Пропустить» и команды управления.

Владелец (TELEGRAM_CHAT_ID) управляет своим счётом. Остальные пользователи — если включены демо-счета
(PUBLIC_DEMO) — получают по /start свой бумажный счёт и управляют только им.
"""
from __future__ import annotations

import logging
import threading
import time

import requests

from .config import MODES
from .engine import MODE_NAMES, Bot, fmt

log = logging.getLogger("tradetrust.telegram")

HELP = """Команды:
/app — открыть приложение
/status — баланс, режим, позиции
/signals — что система видит на последней свече
/trades — последние сделки
/report — сводка за сутки
/mode signals|confirm|auto — режим работы
/pause — не открывать новые сделки
/resume — снять паузу
/close BTC — закрыть позицию по рынку
/closeall — закрыть все позиции"""

OWNER_HELP = HELP + "\n/users — демо-счета пользователей"
NO_ACCOUNT = "Чтобы открыть демо-счёт, нажмите /start."



class Telegram:
    def __init__(self, token: str, chat_id: str, webapp_url: str = "", session: requests.Session | None = None):
        self.url = f"https://api.telegram.org/bot{token}"
        self.chat_id = str(chat_id)
        self.webapp_url = webapp_url
        self.http = session or requests.Session()
        self.bot: Bot | None = None
        self.users = None  # Users — демо-счета, если включены
        self.offset = 0
        self.ok_at: float | None = None  # для админки: когда Telegram последний раз ответил
        self.error = ""

    def _call(self, method: str, **params) -> dict:
        resp = self.http.post(f"{self.url}/{method}", json=params, timeout=60)
        data = resp.json()
        if not data.get("ok"):
            raise RuntimeError(f"Telegram {method}: {data.get('description')}")
        return data["result"]

    # --- Notifier ------------------------------------------------------------
    def send(self, text: str, buttons=None, chat_id: str | None = None) -> int | None:
        params = {"chat_id": chat_id or self.chat_id, "text": text, "disable_web_page_preview": True}
        if buttons:
            params["reply_markup"] = {"inline_keyboard": [[self._button(t, d) for t, d in row] for row in buttons]}
        return self._call("sendMessage", **params)["message_id"]

    @staticmethod
    def _button(text: str, data: str) -> dict:
        # "url:https://..." — кнопка, открывающая мини-приложение; иначе callback-кнопка
        if data.startswith("url:"):
            return {"text": text, "web_app": {"url": data[4:]}}
        return {"text": text, "callback_data": data}

    def edit(self, message_id: int, text: str, chat_id: str | None = None) -> None:
        self._call("editMessageText", chat_id=chat_id or self.chat_id, message_id=message_id, text=text)

    def for_chat(self, chat_id: str) -> "ChatNotifier":
        """Уведомления в чат пользователя с демо-счётом."""
        return ChatNotifier(self, str(chat_id))

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
            button = {"type": "web_app", "text": "Открыть", "web_app": {"url": self.webapp_url}}
            self._call("setChatMenuButton", chat_id=int(self.chat_id), menu_button=button)
            if self.users is not None:  # кнопка «Открыть» у всех, кто пишет боту
                self._call("setChatMenuButton", menu_button=button)

    def start(self, bot: Bot, users=None) -> threading.Thread:
        self.bot = bot
        self.users = users
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
                updates = self._call("getUpdates", offset=self.offset, timeout=50,
                                     allowed_updates=["message", "callback_query"])
                self.ok_at, self.error = time.time(), ""
                for upd in updates:
                    self.offset = upd["update_id"] + 1
                    self.handle(upd)
            except Exception as exc:
                log.exception("telegram loop")
                self.error = str(exc)[:300]
                time.sleep(5)

    def bot_for(self, chat_id: str, profile: dict | None = None, create: bool = False) -> Bot | None:
        """Чей счёт: владельца или демо-счёт пользователя (create — открыть, если его нет)."""
        if chat_id == self.chat_id:
            return self.bot
        if self.users is None:
            return None
        return self.users.get(chat_id, profile, create=create)

    def handle(self, upd: dict) -> None:
        if "callback_query" in upd:
            q = upd["callback_query"]
            chat = str(q["message"]["chat"]["id"])
            bot = self.bot_for(chat)
            if bot is None:
                return
            answer = self.on_button(q.get("data", ""), bot)
            self._call("answerCallbackQuery", callback_query_id=q["id"], text=answer[:190])
            return
        msg = upd.get("message") or {}
        chat = str(msg.get("chat", {}).get("id"))
        text = msg.get("text", "").strip()
        if chat != self.chat_id and msg.get("chat", {}).get("type") != "private":
            return  # группы и каналы — мимо
        if self.users is None and chat != self.chat_id:
            log.warning("сообщение из чужого чата %s проигнорировано", chat)
            return
        cmd = (text.split() or [""])[0].split("@")[0].lower()
        bot = self.bot_for(chat, msg.get("from"), create=cmd in ("/start", "/app"))
        if bot is None:
            text = self.users.closed_reason(chat) if cmd in ("/start", "/app") else NO_ACCOUNT
            if chat in self.users.blocked():
                text = self.users.closed_reason(chat)
            self.send(text, chat_id=chat)
            return
        reply = self.on_command(text, bot, chat)
        if reply:
            self.send(reply, chat_id=chat)

    def on_button(self, data: str, bot: Bot | None = None) -> str:
        bot = bot or self.bot
        action, _, arg = data.partition(":")
        if action == "buy":
            return bot.confirm(arg)
        if action == "skip":
            return bot.reject(arg)
        if action == "closeall":
            results = bot.close_all()
            return "Закрыто позиций: %d" % len(results)
        return "?"

    def on_command(self, text: str, bot: Bot | None = None, chat: str | None = None) -> str | None:
        bot = bot or self.bot
        chat = chat or self.chat_id
        owner = chat == self.chat_id
        cmd, *args = text.split() or [""]
        cmd = cmd.split("@")[0].lower()
        if cmd in ("/start", "/help", "/app"):
            text = "TradeTrust" if cmd == "/app" else (OWNER_HELP if owner else HELP)
            if self.webapp_url:
                self.send(text, [[("📊 Открыть приложение", f"url:{self.webapp_url}")]], chat_id=chat)
                return None
            return text if cmd != "/app" else "Мини-приложение недоступно: не задан DOMAIN в .env"
        if cmd == "/users" and owner:
            return self.users.summary() if self.users is not None else "Демо-счета выключены (PUBLIC_DEMO=0)."
        if cmd == "/status":
            return self.status_text(bot)
        if cmd == "/signals":
            return self.signals_text(bot)
        if cmd == "/report":
            return bot.daily_report_text()
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
            self.send(f"Закрыть все позиции ({n}) по рынку?", [[("Да, закрыть все", "closeall:yes")]], chat_id=chat)
            return None
        return "Не понял команду.\n\n" + (OWNER_HELP if owner else HELP)

    def status_text(self, bot: Bot | None = None) -> str:
        s = (bot or self.bot).status()
        eq = s["equity"]
        lines = [f"Счёт: {s['env']} · режим: {MODE_NAMES[s['mode']]}" + (f" · ПАУЗА ({s['paused']})" if s["paused"] else ""),
                 f"Капитал: {eq['total']:,.2f} USDT, свободно {eq['free']:,.2f}"]
        for p in s["positions"]:
            lines.append(f"• {p['coin']}: {p['qty']} по {fmt(p['entry'])}, сейчас {fmt(p['price'])}, "
                         f"стоп {fmt(p['stop'])}, {p['pnl_usdt']:+.2f} USDT")
        if not s["positions"]:
            lines.append("Открытых позиций нет.")
        return "\n".join(lines)

    def signals_text(self, bot: Bot | None = None) -> str:
        bot = bot or self.bot
        sig = bot.store.get("signals", {})
        if not sig:
            return "Сигналов ещё нет — дождитесь закрытия свечи."
        held = {p.coin for p in bot.store.positions()}
        rows = []
        for coin, s in sorted(sig.items()):
            if "error" in s:
                rows.append(f"{coin}: ошибка данных")
                continue
            state = ("в позиции" if coin in held else
                     "ВХОД" if s["cross_up"] and s["regime_ok"] and s.get("trend_ok", True) else
                     "тренд вниз" if s["trend_down"] else "тренд вверх")
            rows.append(f"{coin} {fmt(s['price'])}: {state}")
        return "\n".join(rows)


class ChatNotifier:
    """Notifier для одного чата — у каждого демо-счёта свой."""

    def __init__(self, telegram: Telegram, chat_id: str):
        self.tg, self.chat_id = telegram, chat_id

    def send(self, text: str, buttons=None) -> int | None:
        return self.tg.send(text, buttons, chat_id=self.chat_id)

    def edit(self, message_id: int, text: str) -> None:
        self.tg.edit(message_id, text, chat_id=self.chat_id)
