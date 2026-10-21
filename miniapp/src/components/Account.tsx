// Счета владельца, как у бирж: демо и реальный, переключение — сверху на «Главной» и в настройках.
import { useState } from "react";
import { api, type AccountInfo, type Status } from "../api";
import { confirmAction, haptic } from "../telegram";
import type { Act } from "./BotControls";
import { EnvChip } from "./BotControls";
import { CheckIcon, ChevronIcon } from "./icons";
import { Sheet } from "./Sheet";

/** Кнопка счёта: у владельца — с выбором счёта, у остальных — просто метка. */
export function AccountButton({ status: s, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  if (!s.accounts) return <EnvChip status={s} />;
  const current = s.accounts.list.find((a) => a.id === s.accounts!.active);
  return (
    <>
      <button className={`chip chip-btn-account chip-${current?.real ? "down" : "muted"}`} disabled={busy}
        aria-label={`Счёт: ${current?.label ?? ""}. Сменить`} onClick={() => { haptic(); setOpen(true); }}>
        {current?.label ?? "Счёт"}<ChevronIcon size={14} />
      </button>
      {open && <AccountSheet status={s} act={act} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Переключить счёт; на реальный — только после подтверждения. Возвращает false, если не переключали. */
export async function switchAccount(s: Status, a: AccountInfo, act: Act): Promise<boolean> {
  if (a.id === s.accounts?.active) return false;
  if (a.real && !(await confirmAction("Перейти на реальный счёт Bybit? Сделки на нём — настоящие деньги."))) return false;
  void act(() => api.switchAccount(a.id));
  return true;
}

export function AccountSheet({ status: s, act, onClose }: { status: Status; act: Act; onClose: () => void }) {
  const pick = async (a: AccountInfo) => {
    if (a.id === s.accounts?.active || (await switchAccount(s, a, act))) onClose();
  };
  return (
    <Sheet title="Счёт" onClose={onClose}>
      <AccountList status={s} onPick={(a) => void pick(a)} />
    </Sheet>
  );
}

/** Список счетов и, если реального ещё нет, — как его подключить. */
export function AccountList({ status: s, onPick }: { status: Status; onPick: (a: AccountInfo) => void }) {
  const acc = s.accounts!;
  return (
    <div className="account-list">
      {acc.list.map((a) => (
        <button key={a.id} className={`list-row tappable${a.id === acc.active ? " on" : ""}`}
          aria-pressed={a.id === acc.active} onClick={() => onPick(a)}>
          <span className={`account-dot${a.real ? " real" : ""}`} aria-hidden="true" />
          <span className="row-main">
            <strong>{a.label}</strong>
            <span className="muted small">{a.real ? "настоящие деньги" : "виртуальные деньги по настоящим ценам"}</span>
          </span>
          {a.id === acc.active && <CheckIcon size={18} />}
        </button>
      ))}
      {!acc.list.some((a) => a.real) && <RealHint error={acc.real_error} />}
    </div>
  );
}

function RealHint({ error }: { error: string }) {
  return (
    <div className="account-hint">
      <strong>{error ? "Реальный счёт не подключился" : "Реальный счёт не подключён"}</strong>
      {error && <p className="tone-down small">{error}</p>}
      <ol className="muted small">
        <li>На Bybit создайте API-ключ: только «Спот — торговля», без вывода, с привязкой к IP сервера.</li>
        <li>Впишите его на сервере в <code>/opt/tradetrust/.env</code>: <code>BYBIT_REAL_API_KEY</code> и <code>BYBIT_REAL_API_SECRET</code>.</li>
        <li>Перезапустите бота. Ключ сюда, в чат или кому-либо не отправляйте.</li>
      </ol>
      <p className="muted small">Бот на реальном счёте сначала выключен — включается отдельно, после того как задан его капитал.</p>
    </div>
  );
}
