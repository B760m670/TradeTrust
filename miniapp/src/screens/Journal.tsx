import { useMemo, type CSSProperties } from "react";
import type { Status } from "../api";
import { EquityChart } from "../components/EquityChart";
import { Card, CoinAvatar, Empty, Tile, Value } from "../components/ui";
import { dateTime, pct, price, rMultiple, tone, usd } from "../format";
import { REASONS, journalStats, maxDrawdown } from "../logic";

const nf = (x: number) => x.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function Journal({ status: s, embedded }: { status: Status; embedded?: boolean }) {
  const st = journalStats(s.trades);
  const total = Math.round(s.equity.total * 100) / 100;
  // история с сервера плюс текущий капитал (с живыми ценами) последней точкой
  const points = useMemo<[number, number][]>(() => {
    const history = s.equity_history ?? [];
    const last = history[history.length - 1];
    const now = Math.floor(Date.now() / 1000);
    return last && now <= last[0] ? history : [...history, [now, total]];
  }, [s.equity_history, total]);
  const values = points.map(([, v]) => v);
  const change = values.length > 1 ? (values[values.length - 1] / values[0] - 1) * 100 : null;
  return (
    <div className="journal">
      {!embedded && (
        <header className="page-head">
          <h1>Журнал</h1>
          <span className="muted">Закрытые сделки и всё, что делал бот</span>
        </header>
      )}

      <Card title="Капитал бота" className="equity-card" aside={change == null ? undefined
        : <span className={`pill pill-${tone(change)}`}>{pct(change, true)} за {Math.max(1, Math.round((points[points.length - 1][0] - points[0][0]) / 86400))} дн.</span>}>
        {points.length > 1
          ? <div className="equity-area"><EquityChart points={points} /></div>
          : <Empty title="График появится после первых свечей">Бот записывает капитал после каждой 4-часовой свечи.</Empty>}
        <div className="equity-foot">
          <span>Сейчас <strong className="num">{usd(total)} $</strong></span>
          <span>Худшая просадка <strong className={`num tone-${values.length > 1 && maxDrawdown(values) < 0 ? "down" : "neutral"}`}>
            {pct(maxDrawdown(values))}</strong></span>
        </div>
      </Card>

      <div className="tiles tiles-6">
        <Tile label="Сделок" value={st.count} hint={`открыто: ${s.positions.length}`} />
        <Tile label="Прибыльных" value={st.winRate == null ? "—" : `${Math.round(st.winRate)}%`} />
        <Tile label="Итог" value={`${usd(st.pnl, true)} $`} tone={tone(st.pnl)} />
        <Tile label="Средний R" value={st.avgR == null ? "—" : rMultiple(st.avgR)} tone={st.avgR == null ? undefined : tone(st.avgR)} />
        <Tile label="Profit factor" value={st.profitFactor == null ? "—" : nf(st.profitFactor)} />
        <Tile label="Риск на сделку" value={`${nf(s.settings.risk_pct)}%`} hint={`стоп ${s.settings.atr_mult}×ATR`} />
      </div>

      <div className="journal-grid">
        <Card title="Сделки бота" className="trades">
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

        <Card title="Действия бота" className="events">
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
