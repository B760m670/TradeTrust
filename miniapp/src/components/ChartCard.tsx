import { useMemo, useState, type ReactNode } from "react";
import type { Status } from "../api";
import { useLiveCandle } from "../live";
import { utcOffsetLabel } from "../logic";
import { haptic, prefs } from "../telegram";
import { CandleChart, useChartColors, type ChartKind } from "./CandleChart";
import { INTERVALS, STREAM_CODE, useCandles, withLive, type Interval } from "./candles";
import { Card, Empty, Skeleton } from "./ui";

const ZONE = utcOffsetLabel(-new Date().getTimezoneOffset()); // часовой пояс телефона
const TF_KEY = "chart_tf", KIND_KEY = "chart_kind", EMA_KEY = "chart_ema";

function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = prefs.getLocal(key) as T | null;
    return saved && allowed.includes(saved) ? saved : fallback;
  });
  return [value, (v) => { haptic(); setValue(v); prefs.set(key, v); }];
}

/** Один график, как на бирже: таймфреймы, свечи или линия, объём, EMA бота, вход и стоп его позиции.
 *  История — с сервера бота, текущая свеча — из потока Bybit, поэтому цена на графике совпадает с ценой в шапке. */
export function ChartCard({ coin, status, title, aside, tall, className }: {
  coin: string; status: Status; title?: ReactNode; aside?: ReactNode; tall?: boolean; className?: string;
}) {
  const [interval, setTf] = usePref<Interval>(TF_KEY, INTERVALS.map(([k]) => k), "15m");
  const [kind, setKind] = usePref<ChartKind>(KIND_KEY, ["candles", "line"], "candles");
  const [emaOn, setEma] = usePref<"on" | "off">(EMA_KEY, ["on", "off"], "on");
  const { bars, error, loadMore } = useCandles(coin, interval);
  const live = useLiveCandle(coin, STREAM_CODE[interval]);
  const shown = useMemo(() => (bars ? withLive(bars, live, live?.volume) : null), [bars, live]);
  const set = status.settings;
  const colors = useChartColors();
  const pos = status.positions.find((p) => p.coin === coin) ?? null;
  const emas = useMemo<[number, number] | null>(() => (emaOn === "on" ? [set.ema_fast, set.ema_slow] : null), [emaOn, set.ema_fast, set.ema_slow]);
  const position = useMemo(() => (pos ? { entry: pos.entry, stop: pos.stop } : null), [pos?.entry, pos?.stop]);

  let body;
  if (shown?.length) {
    body = <CandleChart bars={shown} interval={interval} kind={kind} emas={emas} position={position} onNeedMore={loadMore} />;
  } else if (error) {
    body = <Empty title="График не загрузился">{error}</Empty>;
  } else {
    body = <Skeleton height="100%" />;
  }

  return (
    <Card title={title} aside={aside} className={`chart-card ${tall ? "tall" : ""} ${className ?? ""}`}>
      <div className="chart-tools">
        <div className="tf-picker" role="radiogroup" aria-label="Таймфрейм">
          {INTERVALS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={k === interval} className={k === interval ? "on" : undefined}
              onClick={() => k !== interval && setTf(k)}>{label}</button>
          ))}
        </div>
        <div className="chart-switches">
          <button aria-pressed={emaOn === "on"} className={emaOn === "on" ? "on" : undefined}
            onClick={() => setEma(emaOn === "on" ? "off" : "on")}>EMA</button>
          <button aria-label={kind === "candles" ? "Показать линией" : "Показать свечами"}
            onClick={() => setKind(kind === "candles" ? "line" : "candles")}>{kind === "candles" ? "Свечи" : "Линия"}</button>
        </div>
      </div>
      <div className="chart-area">{body}</div>
      <div className="legend">
        {emas && <span><i style={{ background: colors.fast }} />EMA {set.ema_fast}</span>}
        {emas && <span><i style={{ background: colors.slow }} />EMA {set.ema_slow}</span>}
        {pos && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп бота</span>}
        <span className="legend-tf">спот Bybit · бот решает по 4ч · время {ZONE}</span>
      </div>
    </Card>
  );
}
