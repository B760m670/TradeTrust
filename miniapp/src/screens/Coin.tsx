import { api, type Status } from "../api";
import type { Act } from "../components/BotControls";
import { ChartCard } from "../components/ChartCard";
import { BackIcon } from "../components/icons";
import { Button, Card, Chip, CoinAvatar, RangeBar, Tile, Value } from "../components/ui";
import { pct, price, tone, usd } from "../format";
import { coinState, emaGap, entryPlan } from "../logic";
import { confirmAction } from "../telegram";

interface Props {
  coin: string;
  status: Status;
  busy: boolean;
  act: Act;
  wide: boolean;
  onBack: () => void;
}

export function Coin({ coin, status: s, busy, act, wide, onBack }: Props) {
  const sig = s.signals[coin];
  const pos = s.positions.find((p) => p.coin === coin);
  const state = coinState(sig, !!pos);
  const plan = !pos && state.isEntry && sig ? entryPlan(sig, s.settings, s.equity) : null;
  const set = s.settings;
  const gap = sig ? emaGap(sig) : null;
  const now = pos?.price ?? sig?.price;

  const close = async () => {
    if (await confirmAction(`Закрыть ${coin}? Бот отменит стоп и продаст по рынку.`)) act(() => api.close(coin));
  };

  return (
    <div className="coin">
      <header className="coin-head">
        {wide && <button className="icon-btn btn btn-ghost" aria-label="Назад" onClick={onBack}><BackIcon /></button>}
        <CoinAvatar coin={coin} tone={state.tone === "muted" ? "accent" : state.tone} size={48} />
        <div className="row-main">
          <h1>{coin}<span className="muted">/USDT</span></h1>
          <Chip tone={state.tone}>{state.label}</Chip>
        </div>
        <span className="coin-price num">{price(now)}</span>
      </header>

      <div className="coin-grid">
        <ChartCard coin={coin} status={s} tall={wide} className="coin-chart" />

        <div className="coin-side">
          {pos && (
            <Card title="Позиция" aside={<Value tone={tone(pos.pnl_usdt)} bold>{usd(pos.pnl_usdt, true)} $</Value>}>
              <RangeBar position={pos} />
              <div className="tiles tiles-2">
                <Tile label="Количество" value={price(pos.qty)} />
                <Tile label="Изменение" value={pct((pos.price / pos.entry - 1) * 100, true)} tone={tone(pos.price - pos.entry)} />
                <Tile label="До стопа" value={pct((1 - pos.stop / pos.price) * 100)} />
                <Tile label="Под риском" value={`${usd(Math.max(0, (pos.price - pos.stop) * pos.qty))} $`} />
              </div>
              <Button variant="danger" disabled={busy} onClick={() => void close()}>Закрыть по рынку</Button>
            </Card>
          )}

          {plan && (
            <Card title="План по системе" className="accent-border">
              <dl className="facts">
                <dt>Купить</dt><dd>~{price(plan.qty)} {coin} · {usd(plan.cost)} $</dd>
                <dt>Стоп</dt><dd>{price(plan.stop)} (−{pct(plan.stopPct)})</dd>
                <dt>Риск</dt><dd>{usd(plan.risk)} $ ({set.risk_pct}%)</dd>
                <dt>Выход</dt><dd>EMA {set.ema_fast} ниже EMA {set.ema_slow} или стоп</dd>
              </dl>
              <p className="footnote">
                {s.mode === "signals" ? "Режим «Сигналы»: бот сделку не открывает."
                  : "Бот обработал сигнал при закрытии свечи — смотрите «Обзор»."}
              </p>
            </Card>
          )}

          {sig && !sig.error && sig.price != null && (
            <Card title="Индикаторы">
              <div className="tiles tiles-2">
                <Tile label={`EMA ${set.ema_fast}`} value={price(sig.ema_fast)} />
                <Tile label={`EMA ${set.ema_slow}`} value={price(sig.ema_slow)} />
                <Tile label="Разрыв EMA" value={gap == null ? "—" : pct(gap, true)} tone={gap == null ? undefined : tone(gap)} />
                <Tile label="ATR" value={sig.atr == null ? "—" : price(sig.atr)}
                  hint={sig.atr == null ? undefined : `${pct((sig.atr / sig.price) * 100)} от цены`} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
