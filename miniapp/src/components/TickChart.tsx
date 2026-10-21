import {
  CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { useContext, useEffect, useRef } from "react";
import { api, type MarketTrade } from "../api";
import { chartPrice } from "../format";
import { LiveContext } from "../live";
import { addTrade, fillSeconds, type SecondBar } from "../logic";
import { useTheme } from "../theme";
import { ZoomControls, useChartColors } from "./CandleChart";
import { crosshairTime, tickMark } from "./chartTime";

const VISIBLE_SECONDS = 90;
const FLUSH_MS = 200;        // сделки идут десятками в секунду — на экран пачкой
const SEED_WAIT_MS = 3000;   // сколько ждать историю сделок с сервера, прежде чем рисовать без неё

const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);

/** «1с» как на биржах: свеча за каждую секунду из потока сделок Bybit, внизу объём.
 *  Начало — последние сделки с сервера бота (у биржи нет истории по секундам), дальше — поток. */
export function TickChart({ coin, levels }: { coin: string; levels: { stop: number; entry: number } | null }) {
  const feed = useContext(LiveContext);
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volume = useRef<ISeriesApi<"Histogram"> | null>(null);
  const bars = useRef<SecondBar[]>([]);
  const shown = useRef(0); // последняя секунда на графике
  const { theme } = useTheme();
  const colors = useChartColors();

  const volBar = (b: SecondBar) => ({
    time: b.time as UTCTimestamp, value: b.volume,
    color: b.close >= b.open ? `${colors.up}66` : `${colors.down}66`,
  });
  const candleBar = (b: SecondBar) =>
    ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });

  const draw = (changed: Iterable<SecondBar>) => {
    if (!candles.current || !volume.current) return;
    for (const b of [...new Set(changed)].sort((x, y) => x.time - y.time)) {
      const old = b.time <= shown.current;
      if (old && b.time < (bars.current[0]?.time ?? 0)) continue;
      candles.current.update(candleBar(b), old);
      volume.current.update(volBar(b), old);
      shown.current = Math.max(shown.current, b.time);
    }
  };
  const redraw = () => {
    candles.current?.setData(bars.current.map(candleBar));
    volume.current?.setData(bars.current.map(volBar));
    shown.current = bars.current[bars.current.length - 1]?.time ?? 0;
  };
  const showRecent = () => {
    const n = bars.current.length;
    chartRef.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - VISIBLE_SECONDS), to: n + 3 });
  };

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 3,
        tickMarkFormatter: tickMark },
      crosshair: { vertLine: { color: colors.fast, labelBackgroundColor: colors.fast },
        horzLine: { color: colors.fast, labelBackgroundColor: colors.fast } },
      localization: { locale: "ru-RU", priceFormatter: (p: number) => chartPrice(p), timeFormatter: crosshairTime(true, true) },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });
    const c = chart.addSeries(CandlestickSeries, {
      upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down, borderVisible: false,
    });
    const v = chart.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" },
      lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    if (levels) {
      c.createPriceLine({ price: levels.stop, color: colors.down, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "стоп" });
      c.createPriceLine({ price: levels.entry, color: colors.text, lineStyle: LineStyle.Dotted, lineWidth: 1, title: "вход" });
    }
    chartRef.current = chart;
    candles.current = c;
    volume.current = v;
    redraw();
    showRecent();
    return () => {
      chartRef.current = null;
      candles.current = null;
      volume.current = null;
      chart.remove();
    };
  }, [theme, colors, levels?.stop, levels?.entry]);

  useEffect(() => {
    let alive = true;
    bars.current = [];
    redraw();
    let seeded = false;
    let pending: MarketTrade[] = [];
    let skew = 0; // часы биржи минус часы телефона, мс
    let first = true;

    const apply = (trades: MarketTrade[]) => {
      const changed: SecondBar[] = [];
      for (const t of trades) {
        const bar = addTrade(bars.current, t);
        if (bar) changed.push(bar);
      }
      // addTrade могла дописать пустые секунды перед сделкой или начать заново — тогда проще перерисовать
      if (bars.current.length && bars.current[0].time > shown.current) redraw();
      else draw(changed.concat(bars.current.filter((b) => b.time > shown.current)));
    };
    const seed = (trades: MarketTrade[]) => {
      if (!alive || seeded) return;
      seeded = true;
      bars.current = [];
      apply(trades);
      redraw();
      apply(pending);
      pending = [];
      showRecent();
    };
    api.trades(coin).then((d) => seed(d.trades), () => seed([]));
    const wait = setTimeout(() => seed([]), SEED_WAIT_MS);

    const off = feed?.subscribe(`publicTrade.${coin}USDT`, (d) => {
      const t = { t: num(d.T), p: num(d.p), v: num(d.v) };
      if (![t.t, t.p, t.v].every(Number.isFinite)) return;
      const sample = t.t - Date.now();
      skew = first ? sample : skew * 0.9 + sample * 0.1;
      first = false;
      pending.push(t);
    });
    const flush = setInterval(() => {
      if (!seeded || !pending.length) return;
      const batch = pending;
      pending = [];
      const wasAtEnd = isAtEnd();
      apply(batch);
      if (wasAtEnd) chartRef.current?.timeScale().scrollToRealTime();
    }, FLUSH_MS);
    // время идёт и без сделок: прошедшие секунды без сделок — ровные свечи
    const tick = setInterval(() => {
      if (!seeded) return;
      const added = fillSeconds(bars.current, Math.floor((Date.now() + skew) / 1000) - 1);
      if (!added.length) return;
      const wasAtEnd = isAtEnd();
      if (bars.current[0].time > shown.current) redraw();
      else draw(added);
      if (wasAtEnd) chartRef.current?.timeScale().scrollToRealTime();
    }, 1000);
    return () => {
      alive = false;
      clearTimeout(wait);
      clearInterval(flush);
      clearInterval(tick);
      off?.();
    };
  }, [coin, feed]);

  // если пользователь отмотал график назад — не дёргаем его к последней секунде
  const isAtEnd = () => {
    const r = chartRef.current?.timeScale().getVisibleLogicalRange();
    return !r || r.to >= bars.current.length - 2;
  };

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
