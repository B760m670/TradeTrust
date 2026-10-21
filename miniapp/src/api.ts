// Типы и вызовы API бота (tradetrust/bot/api.py). Авторизация — подписью Telegram (initData).
import { initData } from "./telegram";

export type Mode = "signals" | "confirm" | "auto";
export type Env = "paper" | "demo" | "testnet" | "mainnet";

export interface Equity {
  total: number;
  free: number;
  usdt: number;
  invested: number;
  unrealized: number;
}

export interface Position {
  coin: string;
  qty: number;
  entry: number;
  stop: number;
  price: number;
  pnl_usdt: number;
  opened_at: number;
}

export interface Proposal {
  id: string;
  coin: string;
  price: number;
  stop: number;
  qty: number;
  risk_usdt: number;
  created_at: number;
  expires_at: number;
}

export interface Trade {
  id: number;
  coin: string;
  qty: number;
  entry: number;
  stop: number;
  exit: number;
  opened_at: number;
  closed_at: number;
  reason: string;
  pnl_usdt: number;
  r: number | null;
}

export interface BotEvent {
  id: number;
  ts: number;
  level: "info" | "warn" | "error";
  text: string;
}

export interface Signal {
  bar?: number;
  price?: number;
  atr?: number;
  ema_fast?: number;
  ema_slow?: number;
  cross_up?: boolean;
  trend_down?: boolean;
  regime_ok?: boolean;
  momentum?: number | null; // рост за trend_days дней, доля
  trend_ok?: boolean;       // проходит фильтр «только монеты в росте»
  error?: string;
}

/** То, что владелец меняет из приложения (tradetrust/bot/engine.py: EDITABLE). */
export interface EditableSettings {
  risk_pct: number;
  max_positions: number;
  max_position_pct: number;
  max_total_risk_pct: number;
  daily_loss_limit_pct: number;
  capital_usdt: number;
  proposal_ttl_min: number;
  report_hour_utc: number;
  btc_filter: boolean;
  btc_days: number;
  daily_report: boolean;
  trend_filter: boolean;
  trend_days: number;
  coins: string[];
}

export type NumericSetting = Exclude<keyof EditableSettings, "btc_filter" | "daily_report" | "trend_filter" | "coins">;

export interface Settings extends EditableSettings {
  atr_mult: number;
  ema_fast: number;
  ema_slow: number;
}

export interface Status {
  env: Env;
  /** owner — счёт владельца бота; demo — виртуальный демо-счёт пользователя */
  account?: "owner" | "demo";
  mode: Mode;
  paused: string | null;
  equity: Equity;
  positions: Position[];
  proposals: Proposal[];
  signals: Record<string, Signal>;
  last_bar: number;
  trades: Trade[];
  events: BotEvent[];
  settings: Settings;
  settings_defaults: EditableSettings;
  paper_start_usdt?: number;
  settings_limits: Record<NumericSetting, { min: number; max: number }>;
  all_coins: string[];
  equity_history: [number, number][]; // [время, капитал] после каждой 4ч свечи
  last_scan: Scan | null;
}

/** Итог последней проверки рынка (после закрытия 4ч свечи). */
export interface Scan {
  ts: number;
  bar: number;
  coins: number;
  up: number;
  entries: string[];
  exits: string[];
  /** сигналы на вход, которые бот пропустил, потому что биткоин ниже своей средней */
  held_back?: string[];
  btc?: BtcTrend | null;
}

/** Биткоин к своей средней: ниже — бот не открывает новые сделки. */
export interface BtcTrend {
  ok: boolean;
  days: number;
  price?: number;
  avg?: number;
  error?: string;
}

/** Сделка на рынке (не бота): время в мс, цена, объём. */
export interface MarketTrade {
  t: number;
  p: number;
  v: number;
}

export interface ChartData {
  coin: string;
  interval: string;
  time: number[];
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  ema_fast: (number | null)[];
  ema_slow: (number | null)[];
  atr: (number | null)[];
  position: { entry: number; stop: number; qty: number } | null;
}

export interface Asset {
  coin: string;
  qty: number;
  price: number | null; // null — у монеты нет пары к USDT
  value: number | null;
  bot_qty: number;      // сколько из этого куплено ботом
  stable: boolean;
}

export interface Portfolio {
  total: number;
  assets: Asset[];
  updated_at: number;
  bot: { capital: number; invested: number; free: number };
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { Authorization: `tma ${initData()}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw new ApiError("Нет доступа: приложение открывается только владельцем бота через Telegram.", 401);
  }
  if (!res.ok) throw new ApiError(data.error ?? `Ошибка ${res.status}`, res.status);
  return data as T;
}

type Message = { message: string };

export const api = {
  status: () => request<Status>("/api/status"),
  portfolio: () => request<Portfolio>("/api/portfolio"),
  trades: (coin: string) => request<{ coin: string; trades: MarketTrade[] }>(`/api/trades?coin=${encodeURIComponent(coin)}`),
  chart: (coin: string, interval = "4h") =>
    request<ChartData>(`/api/candles?coin=${encodeURIComponent(coin)}&interval=${interval}`),
  confirm: (id: string) => request<Message>(`/api/proposals/${id}/confirm`, "POST"),
  reject: (id: string) => request<Message>(`/api/proposals/${id}/reject`, "POST"),
  setMode: (mode: Mode) => request<Message>("/api/mode", "POST", { mode }),
  pause: () => request<Message>("/api/pause", "POST"),
  resume: () => request<Message>("/api/resume", "POST"),
  close: (coin: string) => request<Message>(`/api/positions/${coin}/close`, "POST"),
  saveSettings: (changes: Partial<EditableSettings>) => request<Message>("/api/settings", "POST", changes),
  resetSettings: () => request<Message>("/api/settings", "POST", { reset: true }),
};
