import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type AutoscaleInfo,
  type IChartApi,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, type RefObject } from "react";
import type { ChartData } from "../api";
import type { LiveCandle } from "../live";
import { chartPrice } from "../format";
import { crosshairTime, tickMark } from "./chartTime";
import { CloseCountdown, PERIOD_SEC } from "./countdown";
import { useTheme, type Theme } from "../theme";

// те же цвета, что в styles.css (--up, --down, --accent, --faint) для каждой темы
const PALETTE: Record<Theme, { up: string; down: string; fast: string; slow: string; text: string; grid: string }> = {
  dark: { up: "#4FE3B0", down: "#FF7A8A", fast: "#8B7CFF", slow: "#F5B86B", text: "rgba(244,245,248,0.45)", grid: "rgba(255,255,255,0.05)" },
  light: { up: "#0C9A6A", down: "#E0444F", fast: "#6C5CF0", slow: "#E0912B", text: "rgba(17,18,28,0.45)", grid: "rgba(17,18,28,0.06)" },
};
const VISIBLE_BARS = 90;

const chartColors = (theme: Theme) => PALETTE[theme];

export function useChartColors() {
  const { theme } = useTheme();
  return chartColors(theme);
}

/** Свечной график TradingView Lightweight Charts: свечи 4ч, EMA, стоп и цена входа. */
export function CandleChart({ data, bars = VISIBLE_BARS, live }: { data: ChartData; bars?: number; live?: LiveCandle | null }) {
  const box = useRef<HTMLDivElement>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  const price = useRef<number | null>(null); // последняя цена — для отсчёта до закрытия свечи
  const lastClosed = data.time[data.time.length - 1] ?? 0;

  // формирующаяся свеча: обновляется каждую секунду, закрытые свечи не трогает
  const applyLive = (c: LiveCandle | null | undefined) => {
    if (!c || !series.current || c.time <= lastClosed) return;
    series.current.update({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close });
    price.current = c.close;
  };
  useEffect(() => applyLive(live), [live]);
  const { theme } = useTheme();

  useEffect(() => {
    if (!box.current) return;
    const { up: UP, down: DOWN, fast: FAST, slow, text, grid } = chartColors(theme);
    const chart: IChartApi = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif",
      },
      grid: { vertLines: { visible: false }, horzLines: { color: grid } },
      crosshair: {
        vertLine: { color: FAST, labelBackgroundColor: FAST },
        horzLine: { color: FAST, labelBackgroundColor: FAST },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, tickMarkFormatter: tickMark },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p),
        timeFormatter: crosshairTime(!["1d", "1w"].includes(data.interval)) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
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
    line(data.ema_slow, slow);

    if (data.position) {
      candles.createPriceLine({ price: data.position.stop, color: DOWN, lineStyle: LineStyle.Dashed, lineWidth: 1,
        axisLabelVisible: true, title: "стоп" });
      candles.createPriceLine({ price: data.position.entry, color: text, lineStyle: LineStyle.Dotted, lineWidth: 1,
        axisLabelVisible: true, title: "вход" });
    }

    const n = data.time.length;
    price.current = data.close[n - 1] ?? null;
    series.current = candles;
    chartRef.current = chart;
    applyLive(liveRef.current);
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 2 });
    return () => {
      series.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, [data, bars, theme]);

  // приближение кнопками (на телефоне — ещё и двумя пальцами, на ПК — колесом)
  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale();
    const r = ts?.getVisibleLogicalRange();
    if (!ts || !r) return;
    const width = Math.min(data.time.length + 20, Math.max(12, (r.to - r.from) * factor));
    ts.setVisibleLogicalRange({ from: r.to - width, to: r.to });
  };
  const reset = () => {
    const n = data.time.length;
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 2 });
  };

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="chart" />
      <ZoomControls onZoom={zoom} onReset={reset} />
      <CloseCountdown chart={chartRef} series={series as RefObject<ISeriesApi<SeriesType> | null>} price={price}
        period={PERIOD_SEC[data.interval]} />
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

