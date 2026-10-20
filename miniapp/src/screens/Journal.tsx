import { Cell, Section } from "@telegram-apps/telegram-ui";
import type { Status } from "../api";
import { Stat, Value } from "../components/ui";
import { dateTime, price, rMultiple, tone, usd } from "../format";
import { REASONS, journalStats } from "../logic";

export function Journal({ status: s }: { status: Status }) {
  const st = journalStats(s.trades);
  const nf = (x: number) => x.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (
    <>
      <div className="stats">
        <Stat value={st.count} label="сделок" />
        <Stat value={st.winRate == null ? "—" : `${Math.round(st.winRate)}%`} label="прибыльных" />
        <Stat value={usd(st.pnl, true)} label="итог, $" tone={tone(st.pnl)} />
        <Stat value={st.avgR == null ? "—" : rMultiple(st.avgR)} label="средний R" tone={st.avgR == null ? undefined : tone(st.avgR)} />
        <Stat value={st.profitFactor == null ? "—" : nf(st.profitFactor)} label="profit factor" />
        <Stat value={s.positions.length} label="открыто" />
      </div>
      <Section header="Сделки" footer="R — результат в долях риска: +2R — заработали вдвое больше, чем рисковали.">
        {s.trades.length === 0 && <Cell>Закрытых сделок пока нет</Cell>}
        {s.trades.map((t) => (
          <Cell key={t.id}
            subtitle={`${price(t.entry)} → ${price(t.exit)} · ${REASONS[t.reason] ?? t.reason} · ${dateTime(t.closed_at)}`}
            after={
              <div className="right">
                <Value tone={tone(t.pnl_usdt)} bold>{usd(t.pnl_usdt, true)} $</Value>
                {t.r != null && <Value>{rMultiple(t.r)}</Value>}
              </div>
            }>
            {t.coin}
          </Cell>
        ))}
      </Section>
      <Section header="События">
        {s.events.slice(0, 25).map((e) => (
          <Cell key={e.id} multiline subhead={dateTime(e.ts)}>
            <span className={e.level === "error" ? "tone-down" : undefined}>{e.text}</span>
          </Cell>
        ))}
      </Section>
    </>
  );
}
