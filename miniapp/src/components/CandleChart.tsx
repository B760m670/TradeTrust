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
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { chartPrice } from "../format";
import { useTheme, type Theme } from "../theme";
import type { Bar, Interval } from "./candles";
import { mainLines, subPane, type IndLine, type MainInd, type SubInd, type Tone } from "./indicators";
import { crosshairTime, tickMark } from "./chartTime";
import type { Point } from "./seconds";
import { CloseCountdown, PERIOD_SEC } from "./countdown";

// те же цвета, что в styles.css (--up, --down, --accent, --demo, --faint) для каждой темы; third — третья линия индикаторов
const PALETTE: Record<Theme, { up: string; down: string; fast: string; slow: string; third: string; text: string; grid: string }> = {
  dark: { up: "#20D49A", down: "#FF5470", fast: "#FF7A1F", slow: "#3B9EFF", third: "#F062C0", text: "rgba(236,239,244,0.45)", grid: "rgba(255,255,255,0.05)" },
  light: { up: "#0A9A6A", down: "#E33B55", fast: "#D9480F", slow: "#1F6FE5", third: "#D23C9F", text: "rgba(13,16,22,0.45)", grid: "rgba(13,16,22,0.06)" },
};
type Colors = (typeof PALETTE)[Theme];
const VISIBLE_BARS = 90;
const MORE_AT = 15; // осталось столько свечей до левого края — подгружаем более старую историю
export const SUB_HEIGHT = 72; // окно дополнительного индикатора, px

export function useChartColors() {
  const { theme } = useTheme();
  return PALETTE[theme];
}

export type ChartKind = "candles" | "line";

const ts = (t: number) => t as UTCTimestamp;
const toneColor = (c: Colors, t: Tone) => (t === "up" ? c.up : t === "down" ? c.down : [c.fast, c.slow, c.third][t]);

