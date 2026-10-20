import type { CSSProperties } from "react";
import type { Status } from "../api";
import { Card, CoinAvatar, Empty, Tile, Value } from "../components/ui";
import { dateTime, price, rMultiple, tone, usd } from "../format";
import { REASONS, journalStats } from "../logic";

const nf = (x: number) => x.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Journal({ status: s }: { status: Status }) {
  const st = journalStats(s.trades);
  return (
    <div className="journal">
      <header className="page-head">
        <h1>Журнал</h1>
        <span className="muted">Закрытые сделки и всё, что делал бот</span>
      </header>

      <div className="tiles tiles-6">
        <Tile label="Сделок" value={st.count} hint={`открыто: ${s.positions.length}`} />
        <Tile label="Прибыльных" value={st.winRate == null ? "—" : `${Math.round(st.winRate)}%`} />
        <Tile label="Итог" value={`${usd(st.pnl, true)} $`} tone={tone(st.pnl)} />
        <Tile label="Средний R" value={st.avgR == null ? "—" : rMultiple(st.avgR)} tone={st.avgR == null ? undefined : tone(st.avgR)} />
        <Tile label="Profit factor" value={st.profitFactor == null ? "—" : nf(st.profitFactor)} />
        <Tile label="Риск на сделку" value={`${nf(s.settings.risk_pct)}%`} hint={`стоп ${s.settings.atr_mult}×ATR`} />
      </div>

      <div className="journal-grid">
        <Card title="Сделки" className="trades">
          {s.trades.length === 0 && <Empty title="Закрытых сделок пока нет" />}
          <div className="list">
            {s.trades.map((t, i) => (
              <div key={t.id} className="list-row trade" style={{ "--i": i } as CSSProperties}>
                <CoinAvatar coin={t.coin} tone={t.pnl_usdt > 0 ? "up" : "down"} size={36} />
                <div className="row-main">
                  <strong>{t.coin}</strong>
                  <span className="muted small">
                    {price(t.entry)} → {price(t.exit)} · {REASONS[t.reason] ?? t.reason} · {dateTime(t.closed_at)}
                  </span>
                </div>
                <div className="row-end">
                  <Value tone={tone(t.pnl_usdt)} bold>{usd(t.pnl_usdt, true)} $</Value>
                  {t.r != null && <Value tone={tone(t.r)}>{rMultiple(t.r)}</Value>}
                </div>
              </div>
            ))}
          </div>
          <p className="footnote">R — результат в долях риска: +2R — заработали вдвое больше, чем рисковали.</p>
        </Card>

        <Card title="События" className="events">
          {s.events.length === 0 && <Empty title="Событий пока нет" />}
          <ol className="timeline">
            {s.events.slice(0, 30).map((e, i) => (
              <li key={e.id} className={`ev-${e.level}`} style={{ "--i": i } as CSSProperties}>
                <span className="muted small">{dateTime(e.ts)}</span>
                <span>{e.text}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
