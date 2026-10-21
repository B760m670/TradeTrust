import { useState } from "react";
import { api, type Status } from "../api";
import type { Act } from "../components/BotControls";
import { ChartCard } from "../components/ChartCard";
import { ChevronIcon, CloseIcon } from "../components/icons";
import { Button, Card, Chip, CoinAvatar, Empty, Flash, LiveBadge, RangeBar, Segmented, Tile, Value } from "../components/ui";
import { chartPrice, dateTime, pct, price, tone, usd } from "../format";
import { useLiveTickers } from "../live";
import { coinState, emaGap, entryPlan } from "../logic";
import { confirmAction, haptic } from "../telegram";
import { usePortfolio } from "./Portfolio";

type Side = "buy" | "sell";
type Panel = "position" | "orders" | "bot";
const PANELS: [Panel, string][] = [["position", "Позиция"], ["orders", "Мои сделки"], ["bot", "Индикаторы"]];
const PARTS = [25, 50, 75, 100];

interface Props {
  coin: string;
  status: Status;
  busy: boolean;
  act: Act;
  wide: boolean;
  onCoin: (coin: string) => void;
}

/** «Торговать», как на биржах: пара со списком, график, под ним позиция и сделки, внизу «Купить / Продать». */
export function Trade({ coin, status: s, busy, act, wide, onCoin }: Props) {
  const tickers = useLiveTickers();
  const ticker = tickers[coin];
  const sig = s.signals[coin];
  const pos = s.positions.find((p) => p.coin === coin);
  const state = coinState(sig, !!pos);
  const now = ticker?.price ?? pos?.price ?? sig?.price;
  const { data: portfolio, reload } = usePortfolio();
  const holding = portfolio?.assets.find((a) => a.coin === coin);
  const ownQty = Math.max(0, (holding?.qty ?? 0) - (holding?.bot_qty ?? 0));
  const usdtFree = portfolio?.assets.find((a) => a.coin === "USDT")?.qty ?? s.equity.free;
  const [picker, setPicker] = useState(false);
  const [side, setSide] = useState<Side | null>(null);
  const [panel, setPanel] = useState<Panel>(pos ? "position" : "orders");

  return (
    <div className="trade">
      <header className="trade-head">
        <button className="pair-btn tappable" onClick={() => { haptic(); setPicker(true); }} aria-label="Выбрать пару">
          <CoinAvatar coin={coin} size={36} tone={state.tone === "muted" ? "accent" : state.tone} />
          <span className="pair-name"><strong>{coin}</strong><span className="muted">/USDT</span></span>
          <ChevronIcon size={18} />
        </button>
        <Chip tone="muted">Спот</Chip>
        <div className="row-end">
          <Flash value={now} className="coin-price num">{now == null ? "—" : chartPrice(now)}</Flash>
          <span className={`small num tone-${ticker ? tone(ticker.change24h) : "neutral"}`}>
            {ticker ? `${pct(ticker.change24h, true)} за 24 ч` : "—"}
          </span>
          <LiveBadge on={!!ticker} />
        </div>
      </header>

      <div className="coin-grid">
        <ChartCard coin={coin} status={s} tall={wide} className="coin-chart" />

        <div className="coin-side">
          <Segmented label="Панель" options={PANELS} value={panel} onChange={setPanel} />
          {panel === "position" && <BotPosition coin={coin} status={s} busy={busy} act={act} />}
          {panel === "orders" && <MyTrades coin={coin} status={s} ownQty={ownQty} price={now} />}
          {panel === "bot" && <Indicators coin={coin} status={s} />}
          {wide && <OrderButtons onSide={setSide} canSell={ownQty > 0} />}
        </div>
      </div>

      {!wide && <div className="trade-bar"><OrderButtons onSide={setSide} canSell={ownQty > 0} /></div>}

      {side && now != null && (
        <OrderSheet coin={coin} side={side} price={now} usdtFree={usdtFree} ownQty={ownQty} busy={busy}
          onSide={setSide} onClose={() => setSide(null)}
          onSubmit={async (usdt) => {
            const word = side === "buy" ? "Купить" : "Продать";
            if (!(await confirmAction(`${word} ${coin} на ${usd(usdt)} $ по рынку?`))) return;
            if (await act(() => api.order(coin, side, usdt))) {
              setSide(null);
              setPanel("orders");
              reload();
            }
          }} />
      )}

      {picker && <PairPicker coins={s.all_coins} current={coin} status={s} onPick={(c) => { setPicker(false); onCoin(c); }}
        onClose={() => setPicker(false)} />}
    </div>
  );
}

