// Отсчёт до закрытия текущей свечи под ценой на правой шкале — как «00:41» у Bybit.
import type { IChartApi, ISeriesApi, SeriesType } from "lightweight-charts";
import { useEffect, useState, type RefObject } from "react";

export const PERIOD_SEC: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800,
};
const WEEK_START = 4 * 86400; // недельные свечи Bybit начинаются в понедельник 00:00 UTC, а 01.01.1970 — четверг

const two = (n: number) => String(n).padStart(2, "0");

/** Сколько осталось до закрытия свечи: «00:41», «2:14:05», «3д 04:10». */
export function untilClose(nowSec: number, period: number): string {
  const shift = period === 604800 ? WEEK_START : 0;
  const left = Math.max(0, Math.ceil(period - ((nowSec - shift) % period)));
  const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
  if (d) return `${d}д ${two(h)}:${two(m)}`;
  if (h) return `${h}:${two(m)}:${two(s)}`;
  return `${two(m)}:${two(s)}`;
}

export function CloseCountdown({ chart, series, price, period }: {
  chart: RefObject<IChartApi | null>; series: RefObject<ISeriesApi<SeriesType> | null>;
  price: RefObject<number | null>; period: number | undefined;
}) {
  const [label, setLabel] = useState<{ top: number; width: number; text: string } | null>(null);
  useEffect(() => {
    if (!period) return;
    const tick = () => {
      const y = price.current != null ? series.current?.priceToCoordinate(price.current) : null;
      const width = chart.current?.priceScale("right").width() ?? 0;
      setLabel(y == null || !width ? null : { top: y + 11, width, text: untilClose(Date.now() / 1000, period) });
    };
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [period, chart, series, price]);
  if (!label) return null;
  return <span className="countdown num" style={{ top: label.top, width: label.width }} aria-label="До закрытия свечи">{label.text}</span>;
}
