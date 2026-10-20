import { useEffect, useState, type ReactNode } from "react";
import { api, type ChartData, type Status } from "../api";
import { useLiveCandle } from "../live";
import { CandleChart, useChartColors } from "./CandleChart";
import { Card, Empty, Skeleton } from "./ui";

/** Свечи монеты; перезагружаются, когда меняются вход или стоп позиции. */
function useChart(coin: string, status: Status) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pos = status.positions.find((p) => p.coin === coin);
  const posKey = pos ? `${pos.entry}:${pos.stop}` : "";
  useEffect(() => {
    let alive = true;
    setData(null);
    setError(null);
    api.chart(coin).then((d) => alive && setData(d), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [coin, posKey]);
  return { data, error, held: !!pos };
}

export function ChartCard({ coin, status, title, aside, tall, className }: {
  coin: string; status: Status; title?: ReactNode; aside?: ReactNode; tall?: boolean; className?: string;
}) {
  const { data, error, held } = useChart(coin, status);
  const set = status.settings;
  const colors = useChartColors();
  const live = useLiveCandle(coin);
  return (
    <Card title={title} aside={aside} className={`chart-card ${tall ? "tall" : ""} ${className ?? ""}`}>
      <div className="chart-area">
        {data ? <CandleChart data={data} live={live} /> : error ? <Empty title="График не загрузился">{error}</Empty> : <Skeleton height="100%" />}
      </div>
      <div className="legend">
        <span><i style={{ background: colors.fast }} />EMA {set.ema_fast}</span>
        <span><i style={{ background: colors.slow }} />EMA {set.ema_slow}</span>
        {held && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп</span>}
        <span className="legend-tf">свечи 4 ч</span>
      </div>
    </Card>
  );
}