function OrderButtons({ onSide, canSell }: { onSide: (s: Side) => void; canSell: boolean }) {
  return (
    <div className="order-buttons">
      <Button variant="up" onClick={() => { haptic(); onSide("buy"); }}>Купить</Button>
      <Button variant="danger" disabled={!canSell} title={canSell ? undefined : "Своих монет нет — продавать нечего"}
        onClick={() => { haptic(); onSide("sell"); }}>Продать</Button>
    </div>
  );
}

function BotPosition({ coin, status: s, busy, act }: { coin: string; status: Status; busy: boolean; act: Act }) {
  const pos = s.positions.find((p) => p.coin === coin);
  const sig = s.signals[coin];
  const state = coinState(sig, !!pos);
  const plan = !pos && state.isEntry && sig ? entryPlan(sig, s.settings, s.equity) : null;
  const close = async () => {
    if (await confirmAction(`Закрыть позицию бота по ${coin}? Бот отменит стоп и продаст по рынку.`)) act(() => api.close(coin));
  };
  if (pos) {
    return (
      <Card title="Позиция бота" aside={<Value tone={tone(pos.pnl_usdt)} bold>{usd(pos.pnl_usdt, true)} $</Value>}>
        <RangeBar position={pos} />
        <div className="tiles tiles-2">
          <Tile label="Количество" value={price(pos.qty)} />
          <Tile label="Изменение" value={pct((pos.price / pos.entry - 1) * 100, true)} tone={tone(pos.price - pos.entry)} />
          <Tile label="До стопа" value={pct((1 - pos.stop / pos.price) * 100)} />
          <Tile label="Под риском" value={`${usd(Math.max(0, (pos.price - pos.stop) * pos.qty))} $`} />
        </div>
        <p className="footnote">Вход и стоп видны на графике в виде «Бот · 4ч».</p>
        <Button variant="danger" disabled={busy} onClick={() => void close()}>Закрыть позицию бота</Button>
      </Card>
    );
  }
  return (
    <Card title="Позиция бота">
      {plan ? (
        <dl className="facts">
          <dt>Сигнал</dt><dd><Chip tone={state.tone}>{state.label}</Chip></dd>
          <dt>Купит</dt><dd>~{price(plan.qty)} {coin} · {usd(plan.cost)} $</dd>
          <dt>Стоп</dt><dd>{price(plan.stop)} (−{pct(plan.stopPct)})</dd>
        </dl>
      ) : (
        <Empty title={`Бот не держит ${coin}`}>Сейчас: {state.label.toLowerCase()}. Бот войдёт сам, когда появится сигнал.</Empty>
      )}
    </Card>
  );
}

