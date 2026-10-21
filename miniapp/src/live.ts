// Живые цены прямо с биржи: открытый поток Bybit (WebSocket), без ключей и без нагрузки на сервер бота.
// Если поток недоступен, приложение просто показывает цены из /api/status, как раньше.
import { createContext, useContext, useEffect, useRef, useState } from "react";

export interface Ticker {
  price: number;
  change24h: number; // в процентах
  high24h?: number;
  low24h?: number;
  turnover24h?: number; // оборот за сутки в USDT
}

export interface LiveCandle {
  time: number; // начало свечи, секунды
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

type Listener = (data: Record<string, unknown>) => void;

const URLS = {
  mainnet: "wss://stream.bybit.com/v5/public/spot",
  testnet: "wss://stream-testnet.bybit.com/v5/public/spot",
};
const MAX_ARGS = 10; // спот Bybit принимает до 10 тем в одной подписке

/** Одно соединение на всё приложение; темы подписываются и отписываются по мере надобности. */
export class LiveFeed {
  private ws: WebSocket | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private last = new Map<string, Record<string, unknown>>(); // новый экран сразу получает последнюю цену
  private ping: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closed = false;
  /** Задержка последнего сообщения: сейчас минус время биржи (мс); null — сообщений ещё не было. */
  lag: number | null = null;

  constructor(private url: string) {}

  subscribe(topic: string, cb: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      this.send("subscribe", [topic]);
    }
    set.add(cb);
    const cached = this.last.get(topic);
    if (cached) queueMicrotask(() => set!.has(cb) && cb(cached));
    this.connect();
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(topic);
        this.last.delete(topic);
        this.send("unsubscribe", [topic]);
      }
    };
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    this.ws?.close();
  }

  private connect(): void {
    if (this.ws || this.closed || typeof WebSocket === "undefined") return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.send("subscribe", [...this.listeners.keys()]);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ op: "ping" })), 20_000);
    };
    ws.onmessage = (e) => {
      let msg: { topic?: string; data?: unknown; ts?: number };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!msg.topic || !msg.data) return;
      if (typeof msg.ts === "number") this.lag = Math.max(0, Date.now() - msg.ts);
      // сделки приходят пачкой — каждая важна; у цен и свечей последняя и есть актуальная
      const items = (Array.isArray(msg.data) ? msg.data : [msg.data]) as Record<string, unknown>[];
      if (!items.length) return;
      this.last.set(msg.topic, items[items.length - 1]);
      const set = this.listeners.get(msg.topic);
      for (const data of items) set?.forEach((cb) => cb(data));
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      this.ws = null;
      if (this.closed || this.listeners.size === 0) return;
      // переподключение с паузой 2, 4, 8… до 60 секунд
      const delay = Math.min(60_000, 2_000 * 2 ** this.attempts++);
      this.retry = setTimeout(() => this.connect(), delay);
    };
  }

  private send(op: "subscribe" | "unsubscribe", topics: string[]): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1 || topics.length === 0) return;
    for (let i = 0; i < topics.length; i += MAX_ARGS) {
      ws.send(JSON.stringify({ op, args: topics.slice(i, i + MAX_ARGS) }));
    }
  }
}

export function feedUrl(env: string): string {
  // демо-счёт и бумажный счёт торгуют по ценам основного рынка
  return env === "testnet" ? URLS.testnet : URLS.mainnet;
}

export const LiveContext = createContext<LiveFeed | null>(null);

export const num = (v: unknown): number => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);

// Bybit присылает цены спота много раз в секунду; экран обновляем 5 раз в секунду — глазу это непрерывно,
// а телефон не перерисовывает всё на каждое сообщение
const FLUSH_MS = 200;

/** Текущие цены монет и изменение за сутки. Пустой объект, пока поток не ответил. */
export function useTickers(coins: string[]): Record<string, Ticker> {
  const feed = useContext(LiveContext);
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const buffer = useRef<Record<string, Ticker>>({});
  const key = coins.join(",");
  useEffect(() => {
    if (!feed || !key) return;
    let dirty = false;
    const offs = key.split(",").map((coin) =>
      feed.subscribe(`tickers.${coin}USDT`, (d) => {
        const price = num(d.lastPrice);
        if (!Number.isFinite(price) || price <= 0) return;
        const opt = (v: unknown) => (Number.isFinite(num(v)) ? num(v) : undefined);
        buffer.current[coin] = { price, change24h: num(d.price24hPcnt) * 100, high24h: opt(d.highPrice24h),
          low24h: opt(d.lowPrice24h), turnover24h: opt(d.turnover24h) };
        dirty = true;
      }));
    const timer = setInterval(() => {
      if (dirty) {
        dirty = false;
        setTickers({ ...buffer.current });
      }
    }, FLUSH_MS);
    return () => {
      clearInterval(timer);
      offs.forEach((off) => off());
    };
  }, [feed, key]);
  return tickers;
}

/** Формирующаяся свеча монеты; code — интервал Bybit: 1, 5, 15, 60, 240, D, W ("" — не нужна). */
export function useLiveCandle(coin: string, code = "240"): LiveCandle | null {
  const feed = useContext(LiveContext);
  const [candle, setCandle] = useState<LiveCandle | null>(null);
  useEffect(() => {
    if (!feed || !code) return;
    setCandle(null);
    let latest: LiveCandle | null = null;
    const off = feed.subscribe(`kline.${code}.${coin}USDT`, (d) => {
      const c = { time: num(d.start) / 1000, open: num(d.open), high: num(d.high), low: num(d.low), close: num(d.close),
        volume: num(d.volume) || 0 };
      if ([c.time, c.open, c.high, c.low, c.close].every(Number.isFinite)) latest = c;
    });
    const timer = setInterval(() => latest && setCandle(latest), FLUSH_MS);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [feed, coin, code]);
  return candle;
}

export const TickersContext = createContext<Record<string, Ticker>>({});
export const useLiveTickers = () => useContext(TickersContext);

/** Задержка потока цен с биржи до телефона, мс; обновляется раз в секунду. null — поток ещё не ответил. */
export function useFeedLag(): number | null {
  const feed = useContext(LiveContext);
  const [lag, setLag] = useState<number | null>(feed?.lag ?? null);
  useEffect(() => {
    if (!feed) return;
    const t = setInterval(() => setLag(feed.lag), 1000);
    return () => clearInterval(t);
  }, [feed]);
  return lag;
}
