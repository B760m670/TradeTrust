import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { ChartData } from "../api";
import { price } from "../format";

const UP = "#1fa971";
const DOWN = "#e5484d";
const FAST = "#3b82f6";
const SLOW = "#e2a336";
const VISIBLE_BARS = 90;

function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/** Свечной график TradingView Lightweight Charts: свечи 4ч, EMA, стоп и цена входа. */
export function CandleChart({ data }: { data: ChartData }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current) return;
    const text = themeColor("--tg-theme-hint-color", "#8b929c");
    const chart: IChartApi = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: "-apple-system, BlinkMacSystemFont, Roboto, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "rgba(128,128,128,0.12)" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => price(p) },
      handleScale: { axisPressedMouseMove: false },
    });

    const levels = data.position ? [data.position.stop, data.position.entry] : [];
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false,
      // шкала цены по умолчанию не видит линии стопа и входа — расширяем её, чтобы стоп всегда был на графике
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const info = original();
        if (!info?.priceRange || !levels.length) return info;
        return {
          ...info,
          priceRange: {
            minValue: Math.min(info.priceRange.minValue, ...levels),
            maxValue: Math.max(info.priceRange.maxValue, ...levels),
          },
        };
      },
    });
    candles.setData(
      data.time.flatMap((t, i) => {
        const [o, h, l, c] = [data.open[i], data.high[i], data.low[i], data.close[i]];
        return o == null || h == null || l == null || c == null
          ? [] : [{ time: t as UTCTimestamp, open: o, high: h, low: l, close: c }];
      }),
    );

    const line = (values: (number | null)[], color: string) => {
      const s = chart.addSeries(LineSeries, {
        color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
      s.setData(data.time.flatMap((t, i) => {
        const v = values[i];
        return v == null ? [] : [{ time: t as UTCTimestamp, value: v }];
      }));
    };
    line(data.ema_fast, FAST);
    line(data.ema_slow, SLOW);

    if (data.position) {
      candles.createPriceLine({ price: data.position.stop, color: DOWN, lineStyle: LineStyle.Dashed, lineWidth: 1,
        axisLabelVisible: true, title: "стоп" });
      candles.createPriceLine({ price: data.position.entry, color: text, lineStyle: LineStyle.Dotted, lineWidth: 1,
        axisLabelVisible: true, title: "вход" });
    }

    const n = data.time.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_BARS), to: n + 2 });
    return () => chart.remove();
  }, [data]);

  return <div ref={box} className="chart" data-testid="chart" />;
}

export const CHART_COLORS = { FAST, SLOW, DOWN };
