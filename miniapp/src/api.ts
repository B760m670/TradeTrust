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
  error?: string;
}

export interface Settings {
  risk_pct: number;
  atr_mult: number;
  ema_fast: number;
  ema_slow: number;
  btc_filter: boolean;
  capital_usdt: number;
  max_positions: number;
  coins: string[];
}

export interface Status {
  env: Env;
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
}

export interface ChartData {
  coin: string;
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
  chart: (coin: string) => request<ChartData>(`/api/candles?coin=${encodeURIComponent(coin)}`),
  confirm: (id: string) => request<Message>(`/api/proposals/${id}/confirm`, "POST"),
  reject: (id: string) => request<Message>(`/api/proposals/${id}/reject`, "POST"),
  setMode: (mode: Mode) => request<Message>("/api/mode", "POST", { mode }),
  pause: () => request<Message>("/api/pause", "POST"),
  resume: () => request<Message>("/api/resume", "POST"),
  close: (coin: string) => request<Message>(`/api/positions/${coin}/close`, "POST"),
};
