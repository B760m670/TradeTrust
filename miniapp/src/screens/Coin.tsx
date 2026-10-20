import { Button, Cell, Placeholder, Section, Spinner, Title } from "@telegram-apps/telegram-ui";
import { useEffect, useState } from "react";
import { api, type ChartData, type Status } from "../api";
import { CHART_COLORS, CandleChart } from "../components/CandleChart";
import { Chip, Value } from "../components/ui";
import { pct, price, tone, usd } from "../format";
import { coinState, entryPlan } from "../logic";
import { confirmAction } from "../telegram";

interface Props {
  coin: string;
  status: Status;
  busy: boolean;
  act: (a: () => Promise<{ message: string }>) => void;
}

export function Coin({ coin, status: s, busy, act }: Props) {
  const [chart, setChart] = useState<ChartData | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const sig = s.signals[coin];
  const pos = s.positions.find((p) => p.coin === coin);
  const state = coinState(sig, !!pos);
  const plan = !pos && state.isEntry && sig ? entryPlan(sig, s.settings, s.equity) : null;
  const set = s.settings;
  // график перезагружаем, когда меняется позиция (вход/стоп на графике)
  const posKey = pos ? `${pos.entry}:${pos.stop}` : "";

  useEffect(() => {
    let alive = true;
    api.chart(coin).then((d) => alive && setChart(d), (e: Error) => alive && setChartError(e.message));
    return () => { alive = false; };
  }, [coin, posKey]);

  const close = async () => {
    if (await confirmAction(`Закрыть ${coin}? Бот отменит стоп и продаст по рынку.`)) act(() => api.close(coin));
  };

  return (
    <>
      <div className="coin-head">
        <Title weight="1">{coin}<span className="unit">/USDT</span></Title>
        <Chip tone={state.tone}>{state.label}</Chip>
      </div>
      <Section>
        <div className="chart-box">
          <div className="coin-price">{price(pos?.price ?? sig?.price)}</div>
          {chart ? <CandleChart data={chart} /> : chartError
            ? <Placeholder description={chartError} />
            : <div className="chart-loading"><Spinner size="m" /></div>}
          <div className="legend">
            <span><i style={{ background: CHART_COLORS.FAST }} />EMA {set.ema_fast}</span>
            <span><i style={{ background: CHART_COLORS.SLOW }} />EMA {set.ema_slow}</span>
            {pos && <span><i style={{ background: CHART_COLORS.DOWN }} />стоп</span>}
          </div>
        </div>
      </Section>

      {pos && (
        <Section header="Позиция">
          <Cell after={<Value>{price(pos.qty)}</Value>}>Количество</Cell>
          <Cell after={<Value>{price(pos.entry)}</Value>}>Вход</Cell>
          <Cell after={<Value>{price(pos.stop)} ({pct((1 - pos.stop / pos.price) * 100)} до стопа)</Value>}>Стоп</Cell>
          <Cell after={<Value tone={tone(pos.pnl_usdt)} bold>{usd(pos.pnl_usdt, true)} $</Value>}>Результат</Cell>
          <div className="actions">
            <Button stretched mode="gray" className="danger" disabled={busy} onClick={() => void close()}>
              Закрыть по рынку
            </Button>
          </div>
        </Section>
      )}

      {plan && (
        <Section header="План по системе"
          footer={s.mode === "signals" ? "Режим «Сигналы»: бот сделку не открывает."
            : "Бот обработал сигнал при закрытии свечи — смотрите «Обзор»."}>
          <Cell after={<Value>~{price(plan.qty)} ({usd(plan.cost)} $)</Value>}>Купить</Cell>
          <Cell after={<Value>{price(plan.stop)} (−{pct(plan.stopPct)})</Value>}>Стоп</Cell>
          <Cell after={<Value>{usd(plan.risk)} $ ({set.risk_pct}%)</Value>}>Риск</Cell>
          <Cell multiline description={`EMA ${set.ema_fast} ниже EMA ${set.ema_slow} или стоп`}>Выход</Cell>
        </Section>
      )}

      {sig && !sig.error && sig.price != null && (
        <Section header="Индикаторы">
          <Cell after={<Value>{price(sig.ema_fast)}</Value>}>EMA {set.ema_fast}</Cell>
          <Cell after={<Value>{price(sig.ema_slow)}</Value>}>EMA {set.ema_slow}</Cell>
          {sig.atr != null && <Cell after={<Value>{price(sig.atr)} ({pct((sig.atr / sig.price) * 100)})</Value>}>ATR</Cell>}
        </Section>
      )}
    </>
  );
}
