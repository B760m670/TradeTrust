// Счета владельца, как у бирж: демо и реальный, переключение — сверху на «Главной» и в настройках.
import { useState } from "react";
import { api, type AccountInfo, type Status } from "../api";
import { confirmAction, haptic } from "../telegram";
import { AccountBadge } from "./ui";
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

/** Переключатель «ДЕМО | РЕАЛЬНЫЙ» в шапке, как у бирж. На реальный — через окно с предупреждением. */
export function AccountSegment({ status: s, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const acc = s.accounts;
  const main = acc?.list.find((a) => a.id === "main");
  if (!acc || !main || main.real) return <AccountBadge real={s.env === "mainnet"} />;
  const isReal = acc.active === "real";
  return (
    <>
      <div className="acc-seg" role="radiogroup" aria-label="Счёт">
        <button role="radio" aria-checked={!isReal} className={isReal ? undefined : "on demo"} disabled={busy}
          onClick={() => { if (isReal) { haptic(); void act(() => api.switchAccount("main")); } }}>ДЕМО</button>
        <button role="radio" aria-checked={isReal} className={isReal ? "on real" : undefined} disabled={busy}
          onClick={() => { if (!isReal) { haptic(); setOpen(true); } }}>РЕАЛЬНЫЙ</button>
      </div>
      {open && <AccountSheet status={s} act={act} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Окно счёта: оба счёта, предупреждение и явная кнопка перехода на реальный. */
export function AccountSheet({ status: s, act, onClose }: { status: Status; act: Act; onClose: () => void }) {
  const acc = s.accounts!;
  const real = acc.list.find((a) => a.real);
  const toMain = () => {
    onClose();
    if (acc.active !== "main") void act(() => api.switchAccount("main"));
  };
  return (
    <Sheet title="Счёт" onClose={onClose}>
      <div className="account-list">
        {acc.list.map((a) => (
          <button key={a.id} className={`acc-opt${a.real ? " real" : " demo"}${(real ? a.real : a.id === acc.active) ? " on" : ""}`}
            onClick={() => (a.real ? undefined : toMain())}>
            <span className="account-dot" aria-hidden="true" />
            <span className="row-main">
              <strong>{a.label}</strong>
              <span className="muted small">{a.real ? "настоящие деньги · ключ только спот" : "виртуальные деньги по настоящим ценам"}</span>
            </span>
            {a.id === acc.active && <CheckIcon size={18} />}
          </button>
        ))}
      </div>
      {real ? (
        <>
          <div className="acc-warn">
            <strong>Переход на реальный счёт</strong>
            <span>Сделки здесь — настоящие деньги. Бот на этом счёте выключен, пока вы не зададите его капитал и не включите его.</span>
          </div>
          <button className="btn btn-real" onClick={() => { onClose(); void act(() => api.switchAccount(real.id)); }}>Перейти на реальный</button>
          <button className="btn" onClick={onClose}>Остаться в демо</button>
        </>
      ) : <RealHint error={acc.real_error} />}
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
