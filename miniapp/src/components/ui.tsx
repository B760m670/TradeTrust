import type { ReactNode } from "react";
import type { Tone } from "../format";
import type { ChipTone } from "../logic";

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Value({ tone, children, bold }: { tone?: Tone; children: ReactNode; bold?: boolean }) {
  return <span className={`value tone-${tone ?? "neutral"}${bold ? " bold" : ""}`}>{children}</span>;
}

export function Stat({ value, label, tone }: { value: ReactNode; label: string; tone?: Tone }) {
  return (
    <div className="stat">
      <Value tone={tone} bold>{value}</Value>
      <span className="stat-label">{label}</span>
    </div>
  );
}
