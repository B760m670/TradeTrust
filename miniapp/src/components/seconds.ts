// Секундная линия, как «1с» у Bybit: точка каждую секунду по последней сделке на рынке.
// Начало — последние сделки с сервера бота, дальше — поток сделок Bybit. Линия хранится,
// пока открыто приложение, поэтому при возврате на экран она продолжается, а не рисуется заново.
import { useContext, useEffect, useState } from "react";
import { api } from "../api";
import { LiveContext, num } from "../live";

export interface Point {
  time: number; // секунды
  value: number;
}

const MAX_POINTS = 1800; // полчаса
const lines = new Map<string, Point[]>();

/** Последняя цена каждой секунды из списка сделок (время в мс), по возрастанию. */
export function perSecond(trades: { t: number; p: number }[]): Point[] {
  const bySec = new Map<number, number>();
  for (const tr of [...trades].sort((a, b) => a.t - b.t)) bySec.set(Math.floor(tr.t / 1000), tr.p);
  return [...bySec].map(([time, value]) => ({ time, value }));
}

/** Добавить точку секунды: новая секунда — новая точка, та же — заменить. Старее последней — не трогаем. */
export function addPoint(points: Point[], p: Point): Point[] {
  const last = points[points.length - 1];
  if (last && p.time < last.time) return points;
  const next = last && last.time === p.time ? [...points.slice(0, -1), p] : [...points, p];
  return next.length > MAX_POINTS ? next.slice(next.length - MAX_POINTS) : next;
}

export function useSecondLine(coin: string): Point[] {
  const feed = useContext(LiveContext);
  const [points, setPoints] = useState<Point[]>(() => lines.get(coin) ?? []);

  useEffect(() => {
    if (!coin) return; // секундная линия выключена
    let alive = true;
    setPoints(lines.get(coin) ?? []);
    let price: number | null = lines.get(coin)?.at(-1)?.value ?? null;
    if (!lines.get(coin)?.length) {
      api.trades(coin).then((d) => {
        if (!alive) return;
        const seed = perSecond(d.trades);
        const now = lines.get(coin) ?? [];
        const first = now[0]?.time ?? Infinity;
        lines.set(coin, [...seed.filter((s) => s.time < first), ...now]);
        price ??= seed.at(-1)?.value ?? null;
        setPoints(lines.get(coin)!);
      }, () => { /* без истории линия начнётся с текущей секунды */ });
    }
    const offs = feed ? [
      feed.subscribe(`publicTrade.${coin}USDT`, (d) => { const p = num(d.p); if (p > 0) price = p; }),
      feed.subscribe(`tickers.${coin}USDT`, (d) => { const p = num(d.lastPrice); if (p > 0 && price == null) price = p; }),
    ] : [];
    const timer = setInterval(() => {
      if (price == null) return;
      const next = addPoint(lines.get(coin) ?? [], { time: Math.floor(Date.now() / 1000), value: price });
      lines.set(coin, next);
      setPoints(next);
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
      offs.forEach((off) => off());
    };
  }, [coin, feed]);
  return points;
}
