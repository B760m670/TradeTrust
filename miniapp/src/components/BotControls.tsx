// Режим, пауза и состояние бота — на телефоне в «Обзоре», на широком экране в боковой панели.
import { api, type Mode, type Status } from "../api";
import { ENV_LABELS } from "../logic";
import { confirmAction } from "../telegram";
import { PauseIcon, PlayIcon } from "./icons";
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
  return s.paused
    ? <span className="bot-state tone-amber"><StatusDot tone="amber" />Пауза: {s.paused}</span>
    : <span className="bot-state tone-up"><StatusDot tone="up" />Бот работает</span>;
}

export function EnvChip({ status: s }: { status: Status }) {
  const env = ENV_LABELS[s.env] ?? { label: s.env, real: false };
  return <Chip tone={env.real ? "down" : "muted"}>{env.label}</Chip>;
}
