import { useMemo, useState, type ReactNode } from "react";
import type { Status } from "../api";
import { useLiveCandle } from "../live";
import { utcOffsetLabel } from "../logic";
import { haptic, prefs } from "../telegram";
import { CandleChart, SecondChart, useChartColors } from "./CandleChart";
import { INTERVALS, STREAM_CODE, useCandles, withLive, type Interval } from "./candles";
import { useSecondLine } from "./seconds";
import { Card, Empty, Skeleton } from "./ui";

const ZONE = utcOffsetLabel(-new Date().getTimezoneOffset()); // часовой пояс телефона
const TF_KEY = "chart_tf", EMA_KEY = "chart_ema";
type Tf = Interval | "1s";
const TFS: [Tf, string][] = [["1s", "1с"], ...INTERVALS];

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
  const [tf, setTf] = usePref<Tf>(TF_KEY, TFS.map(([k]) => k), "15m");
  const seconds = tf === "1s";
  const interval: Interval = seconds ? "1m" : tf; // для «1с» свечи не нужны, но хуки вызываем всегда
  const [emaOn, setEma] = usePref<"on" | "off">(EMA_KEY, ["on", "off"], "on");
  const { bars, error, loadMore } = useCandles(coin, interval);
  const live = useLiveCandle(coin, seconds ? "" : STREAM_CODE[interval]);
  const line = useSecondLine(seconds ? coin : "");
  const shown = useMemo(() => (bars ? withLive(bars, live, live?.volume) : null), [bars, live]);
  const set = status.settings;
  const colors = useChartColors();
  const pos = status.positions.find((p) => p.coin === coin) ?? null;
  const emas = useMemo<[number, number] | null>(() => (emaOn === "on" && !seconds ? [set.ema_fast, set.ema_slow] : null), [emaOn, seconds, set.ema_fast, set.ema_slow]);
  const position = useMemo(() => (pos ? { entry: pos.entry, stop: pos.stop } : null), [pos?.entry, pos?.stop]);

  let body;
  if (seconds) {
    body = line.length ? <SecondChart points={line} /> : <Skeleton height="100%" />;
  } else if (shown?.length) {
    body = <CandleChart bars={shown} interval={interval} kind="candles" emas={emas} position={position} onNeedMore={loadMore} />;
  } else if (error) {
    body = <Empty title="График не загрузился">{error}</Empty>;
  } else {
    body = <Skeleton height="100%" />;
  }

  return (
    <Card title={title} aside={aside} className={`chart-card ${tall ? "tall" : ""} ${className ?? ""}`}>
      <div className="chart-tools">
        <div className="tf-picker" role="radiogroup" aria-label="Таймфрейм">
          {TFS.map(([k, label]) => (
            <button key={k} role="radio" aria-checked={k === tf} className={k === tf ? "on" : undefined}
              onClick={() => k !== tf && setTf(k)}>{label}</button>
          ))}
        </div>
        {!seconds && (
          <div className="chart-switches">
            <button aria-pressed={emaOn === "on"} className={emaOn === "on" ? "on" : undefined}
              onClick={() => setEma(emaOn === "on" ? "off" : "on")}>EMA</button>
          </div>
        )}
      </div>
      <div className="chart-area">{body}</div>
      <div className="legend">
        {emas && <span><i style={{ background: colors.fast }} />EMA {set.ema_fast}</span>}
        {emas && <span><i style={{ background: colors.slow }} />EMA {set.ema_slow}</span>}
        {pos && !seconds && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп бота</span>}
        <span className="legend-tf">{seconds ? "сделки Bybit каждую секунду" : "спот Bybit · бот решает по 4ч"} · время {ZONE}</span>
      </div>
    </Card>
  );
}
