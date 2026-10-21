import type { CSSProperties } from "react";
import type { Status } from "../api";
import type { Tab } from "../App";
import { BotState, EnvChip, PauseButton, type Act } from "../components/BotControls";
import { ChevronIcon, GearIcon } from "../components/icons";
import { BigMoney, Button, Card, CoinAvatar, Flash, LiveBadge, Skeleton, Tile, Value } from "../components/ui";
import { pct, price, tone, usd } from "../format";
import { useTickers } from "../live";
import { dayChange } from "../logic";
import { PositionCard, ProposalCard } from "./Overview";
import { usePortfolio, withLive } from "./Portfolio";

const MODE_LABEL = { signals: "только сигналы", confirm: "с подтверждением", auto: "сам" } as const;
const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

interface Props {
  status: Status;
  busy: boolean;
  act: Act;
  onOpenCoin: (coin: string) => void;
  onTab: (tab: Tab) => void;
  onBot: () => void;
  onSettings: () => void;
}

/** Главная, как у бирж: баланс всего счёта, торговые боты карточками, что ждёт решения, рынок за сутки. */
export function Home({ status: s, busy, act, onOpenCoin, onTab, onBot, onSettings }: Props) {
  const { data } = usePortfolio();
  const tickers = useTickers(s.all_coins);
  const assets = data ? withLive(data.assets, tickers) : [];
  const total = data ? assets.reduce((sum, a) => sum + (a.value ?? 0), 0) : null;
  const day = data ? dayChange(assets, Object.fromEntries(Object.entries(tickers).map(([c, t]) => [c, t.change24h]))) : null;
  const realized = s.trades.reduce((sum, t) => sum + t.pnl_usdt, 0);
  const botPnl = realized + s.equity.unrealized;
  const movers = Object.entries(tickers).sort((a, b) => Math.abs(b[1].change24h) - Math.abs(a[1].change24h)).slice(0, 5);

  return (
    <div className="home">
      <header className="top">
        <span className="logo" aria-hidden="true">TT</span>
        <div className="top-title"><strong>TradeTrust</strong><EnvChip status={s} /></div>
        <button className="icon-btn btn btn-ghost" aria-label="Настройки" onClick={onSettings}><GearIcon /></button>
      </header>

      {s.account === "demo" && (
        <Card className="demo-card">
          <strong>Это ваш демо-счёт</strong>
          <p className="muted small">
            {usd(s.paper_start_usdt ?? 1000)} виртуальных USDT по настоящим ценам Bybit. Можно торговать вручную
            на «Торговать» и смотреть, как работает трендовый бот. Настоящие деньги не используются.
          </p>
        </Card>
      )}

      <section className="hero">
        <span className="eyebrow">Баланс счёта, USD</span>
        {total == null ? <Skeleton height={52} width="60%" /> : <BigMoney value={total} unit="$" />}
        <div className="hero-pills">
          {day && <span className={`pill pill-${tone(day.usd)}`}>{usd(day.usd, true)} $ · {pct(day.pct, true)}</span>}
          <span className="muted small">за 24 часа</span>
          <LiveBadge on={Object.keys(tickers).length > 0} />
        </div>
        <div className="btn-row">
          <Button variant="primary" onClick={() => onTab("trade")}>Торговать</Button>
          <Button onClick={() => onTab("assets")}>Активы</Button>
        </div>
      </section>

      <h3 className="section-title">Торговые боты</h3>
      <Card className="bot-card">
        <button className="bot-card-main" onClick={onBot}>
          <span className="bot-icon" aria-hidden="true">📈</span>
          <span className="row-main">
            <strong>Трендовый бот</strong>
            <span className="muted small">спот · свечи 4ч · {MODE_LABEL[s.mode]}</span>
          </span>
          <ChevronIcon size={18} />
        </button>
        <div className="tiles tiles-3">
          <Tile label="Капитал" value={`${usd(s.equity.total)} $`} />
          <Tile label="Прибыль" value={`${usd(botPnl, true)} $`} tone={tone(botPnl)} hint="за всё время" />
          <Tile label="Позиции" value={`${s.positions.length}/${s.settings.max_positions}`} />
        </div>
        <div className="side-row">
          <BotState status={s} />
          <PauseButton status={s} busy={busy} act={act} />
        </div>
      </Card>

      {s.proposals.length > 0 && (
        <>
          <h3 className="section-title">Бот предлагает купить</h3>
          {s.proposals.map((p, i) => <ProposalCard key={p.id} p={p} busy={busy} act={act} i={i} />)}
        </>
      )}

      {s.positions.length > 0 && (
        <>
          <h3 className="section-title">Позиции бота</h3>
          <div className="positions">
            {s.positions.map((p, i) => <PositionCard key={p.coin} p={p} i={i} onOpen={() => onOpenCoin(p.coin)} />)}
          </div>
        </>
      )}

      {movers.length > 0 && (
        <Card title="Рынок за сутки" aside={<button className="link-btn" onClick={() => onTab("markets")}>Все <ChevronIcon size={16} /></button>}>
          <div className="list">
            {movers.map(([coin, t], i) => (
              <button key={coin} className="list-row tappable" style={stagger(i)} onClick={() => onOpenCoin(coin)}>
                <CoinAvatar coin={coin} size={30} tone={t.change24h >= 0 ? "up" : "down"} />
                <strong className="list-coin">{coin}</strong>
                <Flash value={t.price} className="num">{price(t.price)}</Flash>
                <Value tone={tone(t.change24h)} bold>{pct(t.change24h, true)}</Value>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
