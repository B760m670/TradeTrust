import { AreaSeries, ColorType, createChart, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { usd } from "../format";
import { useTheme } from "../theme";
import { useChartColors } from "./CandleChart";

/** Капитал во времени: точка после каждой 4ч свечи, последняя — текущий капитал. */
export function EquityChart({ points }: { points: [number, number][] }) {
  const box = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const colors = useChartColors();

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => usd(p) },
      handleScale: false,
      handleScroll: false,
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: colors.fast, lineWidth: 2,
      topColor: theme === "dark" ? "rgba(139,124,255,0.35)" : "rgba(108,92,240,0.22)",
      bottomColor: "rgba(139,124,255,0)",
      priceLineVisible: false,
    });
    // у графика время должно строго расти
    const seen = new Set<number>();
    area.setData(points.filter(([t]) => !seen.has(t) && seen.add(t)).map(([t, v]) => ({ time: t as UTCTimestamp, value: v })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [points, theme, colors]);

  return <div ref={box} className="chart" data-testid="equity-chart" />;
}
