import type { CSSProperties } from "react";
import { api, type Position, type Proposal, type Status } from "../api";
import type { Tab } from "../App";
import { BotState, EnvChip, ModeSwitch, PauseButton, type Act } from "../components/BotControls";
import { ChartCard } from "../components/ChartCard";
import { ChevronIcon } from "../components/icons";
import { BigMoney, Button, Card, Chip, CoinAvatar, Empty, Flash, LiveBadge, RangeBar, Tile, Value } from "../components/ui";
import { clock, dateTime, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import { useLiveTickers } from "../live";
import { nextCandleClose, signalRows, stopRisk } from "../logic";

interface Props {
  status: Status;
  busy: boolean;
  act: Act;
  wide: boolean;
  onOpenCoin: (coin: string) => void;
  onTab: (tab: Tab) => void;
}

const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

function ProposalCard({ p, busy, act, i }: { p: Proposal; busy: boolean; act: Act; i: number }) {
  const left = Math.max(0, Math.round((p.expires_at - Date.now() / 1000) / 60));
  return (
    <Card className="proposal accent-border" style={stagger(i)}>
      <div className="row">
        <CoinAvatar coin={p.coin} />
        <div className="row-main">
          <strong>Вход {p.coin}</strong>
          <span className="muted">по ~{price(p.price)} · ещё {left} мин</span>
        </div>
        <Chip tone="accent">до {clock(p.expires_at)}</Chip>
      </div>
      <p className="proposal-text">
        Купить {price(p.qty)} {p.coin} ≈ {usd(p.qty * p.price)} $ · стоп {price(p.stop)}
        {" "}(−{pct((1 - p.stop / p.price) * 100)}) · риск {usd(p.risk_usdt)} $
      </p>
      <div className="btn-row">
        <Button variant="primary" disabled={busy} onClick={() => act(() => api.confirm(p.id))}>Купить</Button>
        <Button disabled={busy} onClick={() => act(() => api.reject(p.id))}>Пропустить</Button>
      </div>
    </Card>
  );
}

function PositionCard({ p, onOpen, i }: { p: Position; onOpen: () => void; i: number }) {
  const change = (p.price / p.entry - 1) * 100;
  return (
    <button className="card position tappable" style={stagger(i)} onClick={onOpen}>
      <div className="row">
        <CoinAvatar coin={p.coin} tone={change >= 0 ? "up" : "down"} />
        <div className="row-main">
          <strong>{p.coin}</strong>
          <span className="muted">{price(p.qty)} шт · с {dateTime(p.opened_at)}</span>
        </div>
        <div className="row-end">
          <Value tone={tone(p.pnl_usdt)} bold>{usd(p.pnl_usdt, true)} $</Value>
          <Value tone={tone(change)}>{pct(change, true)}</Value>
        </div>
      </div>
      <RangeBar position={p} />
    </button>
  );
}

function SignalsPanel({ status: s, onOpenCoin, onTab, limit }: {
  status: Status; onOpenCoin: (c: string) => void; onTab: (t: Tab) => void; limit: number;
}) {
  const rows = signalRows(s.signals, new Set(s.positions.map((p) => p.coin)));
  const entries = rows.filter((r) => r.state.isEntry).length;
  return (
    <Card className="signals-panel" title="Сигналы"
      aside={<span className="muted small">{entries ? `входов: ${entries}` : `${rows.length} монет`}</span>}>
      <div className="list">
        {rows.slice(0, limit).map(({ coin, signal, state }, i) => (
          <button key={coin} className="list-row tappable" style={stagger(i)} onClick={() => onOpenCoin(coin)}>
            <span className={`dot dot-${state.tone}`} />
            <strong className="list-coin">{coin}</strong>
            <Flash value={signal.price} className="muted num">{signal.error ? "—" : price(signal.price)}</Flash>
            <Chip tone={state.tone}>{state.label}</Chip>
          </button>
        ))}
        {rows.length === 0 && <span className="muted small">Ждём закрытия первой свечи</span>}
      </div>
      {rows.length > limit && (
        <button className="link-btn" onClick={() => onTab("signals")}>Все {rows.length} монет <ChevronIcon size={16} /></button>
      )}
    </Card>
  );
}

export function Overview({ status: s, busy, act, wide, onOpenCoin, onTab }: Props) {
  const now = useNow();
  const live = Object.keys(useLiveTickers()).length > 0;
  const risk = stopRisk(s.positions);
  const riskPct = s.equity.total ? (risk / s.equity.total) * 100 : 0;
  const unrealPct = s.equity.invested ? (s.equity.unrealized / s.equity.invested) * 100 : 0;
  const featured = s.positions[0]?.coin ?? s.proposals[0]?.coin
    ?? signalRows(s.signals, new Set()).find((r) => r.state.isEntry)?.coin ?? s.settings.coins[0];

  return (
    <div className="overview">
      {!wide && (
        <header className="top">
          <span className="logo" aria-hidden="true">TT</span>
          <div className="top-title">
            <BotState status={s} />
            <strong>TradeTrust</strong>
          </div>
          <EnvChip status={s} />
        </header>
      )}

      <section className="hero">
        <span className="eyebrow">Капитал бота</span>
        <BigMoney value={s.equity.total} />
        <div className="hero-pills">
          <span className={`pill pill-${tone(s.equity.unrealized)}`}>
            {usd(s.equity.unrealized, true)} $ · {pct(unrealPct, true)}
          </span>
          <span className="muted small">в открытых позициях</span>
          <LiveBadge on={live} />
        </div>
      </section>

      {!wide && (
        <div className="controls">
          <ModeSwitch status={s} busy={busy} act={act} />
          <PauseButton status={s} busy={busy} act={act} compact />
        </div>
      )}

      <div className="tiles">
        <Tile label="Свободно" value={`${usd(s.equity.free)} $`} />
        <Tile label="В позициях" value={`${usd(s.equity.invested)} $`}
          hint={`${s.positions.length} из ${s.settings.max_positions}`} />
        <Tile label="До стопов" value={`${usd(risk)} $`} hint={`${pct(riskPct)} капитала`} tone={risk > 0 ? "down" : undefined} />
        <Tile label="Свеча закроется" value={clock(nextCandleClose(now))} hint="таймфрейм 4 ч" />
      </div>

      <div className="overview-grid">
        <div className="col-main">
          {s.proposals.length > 0 && (
            <>
              <h3 className="section-title">Ждут подтверждения</h3>
              {s.proposals.map((p, i) => <ProposalCard key={p.id} p={p} busy={busy} act={act} i={i} />)}
            </>
          )}

          {wide && featured && (
            <ChartCard coin={featured} status={s} tall
              title={<button className="chart-title tappable" onClick={() => onOpenCoin(featured)}>
                <CoinAvatar coin={featured} size={32} /><span>{featured}<span className="muted">/USDT</span></span>
              </button>}
              aside={<span className="num big-price">{price(s.positions.find((p) => p.coin === featured)?.price
                ?? s.signals[featured]?.price)}</span>} />
          )}

          <h3 className="section-title">Позиции</h3>
          {s.positions.length === 0
            ? <Card><Empty title="Открытых позиций нет">Бот ждёт сигнала. Стопы и выходы работают всегда.</Empty></Card>
            : <div className="positions">{s.positions.map((p, i) =>
                <PositionCard key={p.coin} p={p} i={i} onOpen={() => onOpenCoin(p.coin)} />)}</div>}
        </div>

        <div className="col-side">
          <SignalsPanel status={s} onOpenCoin={onOpenCoin} onTab={onTab} limit={wide ? 12 : 5} />
        </div>
      </div>
    </div>
  );
}
