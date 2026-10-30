import { useEffect, useState, type CSSProperties } from "react";
import { api, type MyExchanges, type P2PView, type Status } from "../api";
import type { Tab } from "../App";
import { AccountSegment } from "../components/Account";
import type { Act } from "../components/BotControls";
import { BookIcon, BuyIcon, ChevronIcon, GearIcon, SellIcon, WalletIcon } from "../components/icons";
import { BigMoney, Card, CoinAvatar, Flash, LiveBadge, Logo, Skeleton } from "../components/ui";
import { compact, pct, price, tone, usd } from "../format";
import { useTickers } from "../live";
import { dayChange } from "../logic";
import { usePortfolio, withLive } from "./Portfolio";

const arrow = (x: number) => (x >= 0 ? "▲ " : "▼ ");
const stagger = (i: number) => ({ "--i": i }) as CSSProperties;
const SYMBOL: Record<string, string> = { RUB: "₽", USD: "$", EUR: "€", KZT: "₸" };

interface Props {
  status: Status;
  busy: boolean;
  act: Act;
  onOpenCoin: (coin: string) => void;
  onTab: (tab: Tab) => void;
  onSettings: () => void;
  onP2P?: () => void;
  onExchanges?: () => void;
}

/** Данные для главной раз в полминуты, пока экран открыт. */
function usePoll<T>(load: (() => Promise<T>) | null, every = 30_000) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!load) return;
    let alive = true;
    const run = () => load().then((d) => alive && setData(d), () => undefined);
    void run();
    const t = setInterval(() => document.visibilityState === "visible" && void run(), every);
    return () => { alive = false; clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return data;
}

