// Логика отображения: состояние монеты, план входа, риск, статистика журнала. Без React — покрыто тестами.
import type { EditableSettings, Equity, Position, Settings, Signal, Status, Trade } from "./api";

export type ChipTone = "up" | "down" | "accent" | "amber" | "muted";
export type CoinKind = "entry" | "held" | "filtered" | "up" | "down" | "none";

export interface CoinState {
  label: string;
  tone: ChipTone;
  kind: CoinKind;
  order: number;
  isEntry: boolean;
}

const STATES: Record<CoinKind, Omit<CoinState, "kind" | "isEntry">> = {
  entry: { label: "Вход", tone: "accent", order: 0 },
  held: { label: "В позиции", tone: "up", order: 1 },
  filtered: { label: "Фильтр BTC", tone: "amber", order: 2 },
  up: { label: "Рост", tone: "up", order: 3 },
  down: { label: "Падение", tone: "muted", order: 4 },
  none: { label: "Нет данных", tone: "muted", order: 5 },
};

/** То же, что бот видит на последней закрытой свече. */
export function coinState(sig: Signal | undefined, held: boolean): CoinState {
  let kind: CoinKind;
  if (!sig || sig.error) kind = "none";
  else if (held) kind = "held";
  else if (sig.cross_up && sig.regime_ok) kind = "entry";
  else if (sig.cross_up) kind = "filtered";
  else if (sig.trend_down) kind = "down";
  else kind = "up";
  return { ...STATES[kind], kind, isEntry: kind === "entry" };
}

export interface SignalRow {
  coin: string;
  signal: Signal;
  state: CoinState;
}

export function signalRows(signals: Record<string, Signal>, held: Set<string>): SignalRow[] {
  return Object.entries(signals)
    .map(([coin, signal]) => ({ coin, signal, state: coinState(signal, held.has(coin)) }))
    .sort((a, b) => a.state.order - b.state.order || a.coin.localeCompare(b.coin));
}

export type SignalFilter = "all" | "entry" | "held" | "up" | "down";

export const SIGNAL_FILTERS: [SignalFilter, string][] = [
  ["all", "Все"], ["entry", "Входы"], ["held", "В позиции"], ["up", "Рост"], ["down", "Падение"],
];

export function filterRows(rows: SignalRow[], filter: SignalFilter): SignalRow[] {
  if (filter === "all") return rows;
  // «фильтр BTC» — тоже восходящий тренд, просто вход заблокирован
  return rows.filter((r) => r.state.kind === filter || (filter === "up" && r.state.kind === "filtered"));
}

/** Разрыв между быстрой и медленной EMA в % — сила тренда. */
export function emaGap(sig: Signal): number | null {
  return sig.ema_fast != null && sig.ema_slow ? (sig.ema_fast / sig.ema_slow - 1) * 100 : null;
}

export interface EntryPlan {
  qty: number;
  stop: number;
  stopPct: number;
  risk: number;
  cost: number;
}

/** Ориентировочный план по системе: риск settings.risk_pct от капитала, стоп atr_mult × ATR. */
export function entryPlan(sig: Signal, settings: Settings, equity: Equity): EntryPlan | null {
  if (!sig.price || !sig.atr) return null;
  const stop = sig.price - settings.atr_mult * sig.atr;
  const dist = sig.price - stop;
  if (dist <= 0) return null;
  const qty = Math.max(0, Math.min((equity.total * settings.risk_pct) / 100 / dist, equity.free / sig.price));
  return { qty, stop, stopPct: (dist / sig.price) * 100, risk: qty * dist, cost: qty * sig.price };
}

/** Сколько потеряем от текущих цен, если сработают все стопы. */
export function stopRisk(positions: Position[]): number {
  return positions.reduce((a, p) => a + Math.max(0, (p.price - p.stop) * p.qty), 0);
}

const BAR_SECONDS = 4 * 3600;

/** Время закрытия текущей 4ч свечи (свечи Bybit начинаются в 00, 04, 08… UTC). */
export function nextCandleClose(nowSec: number): number {
  return Math.floor(nowSec / BAR_SECONDS) * BAR_SECONDS + BAR_SECONDS;
}

