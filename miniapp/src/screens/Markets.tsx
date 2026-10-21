import { useState, type CSSProperties } from "react";
import type { Status } from "../api";
import { Card, Chip, CoinAvatar, Empty, Flash, LiveBadge } from "../components/ui";
import { clock, dateTime, pct, price, tone } from "../format";
import { useNow } from "../hooks";
import { useLiveTickers } from "../live";
import { SIGNAL_FILTERS, emaGap, filterRows, nextCandleClose, signalRows, type SignalFilter } from "../logic";
import { haptic } from "../telegram";

const BAR_SECONDS = 4 * 3600;

/** «Рынки», как у бирж: все пары спота с ценой и изменением за сутки, поиск, фильтры по сигналу бота. */
export function Markets({ status: s, onOpenCoin }: { status: Status; onOpenCoin: (coin: string) => void }) {
  const [filter, setFilter] = useState<SignalFilter>("all");
  const [query, setQuery] = useState("");
  const now = useNow();
  const tickers = useLiveTickers();
  const all = signalRows(s.signals, new Set(s.positions.map((p) => p.coin)));
  const q = query.trim().toUpperCase();
  const rows = filterRows(all, filter).filter((r) => !q || r.coin.includes(q));
  const counts = Object.fromEntries(SIGNAL_FILTERS.map(([f]) => [f, filterRows(all, f).length]));

  return (
    <div className="signals">
      <header className="page-head">
        <h1>Рынки <LiveBadge on={Object.keys(tickers).length > 0} /></h1>
        <span className="muted">
          Спот Bybit · сигналы бота: {s.last_bar ? `свеча закрылась ${dateTime(s.last_bar + BAR_SECONDS)}` : "ждём первой свечи"}
          {" · "}следующая в {clock(nextCandleClose(now))}
        </span>
      </header>

      <input className="admin-search" type="search" placeholder="Поиск монеты" value={query}
        onChange={(e) => setQuery(e.target.value)} aria-label="Поиск монеты" />

      <div className="filters" role="tablist" aria-label="Фильтр">
        {SIGNAL_FILTERS.map(([f, label]) => (
          <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "on" : undefined}
            onClick={() => { haptic(); setFilter(f); }}>
            {label}<span className="count">{counts[f]}</span>
          </button>
        ))}
      </div>

      <Card className="table-card">
        <div className="sig-row sig-head" aria-hidden="true">
          <span>Монета</span><span>Цена</span><span className="col-wide">24 ч</span>
          <span className="col-wide">EMA {s.settings.ema_fast}/{s.settings.ema_slow}</span>
          <span className="col-wide">ATR</span><span>Сигнал бота</span>
        </div>
        {rows.map(({ coin, signal, state }, i) => {
          const gap = emaGap(signal);
          const atrPct = signal.atr && signal.price ? (signal.atr / signal.price) * 100 : null;
          const day = tickers[coin]?.change24h;
          return (
            <button key={coin} className="sig-row tappable" style={{ "--i": i } as CSSProperties} onClick={() => onOpenCoin(coin)}>
              <span className="sig-coin">
                <CoinAvatar coin={coin} tone={state.tone === "muted" ? "muted" : state.tone} size={34} />
                <span className="sig-name">
                  <strong>{coin}</strong>
                  {gap != null && <span className={`small tone-${tone(gap)} narrow-only`}>EMA {pct(gap, true)}</span>}
                </span>
              </span>
              <span className="sig-price">
                <Flash value={signal.price} className="num">{signal.error ? "ошибка" : price(signal.price)}</Flash>
                {day != null && <span className={`small num tone-${tone(day)} narrow-only`}>{pct(day, true)} за 24 ч</span>}
              </span>
              <span className={`num col-wide tone-${day == null ? "neutral" : tone(day)}`}>{day == null ? "—" : pct(day, true)}</span>
              <span className={`num col-wide tone-${gap == null ? "neutral" : tone(gap)}`}>{gap == null ? "—" : pct(gap, true)}</span>
              <span className="num col-wide muted">{atrPct == null ? "—" : pct(atrPct)}</span>
              <span className="sig-state"><Chip tone={state.tone}>{state.label}</Chip></span>
            </button>
          );
        })}
        {rows.length === 0 && <Empty title="Таких монет сейчас нет" />}
      </Card>
      <p className="footnote">Сигналы — результат правил системы, а не рекомендация. EMA — разрыв между средними, ATR — средний размах свечи.</p>
    </div>
  );
}
