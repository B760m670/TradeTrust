// Живые цены прямо с биржи: открытый поток Bybit (WebSocket), без ключей и без нагрузки на сервер бота.
// Если поток недоступен, приложение просто показывает цены из /api/status, как раньше.
import { createContext, useContext, useEffect, useRef, useState } from "react";

export interface Ticker {
  price: number;
  change24h: number; // в процентах
}

export interface LiveCandle {
  time: number; // начало свечи, секунды
  open: number;
  high: number;
  low: number;
  close: number;
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
  private ping: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private closed = false;

  constructor(private url: string) {}

  subscribe(topic: string, cb: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
      this.send("subscribe", [topic]);
    }
    set.add(cb);
    this.connect();
    return () => {
      set!.delete(cb);
      if (set!.size === 0) {
        this.listeners.delete(topic);
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
      let msg: { topic?: string; data?: unknown };
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (!msg.topic || !msg.data) return;
      const data = (Array.isArray(msg.data) ? msg.data[msg.data.length - 1] : msg.data) as Record<string, unknown>;
      this.listeners.get(msg.topic)?.forEach((cb) => cb(data));
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

const num = (v: unknown): number => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);

const FLUSH_MS = 1000; // биржа шлёт цены много раз в секунду — экрану хватает раза в секунду

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
        buffer.current[coin] = { price, change24h: num(d.price24hPcnt) * 100 };
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

/** Формирующаяся 4ч свеча монеты. */
export function useLiveCandle(coin: string): LiveCandle | null {
  const feed = useContext(LiveContext);
  const [candle, setCandle] = useState<LiveCandle | null>(null);
  useEffect(() => {
    if (!feed) return;
    setCandle(null);
    let latest: LiveCandle | null = null;
    const off = feed.subscribe(`kline.240.${coin}USDT`, (d) => {
      const c = { time: num(d.start) / 1000, open: num(d.open), high: num(d.high), low: num(d.low), close: num(d.close) };
      if ([c.time, c.open, c.high, c.low, c.close].every(Number.isFinite)) latest = c;
    });
    const timer = setInterval(() => latest && setCandle(latest), FLUSH_MS);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [feed, coin]);
  return candle;
}

export const TickersContext = createContext<Record<string, Ticker>>({});
export const useLiveTickers = () => useContext(TickersContext);
