import { useEffect, useState, type ReactNode } from "react";
import { api, type ChartData, type Status } from "../api";
import { useLiveCandle } from "../live";
import { utcOffsetLabel } from "../logic";
import { prefs } from "../telegram";
import { CandleChart, useChartColors } from "./CandleChart";
import { TradingViewChart } from "./TradingViewChart";
import { Card, Empty, Segmented, Skeleton } from "./ui";

type View = "market" | "bot";
const VIEWS: [View, string][] = [["market", "График"], ["bot", "Бот · 4ч"]];
const VIEW_KEY = "chart_view";
const ZONE = utcOffsetLabel(-new Date().getTimezoneOffset()); // часовой пояс телефона

function useView(): [View, (v: View) => void] {
  const [view, setView] = useState<View>(() => (prefs.getLocal(VIEW_KEY) === "bot" ? "bot" : "market"));
  return [view, (next) => { setView(next); prefs.set(VIEW_KEY, next); }];
}

/** 4ч свечи для вида «Бот»; перезагружаются, когда меняются вход или стоп позиции. */
function useBotChart(coin: string, status: Status, enabled: boolean) {
  const [data, setData] = useState<ChartData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pos = status.positions.find((p) => p.coin === coin);
  const posKey = pos ? `${pos.entry}:${pos.stop}` : "";
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setData(null);
    setError(null);
    api.chart(coin, "4h").then((d) => alive && setData(d), (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [coin, posKey, enabled]);
  return { data, error, pos };
}

/** Два вида, как на бирже: «График» — полный TradingView с данными Bybit (все таймфреймы и индикаторы),
 *  «Бот · 4ч» — то, по чему бот принимает решения: свечи 4ч, EMA, вход и стоп позиции. */
export function ChartCard({ coin, status, title, aside, tall, className }: {
  coin: string; status: Status; title?: ReactNode; aside?: ReactNode; tall?: boolean; className?: string;
}) {
  const [view, setView] = useView();
  const isBot = view === "bot";
  const { data, error, pos } = useBotChart(coin, status, isBot);
  const set = status.settings;
  const colors = useChartColors();
  const live = useLiveCandle(coin, isBot ? "240" : "");

  let body;
  if (!isBot) {
    body = <TradingViewChart coin={coin} />;
  } else if (data) {
    body = <CandleChart data={data} live={live} />;
  } else if (error) {
    body = <Empty title="График не загрузился">{error}</Empty>;
  } else {
    body = <Skeleton height="100%" />;
  }

  return (
    <Card title={title} aside={aside} className={`chart-card ${isBot ? "" : "market"} ${tall ? "tall" : ""} ${className ?? ""}`}>
      <Segmented label="Вид графика" options={VIEWS} value={view} onChange={setView} />
      <div className="chart-area">{body}</div>
      <div className="legend">
        {isBot ? (
          <>
            <span><i style={{ background: colors.fast }} />EMA {set.ema_fast}</span>
            <span><i style={{ background: colors.slow }} />EMA {set.ema_slow}</span>
            {pos && <span><i className="dashed" style={{ borderColor: colors.down }} />стоп</span>}
            <span className="legend-tf">свечи 4ч — по ним бот решает · время {ZONE}</span>
          </>
        ) : (
          <span className="legend-tf">TradingView · спот Bybit · время {ZONE}</span>
        )}
      </div>
    </Card>
  );
}
