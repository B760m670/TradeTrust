import {
  CandlestickSeries, ColorType, HistogramSeries, LineStyle, createChart,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { useContext, useEffect, useRef, useState } from "react";
import { api, type MarketTrade } from "../api";
import { chartPrice } from "../format";
import { LiveContext } from "../live";
import { addTrade, barsFromRows, feedState, fillSeconds, type SecondBar } from "../logic";
import { useTheme } from "../theme";
import { ZoomControls, useChartColors } from "./CandleChart";
import { crosshairTime, tickMark } from "./chartTime";

const BAR_SPACING = 8;       // ширина секунды на экране, px: ~45 секунд на телефоне
const FLUSH_MS = 200;        // сделки идут десятками в секунду — на экран пачкой
const SEED_WAIT_MS = 4000;   // сколько ждать историю с сервера, прежде чем рисовать без неё

const num = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);

/** «1с» как на биржах: свеча за каждую секунду из потока сделок Bybit, внизу объём.
 *  История — последние 15 минут с сервера бота (он слушает сделки всё время: у Bybit нет свечей по секундам),
 *  дальше — живой поток. Выход из «1с» и повторный вход ничего не сбрасывают: история снова берётся с сервера. */
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
  // доказательство, что это «прямо сейчас»: через сколько после сделки на бирже она дошла до телефона
  const delays = useRef<number[]>([]);
  const lastTradeAt = useRef<number | null>(null);
  const [live, setLive] = useState(() => feedState([], null, Date.now()));

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
  // к последней секунде с обычным масштабом; дальше график сам сдвигается за новыми свечами
  const showRecent = () => {
    const ts = chartRef.current?.timeScale();
    ts?.applyOptions({ barSpacing: BAR_SPACING });
    ts?.scrollToRealTime();
  };

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: colors.text,
        fontFamily: "'Manrope Variable', system-ui, sans-serif" },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.25 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: true, rightOffset: 4,
        barSpacing: BAR_SPACING, shiftVisibleRangeOnNewBar: true, tickMarkFormatter: tickMark },
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
    delays.current = [];
    lastTradeAt.current = null;
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
    const seed = (history: SecondBar[], trades: MarketTrade[] = []) => {
      if (!alive || seeded) return;
      seeded = true;
      bars.current = history;
      redraw();
      apply(trades);
      apply(pending);
      pending = [];
      showRecent();
    };
    // история: секундные свечи с сервера; если их нет (сервер только запустился) — последние сделки
    api.seconds(coin)
      .then((d) => barsFromRows(d.bars))
      .catch(() => [] as SecondBar[])
      .then(async (history) => {
        if (history.length) return seed(history);
        const trades = await api.trades(coin).then((d) => d.trades, () => [] as MarketTrade[]);
        seed([], trades);
      });
    const wait = setTimeout(() => seed([]), SEED_WAIT_MS);

    const off = feed?.subscribe(`publicTrade.${coin}USDT`, (d) => {
      const t = { t: num(d.T), p: num(d.p), v: num(d.v) };
      if (![t.t, t.p, t.v].every(Number.isFinite)) return;
      const now = Date.now();
      const sample = t.t - now;
      skew = first ? sample : skew * 0.9 + sample * 0.1;
      first = false;
      delays.current = [...delays.current.slice(-29), now - t.t];
      lastTradeAt.current = now;
      pending.push(t);
    });
    const flush = setInterval(() => {
      if (!seeded || !pending.length) return;
      const batch = pending;
      pending = [];
      apply(batch);
    }, FLUSH_MS);
    // время идёт и без сделок: прошедшие секунды без сделок — ровные свечи
    const tick = setInterval(() => {
      setLive(feedState(delays.current, lastTradeAt.current, Date.now()));
      if (!seeded) return;
      const added = fillSeconds(bars.current, Math.floor((Date.now() + skew) / 1000) - 1);
      if (!added.length) return;
      if (bars.current[0].time > shown.current) redraw();
      else draw(added);
    }, 1000);
    return () => {
      alive = false;
      clearTimeout(wait);
      clearInterval(flush);
      clearInterval(tick);
      off?.();
    };
  }, [coin, feed]);

  // масштаб — шириной секунды; правый край (последняя секунда) остаётся на месте
  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale();
    if (!ts) return;
    ts.applyOptions({ barSpacing: Math.min(40, Math.max(2, ts.options().barSpacing / factor)) });
  };

  return (
    <div className="chart-wrap">
      <div ref={box} className="chart" data-testid="tick-chart" />
      <ZoomControls onZoom={zoom} onReset={showRecent} />
      <span className={`feed-state ${live.kind}`}
        title="Время от сделки на бирже до вашего телефона (по часам биржи и телефона)">
        <i aria-hidden="true" />{live.text}
      </span>
    </div>
  );
}
