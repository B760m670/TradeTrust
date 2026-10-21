import type { CSSProperties } from "react";
import type { Status } from "../api";
import type { Tab } from "../App";
import { AccountSegment } from "../components/Account";
import { BotPowerButton, BotState, PauseButton, type Act } from "../components/BotControls";
import { BotIcon, BuyIcon, ChevronIcon, GearIcon, SellIcon, WalletIcon } from "../components/icons";
import { BigMoney, Card, CoinAvatar, Flash, LiveBadge, Skeleton } from "../components/ui";
import { pct, price, tone, usd } from "../format";
import { useTickers } from "../live";
import { dayChange } from "../logic";
import { PositionCard, ProposalCard } from "./Overview";
import { usePortfolio, withLive } from "./Portfolio";

const MODE_TAG = { signals: "СИГНАЛЫ", confirm: "ВРУЧНУЮ", auto: "АВТО" } as const;
const arrow = (x: number) => (x >= 0 ? "▲ " : "▼ ");
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

  const tape = s.all_coins.slice(0, 12).filter((c) => tickers[c]);
  const entries = Object.entries(s.signals)
    .filter(([c, g]) => g.cross_up && g.regime_ok && g.trend_ok !== false && !s.positions.some((p) => p.coin === c))
    .map(([c]) => c).slice(0, 3);
  const real = s.env === "mainnet";

  return (
    <div className="home">
      <header className="rail">
        <span className="logo" aria-hidden="true">TT</span>
        <AccountSegment status={s} busy={busy} act={act} />
        <span className="grow" />
        <button className="sq-btn" aria-label="Настройки" onClick={onSettings}><GearIcon size={18} /></button>
      </header>

      {tape.length > 0 && (
        <div className="tape" aria-label="Цены за сутки">
          <div className="tape-track">
            {[0, 1].map((k) => (
              <span key={k} aria-hidden={k === 1 || undefined}>
                {tape.map((c) => (
                  <button key={c} onClick={() => onOpenCoin(c)} tabIndex={k ? -1 : 0}>
                    <b>{c}</b> {price(tickers[c].price)}{" "}
                    <span className={`tone-${tone(tickers[c].change24h)}`}>{arrow(tickers[c].change24h)}{pct(Math.abs(tickers[c].change24h))}</span>
                  </button>
                ))}
              </span>
            ))}
          </div>
        </div>
      )}

      {s.account === "demo" && (
        <Card className="demo-card">
          <strong>Это ваш демо-счёт</strong>
          <p className="muted small">
            {usd(s.paper_start_usdt ?? 1000)} виртуальных USDT по настоящим ценам Bybit. Можно торговать вручную
            на «Торговать» и смотреть, как работает трендовый бот. Настоящие деньги не используются.
          </p>
        </Card>
      )}
      {real && s.accounts && (
        <Card className="real-card">
          <strong>Реальный счёт Bybit</strong>
          <p className="muted small">
            Сделки здесь — настоящие деньги. Бот {s.enabled === false ? "выключен: торгуете только вы" :
              `включён и торгует в пределах ${usd(s.settings.capital_usdt)} USDT`}.
          </p>
        </Card>
      )}

      <section className="balance">
        <span className="eyebrow">Общий баланс · USD</span>
        {total == null ? <Skeleton height={44} width="60%" /> : <BigMoney value={total} unit="" />}
        <div className="row tight">
          {day && <span className={`chg tone-${tone(day.usd)}`}>{arrow(day.usd)}{pct(Math.abs(day.pct))}</span>}
          {day && <span className={`num bold small tone-${tone(day.usd)}`}>{usd(day.usd, true)} $</span>}
          <span className="faint small">за 24 ч</span>
          <LiveBadge on={Object.keys(tickers).length > 0} />
        </div>
      </section>

      <div className="quick">
        <button onClick={() => onTab("trade")}><BuyIcon size={20} className="tone-up" />Купить</button>
        <button onClick={() => onTab("trade")}><SellIcon size={20} className="tone-down" />Продать</button>
        <button onClick={onBot}><BotIcon size={20} className="tone-accent" />Бот</button>
        <button onClick={() => onTab("assets")}><WalletIcon size={20} className="muted" />Активы</button>
      </div>

      <div className="sec-head"><h3 className="section-title">Торговые боты</h3>
        <button className="link-btn" onClick={onBot}>Открыть <ChevronIcon size={14} /></button></div>
      <Card className="bot-card">
        <button className="bot-card-main" onClick={onBot}>
          <span className={`led${s.enabled === false ? " off" : s.paused ? " amber" : ""}`} aria-hidden="true" />
          <span className="row-main">
            <strong>Трендовый бот</strong>
            <span className="muted small">EMA {s.settings.ema_fast}/{s.settings.ema_slow} · 4ч · спот · {s.settings.coins.length} монет</span>
          </span>
          <span className="mode-tag">{s.enabled === false ? "ВЫКЛ" : MODE_TAG[s.mode]}</span>
        </button>
        <div className="grid3">
          <div><small>КАПИТАЛ</small><b className="num">{usd(s.equity.total)}</b></div>
          <div><small>P&amp;L</small><b className={`num tone-${tone(botPnl)}`}>{usd(botPnl, true)}</b></div>
          <div><small>ПОЗИЦИИ</small><b className="num">{s.positions.length}/{s.settings.max_positions}</b></div>
        </div>
        <div className="side-row">
          {entries.length > 0
            ? <span className="sig-list">{entries.map((c) => <span key={c} className="sig-tag">▲ {c} вход</span>)}</span>
            : <BotState status={s} />}
          {s.enabled === false ? <BotPowerButton status={s} busy={busy} act={act} /> : <PauseButton status={s} busy={busy} act={act} />}
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
        <>
          <div className="sec-head"><h3 className="section-title">Рынок за сутки</h3>
            <button className="link-btn" onClick={() => onTab("markets")}>Рынки <ChevronIcon size={14} /></button></div>
          <div className="table">
            <div className="th"><span>ПАРА</span><span>ЦЕНА · 24Ч</span></div>
            {movers.map(([coin, t], i) => (
              <button key={coin} className="tr tappable" style={stagger(i)} onClick={() => onOpenCoin(coin)}>
                <CoinAvatar coin={coin} size={30} tone={t.change24h >= 0 ? "up" : "down"} />
                <span className="row-main"><strong>{coin}<span className="faint">/USDT</span></strong>
                  {s.positions.some((p) => p.coin === coin) && <span className="small tone-accent">бот в позиции</span>}</span>
                <span className="row-end">
                  <Flash value={t.price} className="num bold">{price(t.price)}</Flash>
                  <span className={`chg tone-${tone(t.change24h)}`}>{arrow(t.change24h)}{pct(Math.abs(t.change24h))}</span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