export interface RangeMarks {
  entry: number;
  price: number;
}

/** Положение входа и текущей цены на шкале «стоп → выше максимума», в % ширины. */
export function rangeMarks(p: Pick<Position, "stop" | "entry" | "price">): RangeMarks {
  const top = Math.max(p.entry, p.price);
  const span = top - p.stop;
  if (span <= 0) return { entry: 0, price: 0 };
  const hi = top + span * 0.15;
  const at = (x: number) => Math.min(100, Math.max(0, ((x - p.stop) / (hi - p.stop)) * 100));
  return { entry: at(p.entry), price: at(p.price) };
}

export interface JournalStats {
  count: number;
  winRate: number | null;
  pnl: number;
  avgR: number | null;
  profitFactor: number | null;
}

export function journalStats(trades: Trade[]): JournalStats {
  const wins = trades.filter((t) => t.pnl_usdt > 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl_usdt, 0);
  const grossLoss = -trades.filter((t) => t.pnl_usdt <= 0).reduce((a, t) => a + t.pnl_usdt, 0);
  const rs = trades.map((t) => t.r).filter((r): r is number => r != null);
  return {
    count: trades.length,
    winRate: trades.length ? (100 * wins.length) / trades.length : null,
    pnl: trades.reduce((a, t) => a + t.pnl_usdt, 0),
    avgR: rs.length ? rs.reduce((a, r) => a + r, 0) / rs.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
  };
}

export const REASONS: Record<string, string> = { stop: "стоп", signal: "сигнал", manual: "вручную" };

export const ENV_LABELS: Record<string, { label: string; real: boolean }> = {
  paper: { label: "Бумажный счёт", real: false },
  demo: { label: "Демо Bybit", real: false },
  testnet: { label: "Тестнет Bybit", real: false },
  mainnet: { label: "Реальный счёт", real: true },
};

/** Что изменилось в форме настроек по сравнению с сохранённым на сервере. */
export function changedSettings(draft: EditableSettings, saved: EditableSettings): Partial<EditableSettings> {
  const out: Partial<EditableSettings> = {};
  for (const key of Object.keys(draft) as (keyof EditableSettings)[]) {
    const a = draft[key], b = saved[key];
    const same = Array.isArray(a) && Array.isArray(b) ? a.join() === b.join() : a === b;
    if (!same) (out as Record<string, unknown>)[key] = a;
  }
  return out;
}

/** Шаг вверх/вниз с округлением до шага и в пределах границ. */
export function stepValue(value: number, delta: number, step: number, min: number, max: number): number {
  const next = Math.round((value + delta * step) / step) * step;
  return Math.min(max, Math.max(min, Number(next.toFixed(6))));
}

/** Статус бота с живыми ценами: позиции, их результат, капитал и цены в сигналах. */
export function withLivePrices(s: Status, prices: Record<string, { price: number }>): Status {
  if (Object.keys(prices).length === 0) return s;
  let delta = 0;
  const positions = s.positions.map((p) => {
    const live = prices[p.coin]?.price;
    if (!live) return p;
    delta += (live - p.price) * p.qty;
    return { ...p, price: live, pnl_usdt: (live - p.entry) * p.qty };
  });
  const signals = Object.fromEntries(Object.entries(s.signals).map(([coin, sig]) => {
    const live = prices[coin]?.price;
    return [coin, live && !sig.error ? { ...sig, price: live } : sig];
  }));
  const equity = {
    ...s.equity,
    total: s.equity.total + delta,
    invested: s.equity.invested + delta,
    unrealized: s.equity.unrealized + delta,
  };
  return { ...s, positions, signals, equity };
}

/** Худшее падение капитала от предыдущего максимума, в % (отрицательное число или 0). */
export function maxDrawdown(values: number[]): number {
  let peak = -Infinity, worst = 0;
  for (const v of values) {
    peak = Math.max(peak, v);
    if (peak > 0) worst = Math.min(worst, (v / peak - 1) * 100);
  }
  return worst;
}

/** Час отчёта: сервер хранит UTC, человек видит своё время. offsetMin — смещение пояса в минутах. */
export function localTime(hourUtc: number, offsetMin: number): string {
  const m = (((hourUtc * 60 + offsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}
