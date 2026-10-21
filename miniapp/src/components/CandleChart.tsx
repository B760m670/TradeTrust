import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, type RefObject } from "react";
import { chartPrice } from "../format";
import { useTheme, type Theme } from "../theme";
import { ema, type Bar, type Interval } from "./candles";
import { crosshairTime, tickMark } from "./chartTime";
import type { Point } from "./seconds";
import { CloseCountdown, PERIOD_SEC } from "./countdown";

// те же цвета, что в styles.css (--up, --down, --accent, --demo, --faint) для каждой темы
const PALETTE: Record<Theme, { up: string; down: string; fast: string; slow: string; text: string; grid: string }> = {
  dark: { up: "#20D49A", down: "#FF5470", fast: "#8B7CFF", slow: "#3B9EFF", text: "rgba(236,239,244,0.45)", grid: "rgba(255,255,255,0.05)" },
  light: { up: "#0A9A6A", down: "#E33B55", fast: "#6C5CF0", slow: "#1F6FE5", text: "rgba(13,16,22,0.45)", grid: "rgba(13,16,22,0.06)" },
};
const VISIBLE_BARS = 90;
const MORE_AT = 15; // осталось столько свечей до левого края — подгружаем более старую историю

export function useChartColors() {
  const { theme } = useTheme();
  return PALETTE[theme];
}

export type ChartKind = "candles" | "line";

const ts = (t: number) => t as UTCTimestamp;

/** Свечной график, как на бирже: свечи или линия, объём, EMA, вход и стоп бота, живая свеча, история назад. */
export function CandleChart({ bars, interval, kind, emas, position, onNeedMore }: {
  bars: Bar[]; interval: Interval; kind: ChartKind; emas: [number, number] | null;
  position: { entry: number; stop: number } | null; onNeedMore?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const main = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const vol = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lines = useRef<ISeriesApi<"Line">[]>([]);
  const shown = useRef<Bar[]>([]); // что сейчас на графике — чтобы обновлять только последнюю свечу
  const price = useRef<number | null>(null);
  const refPrice = useRef<number | null>(bars[bars.length - 1]?.close ?? null);
  const needMore = useRef(onNeedMore);
  needMore.current = onNeedMore;
  const { theme } = useTheme();
  const colors = PALETTE[theme];

  // график создаётся заново только при смене вида, таймфрейма или темы
  useEffect(() => {
    if (!box.current) return;
    const { up, down, fast, text, grid } = colors;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif", attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      crosshair: { vertLine: { color: fast, labelBackgroundColor: fast }, horzLine: { color: fast, labelBackgroundColor: fast } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickMark, rightOffset: 4 },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p, refPrice.current ?? p),
        timeFormatter: crosshairTime(!["1d", "1w"].includes(interval)) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    main.current = kind === "candles"
      ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false })
      : chart.addSeries(AreaSeries, { lineColor: fast, topColor: `${fast}55`, bottomColor: `${fast}00`, lineWidth: 2 });
    vol.current = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chartRef.current = chart;
    shown.current = [];
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < MORE_AT) needMore.current?.();
    });
    return () => {
      chart.remove();
      chartRef.current = null;
      main.current = null;
      vol.current = null;
      lines.current = [];
      shown.current = [];
    };
  }, [interval, kind, theme]);

  // данные: живая свеча — точечное обновление, подгруженная история — с сохранением того, что видно
  useEffect(() => {
    const chart = chartRef.current, s = main.current, v = vol.current;
    if (!chart || !s || !v || !bars.length) return;
    const prev = shown.current;
    const point = (b: Bar) => (kind === "candles"
      ? { time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close }
      : { time: ts(b.time), value: b.close });
    const volPoint = (b: Bar) => ({ time: ts(b.time), value: b.volume, color: b.close >= b.open ? `${colors.up}55` : `${colors.down}55` });
    const sameStart = prev.length > 0 && prev[0].time === bars[0].time;
    const tail = sameStart && bars.length - prev.length <= 1 && bars.length >= prev.length;
    if (tail) {
      const b = bars[bars.length - 1];
      (s as ISeriesApi<SeriesType>).update(point(b) as never);
      v.update(volPoint(b));
    } else {
      const range = chart.timeScale().getVisibleLogicalRange();
      const added = prev.length ? bars.findIndex((b) => b.time === prev[0].time) : -1;
      (s as ISeriesApi<SeriesType>).setData(bars.map(point) as never);
      v.setData(bars.map(volPoint));
      if (range && added > 0) chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      else if (!prev.length) chart.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE_BARS, to: bars.length + 4 });
    }
    // EMA считаем по всей истории — так же, как бот; на живой свече двигаем только последнюю точку
    const closes = bars.map((b) => b.close);
    const last = bars[bars.length - 1];
    if (tail && emas && lines.current.length === emas.length) {
      emas.forEach((period, i) => {
        const value = ema(closes, period)[closes.length - 1];
        if (value != null) lines.current[i].update({ time: ts(last.time), value });
      });
    } else {
      lines.current.forEach((l) => chart.removeSeries(l));
      lines.current = [];
    }
    if (emas && !lines.current.length) {
      emas.forEach((period, i) => {
        const l = chart.addSeries(LineSeries, { color: i ? colors.slow : colors.fast, lineWidth: 2, priceLineVisible: false,
          lastValueVisible: false, crosshairMarkerVisible: false });
        const values = ema(closes, period);
        l.setData(bars.flatMap((b, j) => (values[j] == null ? [] : [{ time: ts(b.time), value: values[j]! }])));
        lines.current.push(l);
      });
    }
    shown.current = bars;
    price.current = bars[bars.length - 1].close;
  }, [bars, emas?.[0], emas?.[1], kind, colors]);

  // вход и стоп бота
  useEffect(() => {
    const s = main.current;
    if (!s || !position) return;
    const stop = s.createPriceLine({ price: position.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "стоп" });
    const entry = s.createPriceLine({ price: position.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: "вход бота" });
    return () => {
      if (main.current !== s) return; // график уже пересоздан вместе с линиями
      s.removePriceLine(stop);
      s.removePriceLine(entry);
    };
  }, [position?.entry, position?.stop, interval, kind, theme]);

  const zoom = (factor: number) => {
    const t = chartRef.current?.timeScale();
    const r = t?.getVisibleLogicalRange();
    if (!t || !r) return;
    const width = Math.max(12, (r.to - r.from) * factor);
    t.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };
  const reset = () => chartRef.current?.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE_BARS, to: bars.length + 4 });

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="chart" />
      <ZoomControls onZoom={zoom} onReset={reset} />
      <CloseCountdown chart={chartRef} series={main as RefObject<ISeriesApi<SeriesType> | null>} price={price} period={PERIOD_SEC[interval]} />
    </div>
  );
}

