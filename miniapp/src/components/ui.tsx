// Свои компоненты интерфейса: карточки, плитки, кнопки, переключатель режимов, уведомления.
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from "react";
import type { Position } from "../api";
import { useAnimatedNumber } from "../hooks";
import { useFeedLag } from "../live";
import { price, usd, type Tone } from "../format";
import { rangeMarks, type ChipTone } from "../logic";
import { haptic, photoUrl } from "../telegram";

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function Value({ tone, children, bold }: { tone?: Tone; children: ReactNode; bold?: boolean }) {
  return <span className={`value tone-${tone ?? "neutral"}${bold ? " bold" : ""}`}>{children}</span>;
}

/** Крупная сумма: целая часть ярко, копейки и валюта приглушённо; меняется плавно. */
export function BigMoney({ value, unit = "USDT", className }: { value: number; unit?: string; className?: string }) {
  const shown = useAnimatedNumber(value);
  const [int, frac] = usd(shown).split(",");
  return (
    <div className={`big-money ${className ?? ""}`}>
      <span className="big-int">{int}</span>
      <span className="big-frac">,{frac}</span>
      <span className="big-unit">{unit}</span>
    </div>
  );
}

export function Card({ title, aside, children, className, style }: {
  title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; style?: CSSProperties;
}) {
  return (
    <section className={`card ${className ?? ""}`} style={style}>
      {(title || aside) && (
        <header className="card-head">
          <h2>{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  );
}

export function Tile({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: Tone; hint?: ReactNode }) {
  return (
    <div className={`tile tile-${tone ?? "neutral"}`}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">{value}</span>
      {hint && <span className="tile-hint">{hint}</span>}
    </div>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "up" };

export function Button({ variant = "ghost", className, onClick, ...rest }: ButtonProps) {
  return (
    <button {...rest} className={`btn btn-${variant} ${className ?? ""}`}
      onClick={(e) => { haptic(); onClick?.(e); }} />
  );
}

export function RoundAction({ icon, label, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: ReactNode; label: string; active?: boolean;
}) {
  return (
    <Button {...rest} className={`round${active ? " active" : ""}`} aria-pressed={active}>
      <span className="round-icon">{icon}</span>
      <span className="round-label">{label}</span>
    </Button>
  );
}

/** Сегменты с «ползунком», который плавно переезжает к выбранному пункту. */
export function Segmented<T extends string>({ options, value, onChange, disabled, label }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; disabled?: boolean; label: string;
}) {
  const index = Math.max(0, options.findIndex(([k]) => k === value));
  return (
    <div className="segmented" role="radiogroup" aria-label={label}
      style={{ "--n": options.length, "--i": index } as CSSProperties}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map(([key, text]) => (
        <button key={key} role="radio" aria-checked={key === value} disabled={disabled}
          className={key === value ? "on" : undefined}
          onClick={() => { if (key !== value) { haptic(); onChange(key); } }}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Вкладки с подчёркиванием, как у бирж: под графиком, в «Активах». */
export function Tabs<T extends string>({ options, value, onChange, label }: {
  options: [T, string][]; value: T; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {options.map(([key, text]) => (
        <button key={key} role="tab" aria-selected={key === value} className={key === value ? "on" : undefined}
          onClick={() => { if (key !== value) { haptic(); onChange(key); } }}>
          {text}
        </button>
      ))}
    </div>
  );
}

/** Метка счёта на каждом экране: «ДЕМО» синяя, «РЕАЛЬНЫЙ» оранжевая. */
export function AccountBadge({ real }: { real: boolean }) {
  return <span className={`acc-badge ${real ? "real" : "demo"}`}>{real ? "РЕАЛЬНЫЙ" : "ДЕМО"}</span>;
}

export function CoinAvatar({ coin, tone = "accent", size = 40 }: { coin: string; tone?: ChipTone; size?: number }) {
  return (
    <span className={`avatar chip-${tone}`} aria-hidden="true" style={{ width: size, height: size, fontSize: size * 0.28 }}>
      {coin.slice(0, 4)}
    </span>
  );
}

/** Шкала позиции: стоп слева, отметка входа, заливка до текущей цены. */
export function RangeBar({ position: p }: { position: Pick<Position, "stop" | "entry" | "price"> }) {
  const m = rangeMarks(p);
  const above = p.price >= p.entry;
  return (
    <div className="range">
      <div className="range-track">
        <div className={`range-fill ${above ? "up" : "down"}`} style={{ width: `${m.price}%` }} />
        <div className="range-entry" style={{ left: `${m.entry}%` }} />
      </div>
      <div className="range-labels">
        <span>Стоп {price(p.stop)}</span>
        <span>Вход {price(p.entry)}</span>
        <span>Сейчас {price(p.price)}</span>
      </div>
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number | string; width?: number | string }) {
  return <span className="skeleton" style={{ height, width }} />;
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon">{icon}</span>}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onClose, 3500);
    return () => clearTimeout(timer);
  }, [message, onClose]);
  return <div className="toast" role="status" onClick={onClose}>{message}</div>;
}

export function StatusDot({ tone }: { tone: "up" | "amber" | "down" | "muted" }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

/** Подсвечивает значение зелёным или красным, когда оно выросло или упало. */
export function Flash({ value, children, className }: { value: number | undefined; children: ReactNode; className?: string }) {
  const prev = useRef(value);
  const dir = useRef("");
  const tick = useRef(0);
  if (value != null && prev.current != null && value !== prev.current) {
    dir.current = value > prev.current ? "up" : "down";
    tick.current += 1;
  }
  prev.current = value;
  return <span key={tick.current} className={`flash${dir.current ? ` flash-${dir.current}` : ""} ${className ?? ""}`}>{children}</span>;
}

/** «Онлайн»: цены приходят с биржи в реальном времени. */
export function LiveBadge({ on }: { on: boolean }) {
  const lag = useFeedLag();
  if (!on) return null;
  const slow = lag != null && lag > 2000;
  const label = lag == null ? "онлайн" : slow ? `задержка ${(lag / 1000).toFixed(1).replace(".", ",")} с` : `онлайн · ${lag} мс`;
  return (
    <span className={`live-badge${slow ? " slow" : ""}`} title="Сколько идёт цена от биржи Bybit до телефона">
      <StatusDot tone={slow ? "amber" : "up"} />{label}
    </span>
  );
}

/** Аватарка в шапке: фото профиля Telegram, а если его нет или не загрузилось — «TT» на оранжевом. */
export function Logo() {
  const [failed, setFailed] = useState(false);
  const photo = photoUrl();
  if (photo && !failed) {
    return <img className="logo logo-photo" src={photo} alt="" aria-hidden="true" onError={() => setFailed(true)} />;
  }
  return <span className="logo" aria-hidden="true">TT</span>;
}
