import {
  AreaSeries, ColorType, LastPriceAnimationMode, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { api } from "../api";
import { chartPrice } from "../format";
import { useTheme } from "../theme";
import { ZoomControls, useChartColors } from "./CandleChart";

const KEEP_SECONDS = 15 * 60;
const SEED_MINUTES = 30;
const VISIBLE_SECONDS = 180;

type Point = { time: UTCTimestamp; value: number };

/** «1с»: цена каждую секунду из живого потока. У биржи нет истории по секундам, поэтому
 *  до открытия график показывает последние 30 минут по минутным свечам, дальше — по секундам. */
export function TickChart({ coin, value, levels }: {
  coin: string; value: number | undefined; levels: { stop: number; entry: number } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Area"> | null>(null);
  const points = useRef<Point[]>([]);
  const latest = useRef(value);
  latest.current = value;
  const { theme } = useTheme();
  const colors = useChartColors();

  const showRecent = () => {
    const n = points.current.length;
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_SECONDS), to: n + 5 });
  };

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.2, bottom: 0.2 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 5 },
      crosshair: { vertLine: { color: colors.fast, labelBackgroundColor: colors.fast },
        horzLine: { color: colors.fast, labelBackgroundColor: colors.fast } },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p) },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: colors.fast, lineWidth: 2, priceLineColor: colors.fast,
      topColor: theme === "dark" ? "rgba(139,124,255,0.3)" : "rgba(108,92,240,0.18)", bottomColor: "rgba(139,124,255,0)",
      lastPriceAnimation: LastPriceAnimationMode.Continuous, // пульсирующая точка текущей цены
    });
    area.setData(points.current);
    if (levels) {
      area.createPriceLine({ price: levels.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "стоп" });
      area.createPriceLine({ price: levels.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, title: "вход" });
    }
    chartRef.current = chart;
    series.current = area;
    showRecent();
    return () => {
      chartRef.current = null;
      series.current = null;
      chart.remove();
    };
  }, [theme, colors, levels?.stop, levels?.entry]);

  // последние минуты по минутным свечам, чтобы график не начинался с пустоты
  useEffect(() => {
    let alive = true;
    points.current = [];
    api.chart(coin, "1m").then((d) => {
      if (!alive) return;
      const seed: Point[] = [];
      d.time.slice(-SEED_MINUTES).forEach((t, i, arr) => {
        const close = d.close[d.close.length - arr.length + i];
        if (close != null) seed.push({ time: (t + 59) as UTCTimestamp, value: close });
      });
      const first = points.current[0]?.time ?? Infinity;
      points.current = [...seed.filter((p) => p.time < first), ...points.current];
      series.current?.setData(points.current);
      showRecent();
    }, () => {});
    return () => { alive = false; };
  }, [coin]);

  // точка каждую секунду — линия идёт дальше, даже когда цена стоит на месте
  useEffect(() => {
    const timer = setInterval(() => {
      const v = latest.current;
      if (v == null || !series.current) return;
      const time = Math.floor(Date.now() / 1000) as UTCTimestamp;
      const last = points.current[points.current.length - 1];
      if (last && time <= last.time) return;
      const point = { time, value: v };
      points.current = [...points.current.filter((p) => p.time > time - KEEP_SECONDS - SEED_MINUTES * 60), point];
      series.current.update(point);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
      <ZoomControls onZoom={zoom} onReset={showRecent} />
    </div>
  );
}
