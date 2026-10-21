import { useEffect, useState, type ReactNode } from "react";
import { api, type ChartData, type Status } from "../api";
import { useLiveCandle } from "../live";
import { utcOffsetLabel } from "../logic";
import { haptic, prefs } from "../telegram";
import { CandleChart, useChartColors } from "./CandleChart";
import { LineChart } from "./LineChart";
import { Card, Empty, Skeleton } from "./ui";

// таймфрейм: [ключ, подпись, код потока Bybit]; «Линия» — как «Срок» у бирж: минутные закрытия + живая цена
const TIMEFRAMES: [string, string, string][] = [
  ["line", "Линия", "1"], ["1m", "1м", "1"], ["5m", "5м", "5"], ["15m", "15м", "15"], ["1h", "1ч", "60"],
  ["4h", "4ч", "240"], ["1d", "1Д", "D"], ["1w", "1Н", "W"],
];
const TF_KEY = "chart_tf";
const apiInterval = (tf: string) => (tf === "line" ? "1m" : tf);
const ZONE = utcOffsetLabel(-new Date().getTimezoneOffset()); // часовой пояс телефона
const BOT_TF = "4h";

function useTimeframe(): [string, (tf: string) => void] {
  const [tf, setTf] = useState(() => {
    const saved = prefs.getLocal(TF_KEY) === "1s" ? "line" : prefs.getLocal(TF_KEY); // «1с» заменила «Линия»
    return TIMEFRAMES.some(([k]) => k === saved) ? saved! : BOT_TF;
  });
  return [tf, (next) => { setTf(next); prefs.set(TF_KEY, next); }];
}

/** Свечи монеты; перезагружаются при смене таймфрейма и когда меняются вход или стоп позиции.
 *  Для «Линии» — минутные свечи. */
function useChart(coin: string, status: Status, interval: string) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pos = status.positions.find((p) => p.coin === coin);
  const posKey = pos ? `${pos.entry}:${pos.stop}` : "";
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.chart(coin, apiInterval(interval)).then((d) => alive && setData(d), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [coin, posKey, interval]);
  return { data, error, pos };
}

export function ChartCard({ coin, status, title, aside, tall, className }: {
  coin: string; status: Status; title?: ReactNode; aside?: ReactNode; tall?: boolean; className?: string;
}) {
  const [tf, setTf] = useTimeframe();
  const { data, error, pos } = useChart(coin, status, tf);
  const set = status.settings;
  const colors = useChartColors();
  const [, label, code] = TIMEFRAMES.find(([k]) => k === tf)!;
  const isLine = tf === "line";
  const live = useLiveCandle(coin, isLine ? "" : code);
  const ready = data && data.interval === apiInterval(tf);

  let body;
  if (ready && isLine) {
    body = <LineChart data={data} coin={coin} levels={pos ? { stop: pos.stop, entry: pos.entry } : null} />;
  } else if (ready) {
    body = <CandleChart data={data} live={live} />;
  } else if (error) {
    body = <Empty title="График не загрузился">{error}</Empty>;
  } else {
    body = <Skeleton height="100%" />;
  }

  return (
    <Card title={title} aside={aside} className={`chart-card ${tall ? "tall" : ""} ${className ?? ""}`}>
      <div className="tf-picker" role="radiogroup" aria-label="Таймфрейм">
        {TIMEFRAMES.map(([key, text]) => (
          <button key={key} role="radio" aria-checked={tf === key} className={tf === key ? "on" : undefined}
            onClick={() => { haptic(); setTf(key); }}>
            {text}
          </button>
        ))}
      </div>
      <div className="chart-area">{body}</div>
      <div className="legend">
        {!isLine && <span><i style={{ background: colors.fast }} />EMA {set.ema_fast}</span>}
        {!isLine && <span><i style={{ background: colors.slow }} />EMA {set.ema_slow}</span>}
        {pos && !isLine && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп</span>}
        <span className="legend-tf">
          {isLine ? "цена по минутам и живая — по каждой сделке Bybit" : `свечи ${label}`}{tf !== BOT_TF && " · бот решает по 4ч"}
          {` · время ${ZONE}`}
        </span>
      </div>
    </Card>
  );
}