function MyTrades({ coin, status: s, ownQty, price: px }: { coin: string; status: Status; ownQty: number; price: number | undefined }) {
  const orders = (s.orders ?? []).filter((o) => o.coin === coin);
  return (
    <Card title="Мои сделки" aside={ownQty > 0 && px ? <span className="muted small num">{price(ownQty)} {coin} ≈ {usd(ownQty * px)} $</span> : undefined}>
      {orders.length === 0
        ? <Empty title="Вы ещё не торговали этой монетой">Кнопки «Купить» и «Продать» — внизу. Бот эти сделки не трогает.</Empty>
        : (
          <div className="list">
            {orders.map((o) => (
              <div key={o.id} className="list-row trade">
                <Chip tone={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Покупка" : "Продажа"}</Chip>
                <div className="row-main">
                  <strong className="num">{price(o.qty)} {coin}</strong>
                  <span className="muted small">по {price(o.price)} · {dateTime(o.ts)}</span>
                </div>
                <strong className="num">{usd(o.usdt)} $</strong>
              </div>
            ))}
          </div>
        )}
    </Card>
  );
}

function Indicators({ coin, status: s }: { coin: string; status: Status }) {
  const sig = s.signals[coin];
  const set = s.settings;
  const gap = sig ? emaGap(sig) : null;
  if (!sig || sig.error || sig.price == null) return <Card><Empty title="Нет данных бота по этой монете" /></Card>;
  return (
    <Card title="Что видит бот">
      <div className="tiles tiles-2">
        <Tile label={`EMA ${set.ema_fast}`} value={price(sig.ema_fast)} />
        <Tile label={`EMA ${set.ema_slow}`} value={price(sig.ema_slow)} />
        <Tile label="Разрыв EMA" value={gap == null ? "—" : pct(gap, true)} tone={gap == null ? undefined : tone(gap)} />
        <Tile label={`Рост за ${set.trend_days} дн`} value={sig.momentum == null ? "—" : pct(sig.momentum * 100, true)}
          tone={sig.momentum == null ? undefined : tone(sig.momentum)}
          hint={set.trend_filter ? (sig.trend_ok ? "проходит фильтр" : "не проходит фильтр") : "фильтр выключен"} />
        <Tile label="ATR" value={sig.atr == null ? "—" : price(sig.atr)}
          hint={sig.atr == null ? undefined : `${pct((sig.atr / sig.price) * 100)} от цены`} />
        <Tile label="Монета" value={coin} hint={coinState(sig, false).label} />
      </div>
    </Card>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="sheet-head">
          <strong>{title}</strong>
          <button className="icon-btn btn btn-ghost" aria-label="Закрыть" onClick={onClose}><CloseIcon /></button>
        </header>
        {children}
      </div>
    </div>
  );
}

function OrderSheet({ coin, side, price: px, usdtFree, ownQty, busy, onSide, onClose, onSubmit }: {
  coin: string; side: Side; price: number; usdtFree: number; ownQty: number; busy: boolean;
  onSide: (s: Side) => void; onClose: () => void; onSubmit: (usdt: number) => void;
}) {
  const max = side === "buy" ? usdtFree : ownQty * px;
  const [text, setText] = useState("");
  const usdt = Number(text.replace(/\s/g, "").replace(",", "."));
  const valid = Number.isFinite(usdt) && usdt > 0 && usdt <= max + 1e-9;
  return (
    <Sheet title={`${coin}/USDT · по рынку`} onClose={onClose}>
      <Segmented label="Сторона" options={[["buy", "Купить"], ["sell", "Продать"]]} value={side}
        onChange={(v) => { setText(""); onSide(v as Side); }} />
      <label className="order-field">
        <span className="muted small">Сумма, USDT</span>
        <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} aria-label="Сумма в USDT" />
      </label>
      <div className="order-parts">
        {PARTS.map((p) => (
          <button key={p} className="chip-btn" onClick={() => setText(String(Math.floor((max * p) / 100 * 100) / 100))}>{p}%</button>
        ))}
      </div>
      <dl className="facts">
        <dt>{side === "buy" ? "Доступно" : "Ваших монет"}</dt>
        <dd className="num">{side === "buy" ? `${usd(usdtFree)} USDT` : `${price(ownQty)} ${coin} ≈ ${usd(ownQty * px)} $`}</dd>
        <dt>Получите ≈</dt>
        <dd className="num">{valid ? (side === "buy" ? `${price(usdt / px)} ${coin}` : `${usd(usdt)} USDT`) : "—"}</dd>
      </dl>
      <Button variant={side === "buy" ? "up" : "danger"} disabled={busy || !valid} onClick={() => onSubmit(usdt)}>
        {side === "buy" ? `Купить ${coin}` : `Продать ${coin}`}
      </Button>
      <p className="footnote">Рыночный ордер на споте. Эту покупку бот не ведёт и не продаёт — она ваша.</p>
    </Sheet>
  );
}

function PairPicker({ coins, current, status: s, onPick, onClose }: {
  coins: string[]; current: string; status: Status; onPick: (c: string) => void; onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const tickers = useLiveTickers();
  const list = coins.filter((c) => c.includes(q.trim().toUpperCase()));
  return (
    <Sheet title="Пара" onClose={onClose}>
      <input className="admin-search" type="search" placeholder="Поиск монеты" value={q} autoFocus
        onChange={(e) => setQ(e.target.value)} aria-label="Поиск монеты" />
      <div className="list pair-list">
        {list.map((c) => {
          const t = tickers[c];
          const held = s.positions.some((p) => p.coin === c);
          return (
            <button key={c} className={`list-row tappable${c === current ? " on" : ""}`} onClick={() => onPick(c)}>
              <CoinAvatar coin={c} size={30} tone={held ? "up" : "muted"} />
              <strong className="list-coin">{c}<span className="muted">/USDT</span></strong>
              <span className="num">{t ? price(t.price) : price(s.signals[c]?.price)}</span>
              {t && <Value tone={tone(t.change24h)}>{pct(t.change24h, true)}</Value>}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
