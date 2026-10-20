// Логика отображения: состояние монеты, план входа, статистика журнала. Без React — покрыто тестами.
import type { Equity, Settings, Signal, Trade } from "./api";

export type ChipTone = "up" | "down" | "accent" | "amber" | "muted";

export interface CoinState {
  label: string;
  tone: ChipTone;
  order: number;
  isEntry: boolean;
}

/** То же, что бот видит на последней закрытой свече. */
export function coinState(sig: Signal | undefined, held: boolean): CoinState {
  if (!sig || sig.error) return { label: "нет данных", tone: "muted", order: 5, isEntry: false };
  if (held) return { label: "в позиции", tone: "accent", order: 1, isEntry: false };
  if (sig.cross_up && sig.regime_ok) return { label: "ВХОД", tone: "up", order: 0, isEntry: true };
  if (sig.cross_up) return { label: "фильтр BTC", tone: "amber", order: 2, isEntry: false };
  if (sig.trend_down) return { label: "тренд вниз", tone: "muted", order: 4, isEntry: false };
  return { label: "тренд вверх", tone: "muted", order: 3, isEntry: false };
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
