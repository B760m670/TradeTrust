import { Cell, Section } from "@telegram-apps/telegram-ui";
import type { Status } from "../api";
import { Chip } from "../components/ui";
import { dateTime, price } from "../format";
import { signalRows } from "../logic";

const BAR_SECONDS = 4 * 3600;

export function Signals({ status: s, onOpenCoin }: { status: Status; onOpenCoin: (coin: string) => void }) {
  const rows = signalRows(s.signals, new Set(s.positions.map((p) => p.coin)));
  const header = s.last_bar ? `Свеча 4ч закрылась ${dateTime(s.last_bar + BAR_SECONDS)}` : "Ждём закрытия первой свечи";
  return (
    <Section header={header} footer="Сигналы — результат правил системы, а не рекомендация.">
      {rows.length === 0 && <Cell>Данных пока нет</Cell>}
      {rows.map(({ coin, signal, state }) => (
        <Cell key={coin} onClick={() => onOpenCoin(coin)}
          subtitle={signal.error ? "ошибка загрузки" : price(signal.price)}
          after={<Chip tone={state.tone}>{state.label}</Chip>}>
          {coin}
        </Cell>
      ))}
    </Section>
  );
}
