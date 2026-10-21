// Тиковая линия, как «1с» у Bybit: линию двигает изменение цены, а не время. Каждая новая цена сделки —
// новая точка (шаг вперёд и наклон вверх или вниз); если цена 10 секунд не менялась — ровный шаг вперёд.
// Начало — последние сделки с сервера бота, дальше — поток сделок Bybit. Линия хранится, пока открыто
// приложение, поэтому при возврате на экран она продолжается, а не рисуется заново.
import { useContext, useEffect, useState } from "react";
import { api } from "../api";
import { LiveContext, num } from "../live";

export interface Point {
  time: number; // секунды, с долями — время сделки
  value: number;
}

const MAX_POINTS = 1500;
export const IDLE_STEP = 10; // секунд без изменения цены — ровный шаг вперёд
const FLUSH_MS = 250; // экрану хватает четырёх обновлений в секунду
const lines = new Map<string, Point[]>();

/** Добавить цену: точка только если цена изменилась (или same — ровный шаг). Время всегда растёт. */
export function addPrice(points: Point[], timeSec: number, value: number, same = false): Point[] {
  const last = points[points.length - 1];
  if (last && value === last.value && !same) return points;
  const time = last && timeSec <= last.time ? last.time + 0.001 : timeSec; // несколько сделок в одну миллисекунду
  const next = [...points, { time, value }];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

/** Точки изменений цены из списка сделок (время в мс). */
export function priceChanges(trades: { t: number; p: number }[]): Point[] {
  let out: Point[] = [];
  for (const tr of [...trades].sort((a, b) => a.t - b.t)) out = addPrice(out, tr.t / 1000, tr.p);
  return out;
}

export function useSecondLine(coin: string): Point[] {
  const feed = useContext(LiveContext);
  const [points, setPoints] = useState<Point[]>(() => lines.get(coin) ?? []);

  useEffect(() => {
    if (!coin) return; // линия выключена
    let alive = true, dirty = false;
    setPoints(lines.get(coin) ?? []);
    const put = (timeSec: number, value: number, same = false) => {
      const before = lines.get(coin) ?? [];
      const after = addPrice(before, timeSec, value, same);
      if (after !== before) { lines.set(coin, after); dirty = true; }
    };
    if (!lines.get(coin)?.length) {
      api.trades(coin).then((d) => {
        if (!alive) return;
        const seed = priceChanges(d.trades);
        const now = lines.get(coin) ?? [];
        const first = now[0]?.time ?? Infinity;
        lines.set(coin, [...seed.filter((s) => s.time < first), ...now]);
        dirty = true;
      }, () => { /* без истории линия начнётся с первой сделки */ });
    }
    const offs = feed ? [
      feed.subscribe(`publicTrade.${coin}USDT`, (d) => {
        const p = num(d.p), t = num(d.T);
        if (p > 0) put(Number.isFinite(t) && t > 0 ? t / 1000 : Date.now() / 1000, p);
      }),
      feed.subscribe(`tickers.${coin}USDT`, (d) => {
        const p = num(d.lastPrice);
        if (p > 0 && !lines.get(coin)?.length) put(Date.now() / 1000, p);
      }),
    ] : [];
    const timer = setInterval(() => {
      const last = lines.get(coin)?.at(-1);
      const now = Date.now() / 1000;
      if (last && now - last.time >= IDLE_STEP) put(now, last.value, true);
      if (dirty) { dirty = false; setPoints(lines.get(coin) ?? []); }
    }, FLUSH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
      offs.forEach((off) => off());
    };
  }, [coin, feed]);
  return points;
}
