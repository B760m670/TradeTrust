import { useMemo, useState, type ReactNode } from "react";
import type { Status } from "../api";
import { useLiveCandle } from "../live";
import { utcOffsetLabel } from "../logic";
import { haptic, prefs } from "../telegram";
import { CandleChart, SecondChart, SUB_HEIGHT, useChartColors } from "./CandleChart";
import { INTERVALS, STREAM_CODE, useCandles, withLive, type Interval } from "./candles";
import { MAIN_INDS, MAX_SUBS, SUB_INDS, type MainInd, type SubInd } from "./indicators";
import { useSecondLine } from "./seconds";
import { Card, Empty, Skeleton } from "./ui";

const ZONE = utcOffsetLabel(-new Date().getTimezoneOffset()); // часовой пояс телефона
const TF_KEY = "chart_tf", MAIN_KEY = "chart_main", SUB_KEY = "chart_sub";
type Tf = Interval | "1s";
const TFS: [Tf, string][] = [["1s", "Срок"], ...INTERVALS]; // «Срок» — линия по сделкам, как у Bybit

function usePref<T extends string>(key: string, allowed: readonly T[], fallback: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = prefs.getLocal(key) as T | null;
    return saved && allowed.includes(saved) ? saved : fallback;
  });
  return [value, (v) => { haptic(); setValue(v); prefs.set(key, v); }];
}

/** Окна под графиком: список через запятую в настройках, не больше MAX_SUBS. */
function useSubs(): [SubInd[], (ind: SubInd) => void] {
  const [subs, setSubs] = useState<SubInd[]>(() =>
    (prefs.getLocal(SUB_KEY) ?? "").split(",").filter((x): x is SubInd => SUB_INDS.includes(x as SubInd)).slice(0, MAX_SUBS));
  const toggle = (ind: SubInd) => {
    haptic();
    // как у Bybit: повторное нажатие убирает окно; сверх лимита уходит самое старое
    const next = subs.includes(ind) ? subs.filter((x) => x !== ind) : [...subs, ind].slice(-MAX_SUBS);
    setSubs(next);
    prefs.set(SUB_KEY, next.join(","));
  };
  return [subs, toggle];
}

/** Один график, как на бирже: таймфреймы, свечи или линия, индикаторы, вход и стоп позиции бота.
 *  История — с сервера бота, текущая свеча — из потока Bybit, поэтому цена на графике совпадает с ценой в шапке. */
export function ChartCard({ coin, status, title, aside, tall, className }: {
  coin: string; status: Status; title?: ReactNode; aside?: ReactNode; tall?: boolean; className?: string;
}) {
  const [tf, setTf] = usePref<Tf>(TF_KEY, TFS.map(([k]) => k), "15m");
  const seconds = tf === "1s";
  const interval: Interval = seconds ? "1m" : tf; // для «1с» свечи не нужны, но хуки вызываем всегда
  const [mainInd, setMain] = usePref<MainInd | "none">(MAIN_KEY, [...MAIN_INDS, "none"], "EMA");
  const [subs, toggleSub] = useSubs();
  const { bars, error, loadMore } = useCandles(coin, interval);
  const live = useLiveCandle(coin, seconds ? "" : STREAM_CODE[interval]);
  const line = useSecondLine(seconds ? coin : "");
  const shown = useMemo(() => (bars ? withLive(bars, live, live?.volume) : null), [bars, live]);
  const set = status.settings;
  const colors = useChartColors();
  const pos = status.positions.find((p) => p.coin === coin) ?? null;
  const botEma = useMemo<[number, number]>(() => [set.ema_fast, set.ema_slow], [set.ema_fast, set.ema_slow]);
  const position = useMemo(() => (pos ? { entry: pos.entry, stop: pos.stop } : null), [pos?.entry, pos?.stop]);

  let body;
  if (seconds) {
    body = line.length ? <SecondChart points={line} /> : <Skeleton height="100%" />;
  } else if (shown?.length) {
    body = <CandleChart bars={shown} interval={interval} kind="candles" main={mainInd === "none" ? null : mainInd} subs={subs}
      botEma={botEma} position={position} onNeedMore={loadMore} />;
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
      </div>
      <div className="chart-area" style={seconds ? undefined : { height: `calc(var(--chart-h) + ${subs.length * SUB_HEIGHT}px)` }}>{body}</div>
      {!seconds && (
        <div className="ind-row" role="group" aria-label="Индикаторы">
          {MAIN_INDS.map((k) => (
            <button key={k} aria-pressed={mainInd === k} className={mainInd === k ? "on" : undefined}
              onClick={() => setMain(mainInd === k ? "none" : k)}>{k}</button>
          ))}
          <i className="ind-sep" />
          {SUB_INDS.map((k) => (
            <button key={k} aria-pressed={subs.includes(k)} className={subs.includes(k) ? "on" : undefined}
              onClick={() => toggleSub(k)}>{k}</button>
          ))}
        </div>
      )}
      {(seconds || pos) && (
        <div className="legend">
          {pos && !seconds && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп бота</span>}
          {seconds && <span className="legend-tf">каждая новая цена сделки Bybit — шаг линии · время {ZONE}</span>}
        </div>
      )}
    </Card>
  );
}
