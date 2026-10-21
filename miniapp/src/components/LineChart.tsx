import {
  AreaSeries, ColorType, LastPriceAnimationMode, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type SeriesType, type UTCTimestamp,
} from "lightweight-charts";
import { useContext, useEffect, useRef, useState } from "react";
import type { ChartData } from "../api";
import { chartPrice } from "../format";
import { LiveContext, useLiveTickers } from "../live";
import { feedState } from "../logic";
import { useTheme } from "../theme";
import { ZoomControls, useChartColors } from "./CandleChart";
import { crosshairTime, tickMark } from "./chartTime";
import { CloseCountdown } from "./countdown";

const SPACING = 9;     // ширина минуты на экране, px: ~40 минут на телефоне, как «Срок» у Bybit
const REDRAW_MS = 250; // последняя точка двигается с каждой сделкой, но перерисовка — 4 раза в секунду

const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);

/** «Линия» как режим «Срок» на биржах: цена закрытия каждой минуты, последняя точка — живая цена
 *  по каждой сделке Bybit, справа отсчёт до конца минуты. */
export function LineChart({ data, coin, levels }: {
  data: ChartData; coin: string; levels: { stop: number; entry: number } | null;
}) {
  const feed = useContext(LiveContext);
  const tickers = useLiveTickers();
  const ticker = useRef(tickers[coin]);
  ticker.current = tickers[coin];
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<SeriesType> | null>(null);
  const price = useRef<number | null>(null);
  const live = useRef<{ t: number; p: number } | null>(null); // последняя сделка: время (мс) и цена
  const drawn = useRef(0);
  const delays = useRef<number[]>([]);
  const lastTradeAt = useRef<number | null>(null);
  const [state, setState] = useState(() => feedState([], null, Date.now()));
  const { theme } = useTheme();
  const colors = useChartColors();
  const lastClosed = data.time[data.time.length - 1] ?? 0;

  const reset = () => {
    const ts = chartRef.current?.timeScale();
    ts?.applyOptions({ barSpacing: SPACING });
    ts?.scrollToRealTime();
  };

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif" },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.15, bottom: 0.12 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, barSpacing: SPACING,
        shiftVisibleRangeOnNewBar: true, tickMarkFormatter: tickMark },
      crosshair: { vertLine: { color: colors.fast, labelBackgroundColor: colors.fast },
        horzLine: { color: colors.fast, labelBackgroundColor: colors.fast } },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p), timeFormatter: crosshairTime(true) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const area = chart.addSeries(AreaSeries, {
      lineColor: colors.fast, lineWidth: 2, priceLineColor: colors.fast, priceLineStyle: LineStyle.Dashed,
      topColor: theme === "dark" ? "rgba(139,124,255,0.28)" : "rgba(108,92,240,0.16)", bottomColor: "rgba(139,124,255,0)",
      lastPriceAnimation: LastPriceAnimationMode.Continuous, // пульсирующая точка живой цены
      crosshairMarkerRadius: 4,
    });
    const points = data.time.flatMap((t, i) => {
      const c = data.close[i];
      return c == null ? [] : [{ time: t as UTCTimestamp, value: c }];
    });
    area.setData(points);
    drawn.current = lastClosed;
    price.current = points[points.length - 1]?.value ?? null;
    if (levels) {
      area.createPriceLine({ price: levels.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "стоп" });
      area.createPriceLine({ price: levels.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, title: "вход" });
    }
    chartRef.current = chart;
    series.current = area;
    reset();
    const raf = requestAnimationFrame(reset); // ширина графика известна только после первой отрисовки
    return () => {
      cancelAnimationFrame(raf);
      chartRef.current = null;
      series.current = null;
      chart.remove();
    };
  }, [data, theme, colors, levels?.stop, levels?.entry]);

  // живая цена — по каждой сделке Bybit
  useEffect(() => {
    if (!feed) return;
    delays.current = [];
    lastTradeAt.current = null;
    return feed.subscribe(`publicTrade.${coin}USDT`, (d) => {
      const t = num(d.T), p = num(d.p);
      if (!Number.isFinite(t) || !Number.isFinite(p) || p <= 0) return;
      const now = Date.now();
      delays.current = [...delays.current.slice(-29), now - t];
      lastTradeAt.current = now;
      if (!live.current || t >= live.current.t) live.current = { t, p };
    });
  }, [feed, coin]);

  useEffect(() => {
    const draw = setInterval(() => {
      // сделок давно не было (тихая монета) — двигаем точку по цене из тикера
      const quiet = !lastTradeAt.current || Date.now() - lastTradeAt.current > 5000;
      const src = quiet && ticker.current ? { t: Date.now(), p: ticker.current.price } : live.current;
      if (!src || !series.current) return;
      const minute = Math.floor(src.t / 60000) * 60;
      if (minute < drawn.current) return; // сделка из уже закрытой минуты
      series.current.update({ time: minute as UTCTimestamp, value: src.p });
      drawn.current = minute;
      price.current = src.p;
    }, REDRAW_MS);
    const status = setInterval(() => setState(feedState(delays.current, lastTradeAt.current, Date.now())), 1000);
    return () => {
      clearInterval(draw);
      clearInterval(status);
    };
  }, []);

  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale();
    if (ts) ts.applyOptions({ barSpacing: Math.min(40, Math.max(1.5, ts.options().barSpacing / factor)) });
  };

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="line-chart" />
      <ZoomControls onZoom={zoom} onReset={reset} />
      <span className={`feed-state ${state.kind}`} title="Время от сделки на бирже до вашего телефона">
        <i aria-hidden="true" />{state.text}
      </span>
      <CloseCountdown chart={chartRef} series={series} price={price} period={60} />
    </div>
  );
}