/** Значение индикатора в подписи и на шкале: объём — коротко (1.2K), остальное — 2 знака или 4 значащие цифры. */
export function indValue(v: number, digits?: number): string {
  if (digits === -1) {
    const a = Math.abs(v);
    return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(2)}K` : v.toFixed(a >= 100 ? 0 : 2);
  }
  if (digits != null) return v.toFixed(digits);
  return Math.abs(v) >= 1 ? v.toFixed(2) : Number(v.toPrecision(4)).toString();
}

type AnySeries = ISeriesApi<"Line"> | ISeriesApi<"Histogram">;

function addLine(chart: IChartApi, line: IndLine, colors: Colors, pane: number, digits?: number): AnySeries {
  const common = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    priceFormat: pane
      ? { type: "custom" as const, formatter: (v: number) => indValue(v, digits), minMove: 1e-8 }
      : { type: "custom" as const, formatter: (v: number) => chartPrice(v, v), minMove: 1e-8 } };
  if (line.style === "hist") return chart.addSeries(HistogramSeries, { ...common, base: 0 }, pane);
  return chart.addSeries(LineSeries, { ...common, color: toneColor(colors, line.tone), lineWidth: 1,
    ...(line.style === "dots" ? { lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 } : {}) }, pane);
}

function point(line: IndLine, bars: Bar[], i: number, colors: Colors) {
  const value = line.values[i];
  if (value == null) return null;
  const tone = line.tones?.[i];
  return { time: ts(bars[i].time), value, ...(tone != null ? { color: `${toneColor(colors, tone)}${line.label === "VOL" ? "88" : "cc"}` } : {}) };
}

function setLine(s: AnySeries, line: IndLine, bars: Bar[], colors: Colors) {
  s.setData(bars.flatMap((_, i) => point(line, bars, i, colors) ?? []));
}

/** Подписи индикаторов в углу окна, как у Bybit: под перекрестием — значения той свечи, иначе последней. */
function IndLegend({ title, lines, i, colors, digits, top }: {
  title?: string; lines: IndLine[]; i: number; colors: Colors; digits?: number; top: number;
}) {
  return (
    <div className="ind-legend num" style={{ top }}>
      {title && !lines.some((l) => l.label.startsWith(title)) && <span className="ind-title">{title}</span>}
      {lines.map((l) => {
        const v = l.values[i];
        const tone = l.tones?.[i] ?? l.tone;
        return <span key={l.label} style={{ color: toneColor(colors, tone) }}>{l.label}:{v == null ? "—" : digits === undefined && !title ? chartPrice(v, v) : indValue(v, digits)}</span>;
      })}
    </div>
  );
}

/** Свечной график, как на бирже: свечи или линия, индикаторы (основной поверх свечей и окна под графиком),
 *  вход и стоп бота, живая свеча, история назад. */
/** Уровень на графике: ваш ордер на бирже (тейк-профит, стоп, лимитный). */
export interface Level { price: number; title: string; tone: "up" | "down" | "text" }

export function CandleChart({ bars, interval, kind, main = null, subs = [], botEma = [20, 50], position, levels, onNeedMore }: {
  bars: Bar[]; interval: Interval; kind: ChartKind; main?: MainInd | null; subs?: SubInd[]; botEma?: [number, number];
  position: { entry: number; stop: number } | null; levels?: Level[]; onNeedMore?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const mainSeries = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area"> | null>(null);
  const overlay = useRef<{ key: string; series: AnySeries[] }>({ key: "", series: [] });
  const subSeries = useRef<AnySeries[][]>([]);
  const shown = useRef<Bar[]>([]); // что сейчас на графике — чтобы обновлать только последнюю свечу
  const price = useRef<number | null>(null);
  const refPrice = useRef<number | null>(bars[bars.length - 1]?.close ?? null);
  const needMore = useRef(onNeedMore);
  needMore.current = onNeedMore;
  const [hover, setHover] = useState<number | null>(null);
  const [tops, setTops] = useState<number[]>([]); // верх каждого окна графика, px — для подписей
  const { theme } = useTheme();
  const colors = PALETTE[theme];
  const subKey = subs.join(",");

  const lines = useMemo(() => (main ? mainLines(main, bars, botEma) : []), [main, bars, botEma[0], botEma[1]]);
  const panes = useMemo(() => subs.map((s) => subPane(s, bars)), [subKey, bars]);

  // график создаётся заново при смене вида, таймфрейма, темы или набора окон под графиком
  useEffect(() => {
    if (!box.current) return;
    const { up, down, fast, text, grid } = colors;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif", attributionLogo: false,
        panes: { separatorColor: grid, separatorHoverColor: grid, enableResize: false } },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      crosshair: { vertLine: { color: fast, labelBackgroundColor: fast }, horzLine: { color: fast, labelBackgroundColor: fast } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickMark, rightOffset: 4 },
      localization: { locale: "ru-RU", timeFormatter: crosshairTime(!["1d", "1w"].includes(interval)) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    // цены — в формате монеты; у окон индикаторов шкалы свои
    const priceFormat = { type: "custom" as const, formatter: (p: number) => chartPrice(p, refPrice.current ?? p), minMove: 1e-8 };
    mainSeries.current = kind === "candles"
      ? chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat })
      : chart.addSeries(AreaSeries, { lineColor: fast, topColor: `${fast}55`, bottomColor: `${fast}00`, lineWidth: 2, priceFormat });
    // окна под графиком: линии создаём по составу индикатора, данные придут ниже
    subSeries.current = subs.map((s, k) => {
      const pane = subPane(s, []);
      return pane.lines.map((l) => addLine(chart, l, colors, k + 1, pane.digits));
    });
    // высоты окон — долями: основное получает всё, кроме SUB_HEIGHT на каждое окно индикатора;
    // сверху в окне — место под подпись, как у Bybit
    const height = box.current.clientHeight;
    chart.panes().forEach((p, k) => {
      p.setStretchFactor(k ? 1 : Math.max(1, (height - subs.length * SUB_HEIGHT) / SUB_HEIGHT));
      if (k) p.priceScale("right").applyOptions({ scaleMargins: { top: 0.3, bottom: 0.06 } });
    });
    chartRef.current = chart;
    shown.current = [];
    overlay.current = { key: "", series: [] };
    chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < MORE_AT) needMore.current?.();
    });
    chart.subscribeCrosshairMove((p) => setHover(p.logical == null || !p.point ? null : Math.round(p.logical)));
    // где начинается каждое окно — для подписей индикаторов; размеры меняются вместе с окном приложения
    const measure = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      setTops(chart.panes().map((p) => (p.getHTMLElement()?.getBoundingClientRect().top ?? top) - top));
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(measure));
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      mainSeries.current = null;
      subSeries.current = [];
      overlay.current = { key: "", series: [] };
      shown.current = [];
      setHover(null);
    };
  }, [interval, kind, theme, subKey]);

  // данные: живая свеча — точечное обновление, подгруженная история — с сохранением того, что видно
  useEffect(() => {
    const chart = chartRef.current, s = mainSeries.current;
    if (!chart || !s || !bars.length) return;
    const prev = shown.current;
    const candle = (b: Bar) => (kind === "candles"
      ? { time: ts(b.time), open: b.open, high: b.high, low: b.low, close: b.close }
      : { time: ts(b.time), value: b.close });
    const sameStart = prev.length > 0 && prev[0].time === bars[0].time;
    const tail = sameStart && bars.length - prev.length <= 1 && bars.length >= prev.length;
    const last = bars.length - 1;
    const update = (series: AnySeries, line: IndLine) => {
      const p = point(line, bars, last, colors);
      if (p) series.update(p);
    };
    if (tail) {
      (s as ISeriesApi<SeriesType>).update(candle(bars[last]) as never);
      panes.forEach((pane, k) => pane.lines.forEach((l, j) => subSeries.current[k]?.[j] && update(subSeries.current[k][j], l)));
    } else {
      const range = chart.timeScale().getVisibleLogicalRange();
      const added = prev.length ? bars.findIndex((b) => b.time === prev[0].time) : -1;
      (s as ISeriesApi<SeriesType>).setData(bars.map(candle) as never);
      panes.forEach((pane, k) => pane.lines.forEach((l, j) => subSeries.current[k]?.[j] && setLine(subSeries.current[k][j], l, bars, colors)));
      if (range && added > 0) chart.timeScale().setVisibleLogicalRange({ from: range.from + added, to: range.to + added });
      else if (!prev.length) chart.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE_BARS, to: bars.length + 4 });
    }
    // основной индикатор поверх свечей: при смене — новые линии, на живой свече двигаем только последнюю точку
    const key = `${main}:${botEma.join(",")}`;
    if (overlay.current.key !== key) {
      overlay.current.series.forEach((l) => chart.removeSeries(l));
      overlay.current = { key, series: lines.map((l) => addLine(chart, l, colors, 0)) };
      lines.forEach((l, j) => setLine(overlay.current.series[j], l, bars, colors));
    } else if (tail) {
      lines.forEach((l, j) => update(overlay.current.series[j], l));
    } else {
      lines.forEach((l, j) => setLine(overlay.current.series[j], l, bars, colors));
    }
    shown.current = bars;
    price.current = bars[last].close;
  }, [bars, lines, panes, kind, colors]);

  // вход и стоп бота
  useEffect(() => {
    const s = mainSeries.current;
    if (!s || !position) return;
    const stop = s.createPriceLine({ price: position.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: "стоп" });
    const entry = s.createPriceLine({ price: position.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: true, title: "вход бота" });
    return () => {
      if (mainSeries.current !== s) return; // график уже пересоздан вместе с линиями
      s.removePriceLine(stop);
      s.removePriceLine(entry);
    };
  }, [position?.entry, position?.stop, interval, kind, theme, subKey]); // subKey: график пересоздаётся вместе с окнами индикаторов

  // ваши ордера на бирже — пунктиром, с подписью на шкале, как у Bybit
  const levelKey = (levels ?? []).map((l) => `${l.price}:${l.title}:${l.tone}`).join("|");
  useEffect(() => {
    const s = mainSeries.current;
    if (!s || !levels?.length) return;
    const lines = levels.map((l) => s.createPriceLine({ price: l.price, color: l.tone === "text" ? colors.text : colors[l.tone],
      lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: true, title: l.title }));
    return () => {
      if (mainSeries.current !== s) return;
      lines.forEach((line) => s.removePriceLine(line));
    };
  }, [levelKey, interval, kind, theme, subKey]);

  const zoom = (factor: number) => {
    const t = chartRef.current?.timeScale();
    const r = t?.getVisibleLogicalRange();
    if (!t || !r) return;
    const width = Math.max(12, (r.to - r.from) * factor);
    t.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };
  const reset = () => chartRef.current?.timeScale().setVisibleLogicalRange({ from: bars.length - VISIBLE_BARS, to: bars.length + 4 });
  const at = hover != null && hover >= 0 && hover < bars.length ? hover : bars.length - 1;

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="chart" />
      {lines.length > 0 && <IndLegend lines={lines} i={at} colors={colors} top={4} />}
      {panes.map((p, k) => tops[k + 1] != null && (
        <IndLegend key={subs[k]} title={p.title} lines={p.lines} i={at} colors={colors} digits={p.digits} top={tops[k + 1] + 2} />
      ))}
      <ZoomControls onZoom={zoom} onReset={reset} top={subs.length && tops[1] ? tops[1] - 38 : undefined} />
      <CloseCountdown chart={chartRef} series={mainSeries as RefObject<ISeriesApi<SeriesType> | null>} price={price} period={PERIOD_SEC[interval]} />
    </div>
  );
}

export function ZoomControls({ onZoom, onReset, top }: { onZoom: (factor: number) => void; onReset: () => void; top?: number }) {
  return (
    <div className="zoom" role="group" aria-label="Масштаб" style={top != null ? { top, bottom: "auto" } : undefined}>
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
