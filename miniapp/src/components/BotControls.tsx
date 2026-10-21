// Режим, пауза и состояние бота — на телефоне в «Обзоре», на широком экране в боковой панели.
import { api, type Mode, type Status } from "../api";
import { ENV_LABELS } from "../logic";
import { confirmAction } from "../telegram";
import { PauseIcon, PlayIcon, PowerIcon } from "./icons";
import { Button, Chip, Segmented, StatusDot } from "./ui";

export type Act = (a: () => Promise<{ message: string }>) => Promise<boolean>;

const MODES: [Mode, string][] = [["signals", "Сигналы"], ["confirm", "Вручную"], ["auto", "Авто"]];

export function ModeSwitch({ status: s, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const setMode = async (mode: Mode) => {
    if (mode === "auto" && !(await confirmAction("Бот будет сам покупать по сигналам, без подтверждения. Включить?"))) return;
    void act(() => api.setMode(mode));
  };
  return <Segmented label="Режим бота" options={MODES} value={s.mode} disabled={busy} onChange={(m) => void setMode(m)} />;
}

export function PauseButton({ status: s, busy, act, compact }: { status: Status; busy: boolean; act: Act; compact?: boolean }) {
  const label = s.paused ? "Продолжить" : "Пауза";
  return (
    <Button variant={s.paused ? "primary" : "ghost"} className={compact ? "icon-btn" : "pause-btn"} disabled={busy}
      aria-label={label} title={label} onClick={() => void act(s.paused ? api.resume : api.pause)}>
      {s.paused ? <PlayIcon size={18} /> : <PauseIcon size={18} />}
      {!compact && <span>{label}</span>}
    </Button>
  );
}

export function BotState({ status: s }: { status: Status }) {
  if (s.enabled === false) return <span className="bot-state tone-muted"><StatusDot tone="muted" />Бот выключен</span>;
  return s.paused
    ? <span className="bot-state tone-amber"><StatusDot tone="amber" />Пауза: {s.paused}</span>
    : <span className="bot-state tone-up"><StatusDot tone="up" />Бот работает</span>;
}

/** Включить или выключить бота на этом счёте. На реальном — с отдельным подтверждением. */
export function BotPowerButton({ status: s, busy, act }: { status: Status; busy: boolean; act: Act }) {
  const on = s.enabled !== false;
  const toggle = async () => {
    const real = s.env === "mainnet";
    const cap = s.settings.capital_usdt;
    const ask = on
      ? "Выключить бота? Новых сделок не будет, открытые позиции он доведёт до конца: стоп и выход по тренду."
      : real
        ? `Бот начнёт торговать на РЕАЛЬНОМ счёте${cap > 0 ? ` в пределах ${cap.toLocaleString("ru-RU")} USDT` : ""}. Включить?`
        : "Включить бота на этом счёте?";
    if (await confirmAction(ask)) void act(() => api.setBotEnabled(!on));
  };
  return (
    <Button variant={on ? "ghost" : "primary"} disabled={busy} onClick={() => void toggle()}>
      <PowerIcon size={18} /><span>{on ? "Выключить" : "Включить"}</span>
    </Button>
  );
}

export function EnvChip({ status: s }: { status: Status }) {
  const env = s.account === "demo" ? { label: "Демо-счёт", real: false } : ENV_LABELS[s.env] ?? { label: s.env, real: false };
  return <Chip tone={env.real ? "down" : "muted"}>{env.label}</Chip>;
}
