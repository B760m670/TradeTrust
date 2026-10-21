// Поля настроек: число со стрелками и переключатель (настройки бота и админка)
import { stepValue } from "../logic";
import { haptic } from "../telegram";

const num = (x: number) => x.toLocaleString("ru-RU", { maximumFractionDigits: 2 });

export function Stepper({ value, min, max, step, unit, label, onChange, format }: {
  value: number; min: number; max: number; step: number; unit: string; label: string; onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  const move = (d: number) => { haptic(); onChange(stepValue(value, d, step, min, max)); };
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button aria-label="Меньше" disabled={value <= min} onClick={() => move(-1)}>−</button>
      <output aria-live="polite">{format ? format(value) : `${num(value)}${unit}`}</output>
      <button aria-label="Больше" disabled={value >= max} onClick={() => move(1)}>+</button>
    </div>
  );
}

export function Switch({ checked, label, onChange }: { checked: boolean; label: string; onChange: (v: boolean) => void }) {
  return (
    <button role="switch" aria-checked={checked} aria-label={label} className="switch"
      onClick={() => { haptic(); onChange(!checked); }} />
  );
}

