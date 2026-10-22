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
  /** spot — спот; linear — фьючерсы USDT, только лонг 1x: счёт мастер-трейдера копитрейдинга Bybit */
  market?: "spot" | "linear";
  /** owner — основной счёт владельца; real — его реальный счёт; demo — виртуальный демо-счёт пользователя */
  account?: "owner" | "real" | "demo";
  /** бот торгует на этом счёте; выключенный только доводит открытые позиции */
  enabled?: boolean;
  /** счета владельца и какой открыт — только владельцу */
  accounts?: Accounts;
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
  orders?: ManualOrder[];
  /** true — это владелец: ему видна админка */
  admin?: boolean;
  /** P2P владельца подключён (BYBIT_P2P=1) — показываем раздел */
  p2p?: boolean;
  /** «Мои биржи» подключены (ключи только для чтения на сервере) */
  exchanges?: boolean;
}

export interface AccountInfo {
  id: "main" | "futures" | "real";
  label: string;
  env: Env;
  real: boolean;
  /** раздел фьючерсов — тот же счёт Bybit, свой бот: лонг 1x для копитрейдинга */
  market?: "spot" | "linear";
}

export interface Accounts {
  active: AccountInfo["id"];
  list: AccountInfo[];
  /** ключ реального счёта задан в .env (даже если не подключился) */
  real_configured: boolean;
  real_error: string;
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

/** Ручная сделка на «Торговать» (бот её не ведёт). */
export interface ManualOrder {
  id: number;
  ts: number;
  coin: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  usdt: number;
}

export interface ChartData {
  coin: string;
  interval: string;
  time: number[];
  open: (number | null)[];
  high: (number | null)[];
  low: (number | null)[];
  close: (number | null)[];
  volume?: (number | null)[];
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
  /** ордера, открытые на бирже: лимитные и условные (TP/SL); bot — стоп позиции бота */
  open_orders?: OpenOrder[];
}

export interface OpenOrder {
  id: string;
  coin: string;
  side: "buy" | "sell";
  kind: "limit" | "tp" | "sl" | "stop";
  type: "limit" | "market";
  price: number | null;
  trigger: number | null;
  qty: number;
  created: number;
  bot: boolean;
}

export interface P2PAd {
  id: string; nick: string; price: number; quantity: number; min_amount: number; max_amount: number;
  payments: string[]; orders: number; rate: number; online: boolean; tags: string[];
}
export interface P2PPrefs {
  amount: number; payments: string[]; min_rate: number; min_orders: number; alert_pct: number;
  /** расходы на круг, %: комиссия мейкера за объявление на покупку и на продажу, банк/сеть/прочее */
  fee_buy_pct: number; fee_sell_pct: number; extra_pct: number;
  /** лимиты по способу оплаты (id → день/месяц) и порог месячного оборота */
  limits: Record<string, { day?: number; month?: number }>; month_cap: number;
}
export interface P2PCard {
  pay: string; name: string; day_in: number; day_out: number; month_in: number; month_out: number; people: number;
  limit: { day?: number; month?: number };
}
export interface P2PLedger {
  currency: string; cards: P2PCard[]; turnover: number; month_cap: number; people_day: number; people_month: number;
  warnings: { key: string; text: string }[]; month: string;
}
export interface P2POrder {
  id: string; side: "buy" | "sell"; status: number; status_text: string; price: number; amount: number; qty: number;
  currency: string; token: string; who: string; created: number; seconds_left: number;
}
export interface P2PStats {
  buy_qty: number; buy_fiat: number; sell_qty: number; sell_fiat: number; orders: number;
  buy_price: number | null; sell_price: number | null; profit: number;
}
export interface P2PView {
  available: boolean;
  currencies?: string[];
  currency?: string;
  error?: string;
  account?: { nickName?: string; recentRate?: number; recentFinishCount?: number; totalFinishCount?: number;
    averageReleaseTime?: number; recentTradeAmount?: number };
  market?: {
    currency: string; prefs: P2PPrefs; updated_at: number; bid: number | null; ask: number | null;
    gross_pct: number | null; costs_pct: number; ad_fee_pct: number;
    maker_pct: number | null; taker_pct: number | null; bids: P2PAd[]; asks: P2PAd[];
    total: { bids: number; asks: number }; payments: { id: string; name: string; ads: number; mine: boolean }[];
  };
  pending?: P2POrder[];
  stats?: Record<string, P2PStats>;
  ledger?: P2PLedger;
}

export interface VenueRow {
  exchange: string; name: string; price: number; spread_pct: number | null; volume_usd: number;
  stale: boolean; anomaly: boolean; thin: boolean; url: string | null; diff_pct: number | null;
}
export interface VenuePrices {
  coin: string; rows: VenueRow[]; median?: number | null; range_pct?: number | null; missing?: string[];
  updated_at?: number; source?: string; error?: string;
  /** биржа → открыт ли ввод/вывод монеты (по ключам владельца) */
  transfer?: Record<string, { deposit: boolean; withdraw: boolean }>;
}

export interface MyExchange {
  name: string; connected: boolean; error: string; warnings: string[];
  assets?: { coin: string; qty: number; price: number | null; value: number | null }[];
  total?: number; updated_at?: number;
}
export interface MyExchanges {
  exchanges: MyExchange[]; total: number;
  coins: { coin: string; qty: number; value: number; where: Record<string, number>;
    closed: Record<string, { deposit: boolean; withdraw: boolean }> }[];
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// Какой счёт владельца на экране. Сервер выполняет действие, только если это всё ещё активный счёт:
// если его переключили (например, из Telegram), кнопка на старом экране не сработает на другом счёте.
let shownAccount = "";
export function setShownAccount(id: string | undefined) {
  shownAccount = id ?? "";
}

async function request<T>(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `tma ${initData()}`, "Content-Type": "application/json",
      ...(shownAccount ? { "X-Account": shownAccount } : {}),
    },
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
  chart: (coin: string, interval = "4h", end?: number) =>
    request<ChartData>(`/api/candles?coin=${encodeURIComponent(coin)}&interval=${interval}${end ? `&end=${end}` : ""}`),
  trades: (coin: string) =>
    request<{ coin: string; trades: { t: number; p: number; v: number }[] }>(`/api/trades?coin=${encodeURIComponent(coin)}`),
  confirm: (id: string) => request<Message>(`/api/proposals/${id}/confirm`, "POST"),
  reject: (id: string) => request<Message>(`/api/proposals/${id}/reject`, "POST"),
  setMode: (mode: Mode) => request<Message>("/api/mode", "POST", { mode }),
  pause: () => request<Message>("/api/pause", "POST"),
  resume: () => request<Message>("/api/resume", "POST"),
  close: (coin: string) => request<Message>(`/api/positions/${coin}/close`, "POST"),
  saveSettings: (changes: Partial<EditableSettings>) => request<Message>("/api/settings", "POST", changes),
  order: (coin: string, side: "buy" | "sell", usdt: number) => request<Message>("/api/order", "POST", { coin, side, usdt }),
  admin: () => request<AdminData>("/api/admin"),
  exchanges: () => request<MyExchanges>("/api/exchanges"),
  venues: (coin: string) => request<VenuePrices>(`/api/venues?coin=${coin}`),
  p2p: (currency?: string) => request<P2PView>(`/api/p2p${currency ? `?currency=${currency}` : ""}`),
  p2pPrefs: (currency: string, changes: Partial<P2PPrefs>) =>
    request<{ message: string; prefs: P2PPrefs }>("/api/p2p/prefs", "POST", { currency, ...changes }),
  p2pJournal: () => request<{ message: string }>("/api/p2p/journal", "POST", {}),
  saveAdmin: (changes: Partial<AdminSettings>) => request<Message>("/api/admin/settings", "POST", changes),
  userAction: (id: string, action: "reset" | "block" | "unblock" | "delete") =>
    request<Message>(`/api/admin/users/${encodeURIComponent(id)}/${action}`, "POST", {}),
  broadcast: (text: string) => request<Message>("/api/admin/broadcast", "POST", { text }),
  switchAccount: (account: AccountInfo["id"]) => request<Message>("/api/account", "POST", { account }),
  setBotEnabled: (enabled: boolean) => request<Message>("/api/bot", "POST", { enabled }),
  resetSettings: () => request<Message>("/api/settings", "POST", { reset: true }),
};

// --- админка владельца ---------------------------------------------------------

export interface AdminSettings {
  registration_open: boolean;
  notify_new_users: boolean;
  max_users: number;
  demo_start_usdt: number;
}

export interface AdminUser {
  id: string;
  name: string;
  username: string;
  joined_at: number | null;
  last_seen: number | null;
  equity: number | null;
  start: number;
  pnl_pct: number | null;
  positions: number;
  trades: number;
  wins: number;
  mode: Mode;
  paused: string | null;
  blocked: boolean;
}

export interface AdminStats {
  total: number;
  new_day: number;
  new_week: number;
  active_day: number;
  active_week: number;
  profitable: number;
  losing: number;
  blocked: number;
  signups: { day: number; count: number }[];
}

export interface AdminSystem {
  version: string;
  built_at: string;
  started_at: number;
  now: number;
  env: Env;
  mode: Mode;
  paused: string | null;
  last_scan: number | null;
  next_scan: number;
  bybit: { ok_at: number | null; error_at: number | null; error: string };
  telegram: { ok_at: number | null; error: string };
  memory: {
    process_mb: number | null; total_mb: number | null; available_mb: number | null;
    swap_total_mb?: number | null; swap_free_mb?: number | null;
  };
  cpu?: { pct: number | null; load: number[]; cores: number };
  /** нагрузка по сервисам — собирает сервер раз в минуту (deploy/host_stats.py) */
  host?: { ts: number | null; fresh?: boolean; services: HostService[] };
  disk: { total_gb: number; free_gb: number; data_mb: number };
  errors: { ts: number; level: string; source: string; text: string }[];
}

export interface HostService {
  name: string;
  label: string;
  kind: "docker" | "service";
  mem_mb: number;
  cpu_pct: number;
}

export interface AdminData {
  available: boolean;
  settings: AdminSettings | null;
  stats: AdminStats | null;
  users: AdminUser[];
  system: AdminSystem;
}
