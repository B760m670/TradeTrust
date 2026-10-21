// Свечи для графика: история с сервера бота (страницами, назад во времени), живая свеча — из потока Bybit.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ChartData } from "../api";
import type { LiveCandle } from "../live";

export interface Bar {
  time: number; // начало свечи, секунды UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";
export const INTERVALS: [Interval, string][] = [
  ["1m", "1м"], ["5m", "5м"], ["15m", "15м"], ["1h", "1ч"], ["4h", "4ч"], ["1d", "1Д"], ["1w", "1Н"],
];
/** Код интервала в потоке Bybit (kline.<код>.<пара>). */
export const STREAM_CODE: Record<Interval, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" };

export function toBars(d: ChartData): Bar[] {
  const out: Bar[] = [];
  d.time.forEach((t, i) => {
    const [o, h, l, c] = [d.open[i], d.high[i], d.low[i], d.close[i]];
    if (o == null || h == null || l == null || c == null) return;
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: d.volume?.[i] ?? 0 });
  });
  return out;
}

/** Старые свечи перед уже загруженными, без повторов; результат по возрастанию времени. */
export function prependBars(older: Bar[], bars: Bar[]): Bar[] {
  const first = bars[0]?.time ?? Infinity;
  return [...older.filter((b) => b.time < first), ...bars];
}

/** Живая свеча поверх истории: обновляет последнюю или добавляет новую. Закрытые раньше не трогает. */
export function withLive(bars: Bar[], live: LiveCandle | null | undefined, volume = 0): Bar[] {
  if (!live || !bars.length) return bars;
  const last = bars[bars.length - 1];
  if (live.time < last.time) return bars;
  const bar = { ...live, volume: live.time === last.time ? Math.max(last.volume, volume) : volume };
  return live.time === last.time ? [...bars.slice(0, -1), bar] : [...bars, bar];
}

/** EMA по закрытиям — так же, как считает бот (pandas ewm, adjust=False). */
export function ema(closes: number[], period: number): (number | null)[] {
  const k = 2 / (period + 1);
  let e: number | null = null;
  return closes.map((c, i) => {
    e = e == null ? c : c * k + e * (1 - k);
    return i + 1 >= period ? e : null;
  });
}

// История одной пары и таймфрейма переживает уход с экрана: при возврате график появляется сразу.
const cache = new Map<string, { bars: Bar[]; done: boolean; at: number }>();
const FRESH_MS = 60_000;

export function useCandles(coin: string, interval: Interval) {
  const key = `${coin}:${interval}`;
  const hit = cache.get(key);
  const [bars, setBars] = useState<Bar[] | null>(hit?.bars ?? null);
  const [error, setError] = useState<string | null>(null);
  const loading = useRef(false);
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    const cached = cache.get(key);
    setBars(cached?.bars ?? null);
    setError(null);
    if (cached && Date.now() - cached.at < FRESH_MS) return;
    let alive = true;
    api.chart(coin, interval).then((d) => {
      if (!alive) return;
      const fresh = toBars(d);
      // свежая загрузка заменяет хвост, уже подгруженную старую историю сохраняем
      const merged = cached ? prependBars(cached.bars, fresh) : fresh;
      cache.set(key, { bars: merged, done: cached?.done ?? false, at: Date.now() });
      setBars(merged);
    }, (e: Error) => alive && !cached && setError(e.message));
    return () => { alive = false; };
  }, [coin, interval, key]);

  const loadMore = useCallback(async () => {
    const entry = cache.get(key);
    if (!entry || entry.done || loading.current || !entry.bars.length) return;
    loading.current = true;
    try {
      const d = await api.chart(coin, interval, entry.bars[0].time * 1000);
      const older = toBars(d);
      const now = cache.get(key) ?? entry;
      const merged = prependBars(older, now.bars);
      cache.set(key, { ...now, bars: merged, done: merged.length === now.bars.length });
      if (keyRef.current === key) setBars(merged);
    } catch {
      // не вышло — попробуем при следующей прокрутке
    } finally {
      loading.current = false;
    }
  }, [coin, interval, key]);

  return { bars, error, loadMore };
}
