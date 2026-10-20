import { AreaSeries, ColorType, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { price } from "../format";
import { useTheme } from "../theme";
import { ZoomControls, useChartColors } from "./CandleChart";

const KEEP_SECONDS = 15 * 60;

/** «1с»: цена по секундам из живого потока, с момента открытия графика (у биржи нет истории по секундам). */
export function TickChart({ value, levels }: { value: number | undefined; levels: { stop: number; entry: number } | null }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  const points = useRef<{ time: UTCTimestamp; value: number }[]>([]);
  const { theme } = useTheme();
  const colors = useChartColors();

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 4 },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => price(p) },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: colors.fast, lineWidth: 2, topColor: theme === "dark" ? "rgba(139,124,255,0.3)" : "rgba(108,92,240,0.18)",
      bottomColor: "rgba(139,124,255,0)", priceLineColor: colors.fast,
    });
    area.setData(points.current);
    if (levels) {
      area.createPriceLine({ price: levels.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "стоп" });
      area.createPriceLine({ price: levels.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, title: "вход" });
    }
    chartRef.current = chart;
    series.current = area;
    return () => {
      chartRef.current = null;
      series.current = null;
      chart.remove();
    };
  }, [theme, colors, levels?.stop, levels?.entry]);

  useEffect(() => {
    if (value == null || !series.current) return;
    const time = Math.floor(Date.now() / 1000) as UTCTimestamp;
    const last = points.current[points.current.length - 1];
    if (last && time <= last.time) return;
    const point = { time, value };
    points.current = [...points.current.filter((p) => p.time > time - KEEP_SECONDS), point];
    series.current.update(point);
  }, [value]);

  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const width = Math.max(10, (r.to - r.from) * factor);
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="tick-chart" />
      {points.current.length < 2 && <span className="tick-hint">Цена по секундам — с момента открытия графика</span>}
      <ZoomControls onZoom={zoom} onReset={() => chartRef.current?.timeScale().fitContent()} />
    </div>
  );
}