export function ZoomControls({ onZoom, onReset }: { onZoom: (factor: number) => void; onReset: () => void }) {
  return (
    <div className="zoom" role="group" aria-label="Масштаб">
      <button aria-label="Отдалить" onClick={() => onZoom(1.6)}>−</button>
      <button aria-label="Приблизить" onClick={() => onZoom(1 / 1.6)}>+</button>
      <button aria-label="Сбросить масштаб" onClick={onReset}>⟲</button>
    </div>
  );
}

/** «1с»: зелёная линия по последней сделке каждой секунды, как у Bybit; цена всегда в середине по высоте. */
export function SecondChart({ points }: { points: Point[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const area = useRef<ISeriesApi<"Area"> | null>(null);
  const shown = useRef<Point[]>([]);
  const { theme } = useTheme();
  const colors = PALETTE[theme];
  const refPrice = useRef<number | null>(points[points.length - 1]?.value ?? null);

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif", attributionLogo: false },
      grid: { vertLines: { color: colors.grid }, horzLines: { color: colors.grid } },
      crosshair: { vertLine: { color: colors.up, labelBackgroundColor: colors.up }, horzLine: { color: colors.up, labelBackgroundColor: colors.up } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.3, bottom: 0.3 } },
      // шаг линии — одинаковый на каждое изменение цены, как у Bybit
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, tickMarkFormatter: tickMark, rightOffset: 8, barSpacing: 9 },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p, refPrice.current ?? p), timeFormatter: crosshairTime(true, true) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    area.current = chart.addSeries(AreaSeries, { lineColor: colors.up, topColor: `${colors.up}40`, bottomColor: `${colors.up}00`,
      lineWidth: 2, priceLineColor: colors.up, priceLineStyle: LineStyle.Dashed });
    chartRef.current = chart;
    shown.current = [];
    return () => {
      chart.remove();
      chartRef.current = null;
      area.current = null;
    };
  }, [theme]);

  useEffect(() => {
    const s = area.current, chart = chartRef.current;
    if (!s || !chart || !points.length) return;
    const prev = shown.current;
    const last = points[points.length - 1];
    if (prev.length && prev[0].time === points[0].time && points.length >= prev.length) {
      // новые цены — по одной, как приходили: линия делает шаг на каждую
      for (const p of points.slice(Math.max(prev.length - 1, 0))) s.update({ time: ts(p.time), value: p.value });
    } else {
      s.setData(points.map((p) => ({ time: ts(p.time), value: p.value })));
      if (!prev.length) chart.timeScale().scrollToRealTime();
    }
    shown.current = points;
    refPrice.current = last.value;
  }, [points]);

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="chart-1s" />
    </div>
  );
}