/** Главная: баланс реального счёта, сразу под ним P2P (объявление, ордера, уровень), биржи и рынок за сутки. */
export function Home({ status: s, busy, act, onOpenCoin, onTab, onSettings, onP2P, onExchanges }: Props) {
  const { data } = usePortfolio();
  const tickers = useTickers(s.all_coins);
  const p2p = usePoll<P2PView>(s.p2p ? () => api.p2p() : null);
  const exchanges = usePoll<MyExchanges>(s.exchanges ? () => api.exchanges() : null, 60_000);
  const assets = data ? withLive(data.assets, tickers) : [];
  const total = data ? assets.reduce((sum, a) => sum + (a.value ?? 0), 0) : null;
  const day = data ? dayChange(assets, Object.fromEntries(Object.entries(tickers).map(([c, t]) => [c, t.change24h]))) : null;
  const movers = Object.entries(tickers).sort((a, b) => Math.abs(b[1].change24h) - Math.abs(a[1].change24h)).slice(0, 5);
  const tape = s.all_coins.slice(0, 12).filter((c) => tickers[c]);

  return (
    <div className="home">
      <header className="rail">
        <Logo />
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

      <section className="balance">
        <span className="eyebrow">Баланс Bybit · USD</span>
        {total == null ? <Skeleton height={44} width="60%" /> : <BigMoney value={total} unit="" />}
        <div className="row tight">
          {day && <span className={`chg tone-${tone(day.usd)}`}>{arrow(day.usd)}{pct(Math.abs(day.pct))}</span>}
          {day && <span className={`num bold small tone-${tone(day.usd)}`}>{usd(day.usd, true)} $</span>}
          <span className="faint small">за 24 ч</span>
          <LiveBadge on={Object.keys(tickers).length > 0} />
        </div>
      </section>

      {s.p2p && onP2P && <P2PCard data={p2p} onOpen={onP2P} />}

      <div className="quick">
        {s.p2p && onP2P && <button onClick={onP2P}><BookIcon size={20} className="tone-accent" />P2P</button>}
        {s.exchanges && onExchanges && <button onClick={onExchanges}><WalletIcon size={20} className="tone-up" />Биржи</button>}
        {!s.read_only && <button onClick={() => onTab("trade")}><BuyIcon size={20} className="tone-up" />Купить</button>}
        {!s.read_only && <button onClick={() => onTab("trade")}><SellIcon size={20} className="tone-down" />Продать</button>}
        {s.read_only && <button onClick={() => onTab("assets")}><WalletIcon size={20} className="muted" />Активы</button>}
      </div>

      {s.exchanges && onExchanges && <ExchangesCard data={exchanges} onOpen={onExchanges} />}

      {movers.length > 0 && (
        <>
          <div className="sec-head"><h3 className="section-title">Рынок за сутки</h3>
            <button className="link-btn" onClick={() => onTab("markets")}>Рынки <ChevronIcon size={14} /></button></div>
          <div className="table">
            <div className="th"><span>ПАРА</span><span>ЦЕНА · 24Ч</span></div>
            {movers.map(([coin, t], i) => (
              <button key={coin} className="tr tappable" style={stagger(i)} onClick={() => onOpenCoin(coin)}>
                <CoinAvatar coin={coin} size={30} tone={t.change24h >= 0 ? "up" : "down"} />
                <span className="row-main"><strong>{coin}<span className="faint">/USDT</span></strong></span>
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

/** P2P на главной — самое нужное без захода в раздел: оплаченные ордера, ваше объявление и место, уровень. */
function P2PCard({ data, onOpen }: { data: P2PView | null; onOpen: () => void }) {
  const ad = data?.my_ads?.find((a) => a.online) ?? data?.my_ads?.[0];
  const pending = data?.pending ?? [];
  const paid = pending.filter((o) => o.status === 20 && o.side === "sell");
  const lv = data?.level;
  const next = lv?.levels.find((l) => l.name === lv.next);
  const cur = ad ? SYMBOL[ad.currency] ?? ad.currency : "";
  return (
    <button className="home-p2p" onClick={onOpen}>
      <div className="home-p2p-head">
        <span className="small">P2P · мейкер{next ? ` · до «${next.name}» ${Math.round(Math.min(1, lv!.volume_30d / next.volume) * 100)}%` : ""}</span>
        <ChevronIcon size={16} />
      </div>
      {!data ? <Skeleton height={56} /> : ad ? (
        <div className="home-p2p-ad">
          <div>
            <b className="num">{price(ad.price)} {cur}</b>
            <span className="small">{ad.side === "sell" ? "продаю" : "покупаю"} · осталось {price(ad.left)} {ad.token} · {ad.online ? "в сети" : "снято"}</span>
          </div>
          {(ad.rank_pay ?? ad.rank) != null && <span className={`home-p2p-place${(ad.rank_pay ?? ad.rank) === 1 ? " top" : ""}`}>#{ad.rank_pay ?? ad.rank}</span>}
        </div>
      ) : <span className="small">Объявлений нет — разместите в Bybit, и оно появится здесь</span>}
      {data?.market?.cycle?.pct != null && (
        <span className={`small tone-${data.market.cycle.verdict === "go" ? "up" : data.market.cycle.verdict === "thin" ? "amber" : "down"}`}>
          Чистый круг {price(data.market.cycle.sell!)} → {price(data.market.cycle.buy!)} · {data.market.cycle.pct >= 0 ? "+" : "−"}
          {pct(Math.abs(data.market.cycle.pct))} · {data.market.cycle.verdict === "go" ? "делать" : data.market.cycle.verdict === "thin" ? "на грани" : "пропустить"}
        </span>
      )}
      {next && <div className="home-p2p-bar"><i style={{ width: `${Math.min(1, lv!.volume_30d / next.volume) * 100}%` }} /></div>}
      {paid.length > 0 ? (
        <span className="home-p2p-alert">💰 Покупатель отметил оплату · {compact(paid[0].amount)} {SYMBOL[paid[0].currency] ?? paid[0].currency} — проверьте банк</span>
      ) : pending.length > 0 ? <span className="small">Ордеров в работе: {pending.length}</span> : null}
    </button>
  );
}

/** Мои биржи: общий баланс и по каждой бирже — коротко, подробности по нажатию. */
function ExchangesCard({ data, onOpen }: { data: MyExchanges | null; onOpen: () => void }) {
  return (
    <Card className="home-ex">
      <button className="home-ex-main" onClick={onOpen}>
        <span className="row-main">
          <span className="small muted">Мои биржи</span>
          {data ? <b className="num">{usd(data.total)} $</b> : <Skeleton height={22} width="40%" />}
        </span>
        <ChevronIcon size={18} />
      </button>
      {data && (
        <div className="home-ex-list">
          {data.exchanges.map((e) => (
            <span key={e.name} className={e.connected && !e.error ? undefined : "off"}>
              {e.name}<b className="num">{e.total != null ? `${compact(e.total)} $` : e.error ? "ошибка" : "—"}</b>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}
