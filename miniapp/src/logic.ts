// Логика отображения: состояние монеты, план входа, риск, статистика журнала. Без React — покрыто тестами.
import type { EditableSettings, Equity, MarketTrade, Position, Settings, Signal, Status, Trade } from "./api";

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
  filtered: { label: "BTC падает", tone: "amber", order: 2 },
  up: { label: "Рост", tone: "up", order: 3 },
  down: { label: "Падение", tone: "muted", order: 4 },
  none: { label: "Нет данных", tone: "muted", order: 5 },
};

/** То же, что бот видит на последней закрытой свече. */
export function coinState(sig: Signal | undefined, held: boolean): CoinState {
  let kind: CoinKind;
  if (!sig || sig.error) kind = "none";
  else if (held) kind = "held";
  else if (sig.cross_up && sig.regime_ok && sig.trend_ok !== false) kind = "entry";
  else if (sig.cross_up) kind = "filtered";
  else if (sig.trend_down) kind = "down";
  else kind = "up";
  // вход есть, но его отсёк фильтр: долгосрочного роста нет или биткоин ниже своей средней
  const label = kind === "filtered" && sig?.trend_ok === false ? "Фильтр тренда" : STATES[kind].label;
  return { ...STATES[kind], label, kind, isEntry: kind === "entry" };
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

export interface Slice {
  key: string;
  label: string;
  value: number;
  share: number; // доля 0..100
}

/** Распределение портфеля: крупнейшие активы по отдельности, остальное — «Другие». */
export function allocation(assets: { coin: string; value: number | null }[], top = 5): Slice[] {
  const priced = assets.filter((a) => a.value && a.value > 0) as { coin: string; value: number }[];
  const total = priced.reduce((s, a) => s + a.value, 0);
  if (total <= 0) return [];
  const sorted = [...priced].sort((a, b) => b.value - a.value);
  const head = sorted.length > top + 1 ? sorted.slice(0, top) : sorted;
  const rest = sorted.slice(head.length).reduce((s, a) => s + a.value, 0);
  const slices = head.map((a) => ({ key: a.coin, label: a.coin, value: a.value, share: (a.value / total) * 100 }));
  if (rest > 0) slices.push({ key: "other", label: "Другие", value: rest, share: (rest / total) * 100 });
  return slices;
}

/** Изменение стоимости за 24 ч по изменениям цен монет (стейблкоины не меняются). */
export function dayChange(assets: { coin: string; value: number | null; stable: boolean }[],
  changes: Record<string, number | undefined>): { usd: number; pct: number } | null {
  let usd = 0, total = 0, known = false;
  for (const a of assets) {
    if (!a.value) continue;
    total += a.value;
    const ch = changes[a.coin];
    if (a.stable || ch == null) continue;
    known = true;
    usd += a.value - a.value / (1 + ch / 100);
  }
  return known && total - usd > 0 ? { usd, pct: (usd / (total - usd)) * 100 } : null;
}

/** Свеча за одну секунду из сделок — как «1с» на биржах; секунда без сделок — ровная свеча без объёма. */
export interface SecondBar {
  time: number; // секунда, UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const MAX_SECONDS = 15 * 60; // сколько секундных свечей держать

const flat = (time: number, price: number): SecondBar => ({ time, open: price, high: price, low: price, close: price, volume: 0 });

function trim(bars: SecondBar[]): void {
  if (bars.length > MAX_SECONDS) bars.splice(0, bars.length - MAX_SECONDS);
}

/** Добавляет сделку (время в мс) в секундные свечи; возвращает свечу, которую она изменила, или null. */
export function addTrade(bars: SecondBar[], trade: MarketTrade): SecondBar | null {
  const sec = Math.floor(trade.t / 1000);
  const last = bars[bars.length - 1];
  if (!Number.isFinite(trade.p) || trade.p <= 0) return null;
  if (last && sec <= last.time) {
    // сделка той же секунды или запоздавшая — в свою свечу
    const bar = sec === last.time ? last : bars.find((b) => b.time === sec);
    if (!bar) return null;
    if (bar.volume === 0) bar.open = trade.p; // секунда была пустой — первая сделка открывает свечу
    bar.high = Math.max(bar.volume === 0 ? trade.p : bar.high, trade.p);
    bar.low = Math.min(bar.volume === 0 ? trade.p : bar.low, trade.p);
    bar.close = trade.p;
    bar.volume += trade.v;
    return bar;
  }
  if (last && sec - last.time > MAX_SECONDS) bars.length = 0; // долгая пауза — начинаем заново
  const prev = bars[bars.length - 1];
  if (prev) for (let s = prev.time + 1; s < sec; s++) bars.push(flat(s, prev.close));
  const bar = { time: sec, open: trade.p, high: trade.p, low: trade.p, close: trade.p, volume: trade.v };
  bars.push(bar);
  trim(bars);
  return bar;
}

/** Время идёт и без сделок: дописывает ровные свечи до секунды upTo; возвращает новые свечи. */
export function fillSeconds(bars: SecondBar[], upTo: number): SecondBar[] {
  const last = bars[bars.length - 1];
  if (!last || upTo <= last.time) return [];
  const added: SecondBar[] = [];
  for (let s = Math.max(last.time + 1, upTo - MAX_SECONDS + 1); s <= upTo; s++) added.push(flat(s, last.close));
  if (added.length && added[0].time !== last.time + 1) bars.length = 0;
  bars.push(...added);
  trim(bars);
  return added;
}

/** Часовой пояс телефона для подписей: «UTC+3», «UTC+5:30», «UTC−4». */
export function utcOffsetLabel(offsetMin: number): string {
  const sign = offsetMin < 0 ? "−" : "+";
  const a = Math.abs(offsetMin);
  return `UTC${sign}${Math.floor(a / 60)}${a % 60 ? `:${String(a % 60).padStart(2, "0")}` : ""}`;
}

/** Состояние живого потока сделок для подписи на графике. delays — недавние задержки, мс. */
export function feedState(delays: number[], lastTradeAt: number | null, now: number):
  { kind: "wait" | "live" | "quiet"; text: string } {
  if (lastTradeAt == null) return { kind: "wait", text: "ждём сделок" };
  const quiet = Math.floor((now - lastTradeAt) / 1000);
  if (quiet >= 10) return { kind: "quiet", text: `сделок нет ${quiet} с` };
  const sorted = [...delays].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  const sec = Math.max(0, median) / 1000;
  return { kind: "live", text: `задержка ${sec < 0.1 ? "<0,1" : sec.toFixed(1).replace(".", ",")} с` };
}

/** «только что», «5 мин назад», «3 ч назад», «2 дн назад» — для админки. */
export function ago(sec: number | null | undefined, now: number): string {
  if (sec == null) return "—";
  const d = Math.max(0, now - sec);
  if (d < 60) return "только что";
  if (d < 3600) return `${Math.floor(d / 60)} мин назад`;
  if (d < 86400) return `${Math.floor(d / 3600)} ч назад`;
  return `${Math.floor(d / 86400)} дн назад`;
}

/** Сколько работает: «3 мин», «5 ч 12 мин», «2 дн 4 ч». */
export function duration(sec: number): string {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d) return `${d} дн ${h % 24} ч`;
  if (h) return `${h} ч ${m % 60} мин`;
  return `${m} мин`;
}

/** Поиск по имени, @username и Telegram ID. */
export function filterUsers<T extends { id: string; name: string; username: string }>(rows: T[], query: string): T[] {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return rows;
  return rows.filter((r) => r.name.toLowerCase().includes(q) || r.username.toLowerCase().includes(q) || r.id.includes(q));
}
