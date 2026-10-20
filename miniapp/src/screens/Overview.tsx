import { Button, Cell, LargeTitle, Section, SegmentedControl } from "@telegram-apps/telegram-ui";
import { api, type Mode, type Status } from "../api";
import { Chip, Value } from "../components/ui";
import { clock, dateTime, pct, price, tone, usd } from "../format";
import { ENV_LABELS } from "../logic";
import { confirmAction } from "../telegram";

const MODES: [Mode, string][] = [["signals", "Сигналы"], ["confirm", "Вручную"], ["auto", "Авто"]];

interface Props {
  status: Status;
  busy: boolean;
  act: (a: () => Promise<{ message: string }>) => void;
  onOpenCoin: (coin: string) => void;
}

export function Overview({ status: s, busy, act, onOpenCoin }: Props) {
  const env = ENV_LABELS[s.env] ?? { label: s.env, real: false };

  const setMode = async (mode: Mode) => {
    if (mode === s.mode) return;
    if (mode === "auto" && !(await confirmAction("Бот будет сам покупать по сигналам, без подтверждения. Включить?"))) return;
    act(() => api.setMode(mode));
  };

  return (
    <>
      <Section>
        <div className="account">
          <Chip tone={env.real ? "down" : "accent"}>{env.label}</Chip>
          <LargeTitle weight="1" className="equity">{usd(s.equity.total)} <span className="unit">USDT</span></LargeTitle>
          <div className="hint">
            свободно {usd(s.equity.free)} · в позициях <Value tone={tone(s.equity.unrealized)}>{usd(s.equity.unrealized, true)}</Value>
          </div>
          <SegmentedControl className="modes">
            {MODES.map(([key, label]) => (
              <SegmentedControl.Item key={key} selected={s.mode === key} disabled={busy} onClick={() => void setMode(key)}>
                {label}
              </SegmentedControl.Item>
            ))}
          </SegmentedControl>
        </div>
        <Cell
          multiline
          subtitle={s.paused ? `Пауза: ${s.paused}` : "Стопы и выходы работают всегда"}
          after={
            <Button size="s" mode="bezeled" disabled={busy}
              onClick={() => act(s.paused ? api.resume : api.pause)}>
              {s.paused ? "Продолжить" : "Пауза"}
            </Button>
          }
        >
          {s.paused ? <Value tone="neutral">⏸ Новые сделки на паузе</Value> : <Value tone="up">▶ Работает</Value>}
        </Cell>
      </Section>

      {s.proposals.length > 0 && (
        <Section header="Ждут подтверждения">
          {s.proposals.map((p) => (
            <div key={p.id} className="proposal">
              <Cell multiline after={<Chip tone="muted">до {clock(p.expires_at)}</Chip>}
                subtitle={`Купить ${price(p.qty)} ${p.coin} ≈ ${usd(p.qty * p.price)} $ · риск ${usd(p.risk_usdt)} $`}
                description={`Цена ~${price(p.price)} · стоп ${price(p.stop)} (−${pct((1 - p.stop / p.price) * 100)})`}>
                <Value tone="up" bold>ВХОД {p.coin}</Value>
              </Cell>
              <div className="actions">
                <Button stretched size="m" mode="filled" className="buy" disabled={busy} onClick={() => act(() => api.confirm(p.id))}>
                  Купить
                </Button>
                <Button stretched size="m" mode="gray" disabled={busy} onClick={() => act(() => api.reject(p.id))}>
                  Пропустить
                </Button>
              </div>
            </div>
          ))}
        </Section>
      )}

      <Section header="Позиции" footer={s.positions.length ? undefined : "Открытых позиций нет — бот ждёт сигнала."}>
        {s.positions.map((p) => {
          const change = (p.price / p.entry - 1) * 100;
          return (
            <Cell key={p.coin} onClick={() => onOpenCoin(p.coin)} multiline
              subtitle={`${price(p.qty)} шт · ${price(p.entry)} → ${price(p.price)}`}
              description={`стоп ${price(p.stop)} · до стопа ${pct((1 - p.stop / p.price) * 100)} · с ${dateTime(p.opened_at)}`}
              after={
                <div className="right">
                  <Value tone={tone(p.pnl_usdt)} bold>{usd(p.pnl_usdt, true)} $</Value>
                  <Value tone={tone(change)}>{pct(change, true)}</Value>
                </div>
              }>
              {p.coin}
            </Cell>
          );
        })}
      </Section>
    </>
  );
}
