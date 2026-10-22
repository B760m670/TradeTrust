// P2P владельца: спред по вашим фильтрам, лучшие объявления, ваши ордера и статистика. Только просмотр —
// покупать, продавать и отпускать монеты по-прежнему в Bybit: перед отпуском USDT деньги нужно увидеть в банке.
import { useEffect, useState } from "react";
import { api, type P2PAd, type P2PLedger, type P2POrder, type P2PPrefs, type P2PView } from "../api";
import { Card, Chip, Empty, Segmented, Skeleton, Tile } from "../components/ui";
import { compact, dateTime, pct, price } from "../format";
import { haptic, prefs as store } from "../telegram";

const REFRESH_MS = 20_000;
const SYMBOL: Record<string, string> = { RUB: "₽", USD: "$", KZT: "₸", EUR: "€" };
// крупные суммы в плитках — коротко: 2,9 млн ₽
const short = (x: number, cur: string) => (x >= 1e6 ? `${compact(x)} ${SYMBOL[cur] ?? cur}` : money(x, cur));
// спреды в P2P — доли процента, поэтому два знака
const pp = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(2).replace(".", ",")}%`;
const money = (x: number, cur: string) => `${x.toLocaleString("ru-RU", { maximumFractionDigits: x >= 1000 ? 0 : 2 })} ${SYMBOL[cur] ?? cur}`;

function useP2P(currency: string | null) {
  const [data, setData] = useState<P2PView | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.p2p(currency ?? undefined).then((d) => alive && setData(d), (e: Error) =>
      alive && setData({ available: true, error: e.message }));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(t); };
  }, [currency, tick]);
  return { data, reload: () => setTick((t) => t + 1) };
}

export function P2P() {
  const [currency, setCurrency] = useState<string | null>(() => store.getLocal("p2p_currency"));
  const { data, reload } = useP2P(currency);
  const cur = data?.currency ?? currency ?? "RUB";
  const pick = (c: string) => { setCurrency(c); store.set("p2p_currency", c); };

  if (!data) return <div className="p2p"><Skeleton height={220} /></div>;
  if (!data.available) {
    return (
      <Empty title="P2P не подключён">
        {data.problems?.map((p) => <p key={p} className="tone-amber">⚠️ {p}</p>)}
        Добавьте в <code>/opt/tradetrust/.env</code> строку <code>BYBIT_P2P=1</code> и перезапустите бота. Нужен ключ
        реального счёта с правами P2P «только просмотр» и статус рекламодателя на Bybit.
      </Empty>
    );
  }
  const m = data.market;
  return (
    <div className="p2p">
      <header className="p2p-head">
        <div>
          <h2>P2P · USDT</h2>
          <span className="muted small">только просмотр · сделки и отпуск монет — в Bybit</span>
        </div>
        {data.currencies && data.currencies.length > 1 && (
          <Segmented label="Валюта" options={data.currencies.map((c) => [c, c] as [string, string])} value={cur} onChange={pick} />
        )}
      </header>

      {data.error && <Card className="p2p-error"><strong>Нет данных P2P</strong><p className="small">{data.error}</p></Card>}
      {data.account && (
        <div className="tiles tiles-3">
          <Tile label="Профиль" value={data.account.nickName ?? "—"} />
          <Tile label="Выполнено за 30 дн" value={data.account.recentRate != null ? `${data.account.recentRate}%` : "—"} />
          <Tile label="Ордеров за 30 дн" value={data.account.recentFinishCount ?? "—"} />
        </div>
      )}
      {m && <Spread market={m} currency={cur} />}
      {m && <Filters market={m} currency={cur} onSaved={reload} />}
      {data.pending && <Orders orders={data.pending} />}
      {m && (
        <div className="p2p-books">
          <Book title="Продают USDT — вы покупаете" ads={m.asks} currency={cur} names={m.payments} />
          <Book title="Покупают USDT — вы продаёте" ads={m.bids} currency={cur} names={m.payments} />
        </div>
      )}
      {data.ledger && m && <Cards ledger={data.ledger} prefs={m.prefs} currency={cur} onSaved={reload} />}
      {data.stats && <Stats stats={data.stats} />}
    </div>
  );
}

function Spread({ market: m, currency }: { market: NonNullable<P2PView["market"]>; currency: string }) {
  const amount = m.prefs.amount;
  const profit = m.maker_pct != null && amount ? amount * m.maker_pct / 100 : null;
  return (
    <Card title="Спред сейчас" aside={<span className="muted small">по вашим фильтрам</span>}>
      <div className="tiles tiles-2">
        <Tile label="Вам продадут по" value={m.ask != null ? money(m.ask, currency) : "—"} hint="лучший продавец" />
        <Tile label="У вас купят по" value={m.bid != null ? money(m.bid, currency) : "—"} hint="лучший покупатель" />
        <Tile label="Круг через свои объявления, чистыми" value={m.maker_pct != null ? pp(m.maker_pct) : "—"}
          tone={m.maker_pct == null ? undefined : m.maker_pct > 0 ? "up" : "down"}
          hint={`${m.gross_pct != null ? `до расходов ${pp(m.gross_pct)}, расходы ${pp(m.costs_pct).replace("+", "")}` : ""}${profit != null ? ` · на ${money(amount, currency)} ≈ ${money(profit, currency)}` : ""}`} />
        <Tile label="Сразу по чужим объявлениям" value={m.taker_pct != null ? pp(m.taker_pct) : "—"}
          tone={m.taker_pct == null ? undefined : m.taker_pct > 0 ? "up" : "down"} hint="купить и тут же продать" />
      </div>
      <p className="muted small p2p-note">
        Круг через объявления: вы покупаете USDT по цене лучших покупателей и продаёте по цене лучших продавцов.
        Цены меняются, а ордера приходят не сразу — это ориентир, а не гарантия.
      </p>
    </Card>
  );
}

function Filters({ market: m, currency, onSaved }: { market: NonNullable<P2PView["market"]>; currency: string; onSaved: () => void }) {
  const [p, setP] = useState<P2PPrefs>(m.prefs);
  const [saving, setSaving] = useState(false);
  useEffect(() => setP(m.prefs), [currency]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (changes: Partial<P2PPrefs>) => {
    const next = { ...p, ...changes };
    setP(next);
    setSaving(true);
    try {
      await api.p2pPrefs(currency, changes);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  const toggle = (id: string) => {
    haptic();
    void save({ payments: p.payments.includes(id) ? p.payments.filter((x) => x !== id) : [...p.payments, id] });
  };
  return (
    <Card title="Фильтры" aside={saving ? <span className="muted small">сохраняю…</span> : undefined}>
      <div className="p2p-fields">
        <label>Сумма сделки, {SYMBOL[currency] ?? currency}
          <input type="number" inputMode="decimal" min={0} defaultValue={p.amount || ""} placeholder="любая" key={`a${currency}`}
            onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== p.amount) void save({ amount: v }); }} />
        </label>
        <label>Выполнение не ниже, %
          <input type="number" inputMode="numeric" min={0} max={100} defaultValue={p.min_rate} key={`r${currency}`}
            onBlur={(e) => { const v = Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))); if (v !== p.min_rate) void save({ min_rate: v }); }} />
        </label>
        <label>Комиссия мейкера: покупка, %
          <input type="number" inputMode="decimal" min={0} max={5} step={0.005} defaultValue={p.fee_buy_pct} key={`fb${currency}`}
            onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== p.fee_buy_pct) void save({ fee_buy_pct: v }); }} />
        </label>
        <label>Комиссия мейкера: продажа, %
          <input type="number" inputMode="decimal" min={0} max={5} step={0.005} defaultValue={p.fee_sell_pct} key={`fs${currency}`}
            onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== p.fee_sell_pct) void save({ fee_sell_pct: v }); }} />
        </label>
        <label>Банк, сеть, прочее на круг, %
          <input type="number" inputMode="decimal" min={0} max={10} step={0.01} defaultValue={p.extra_pct} key={`fx${currency}`}
            onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== p.extra_pct) void save({ extra_pct: v }); }} />
        </label>
        <label>Уведомить при чистом спреде от, %
          <input type="number" inputMode="decimal" min={0} max={50} step={0.1} defaultValue={p.alert_pct || ""} placeholder="выкл" key={`s${currency}`}
            onBlur={(e) => { const v = Math.max(0, Number(e.target.value) || 0); if (v !== p.alert_pct) void save({ alert_pct: v }); }} />
        </label>
      </div>
      <div className="p2p-pays" role="group" aria-label="Способы оплаты">
        {m.payments.map((x) => (
          <button key={x.id} className={p.payments.includes(x.id) ? "on" : undefined} aria-pressed={p.payments.includes(x.id)}
            onClick={() => toggle(x.id)} title={`объявлений: ${x.ads}`}>{x.name}</button>
        ))}
      </div>
      <p className="muted small p2p-note">
        Названия видны у способов, которые есть в вашем профиле Bybit; остальные — номером. Пустой выбор — все способы.
        Комиссию мейкера сверьте в кабинете Bybit: в объявлениях сейчас {m.ad_fee_pct ? pct(m.ad_fee_pct) : "не указана"}.
      </p>
    </Card>
  );
}

function Book({ title, ads, currency, names }: { title: string; ads: P2PAd[]; currency: string; names: { id: string; name: string }[] }) {
  const name = (id: string) => names.find((n) => n.id === id)?.name ?? `#${id}`;
  return (
    <Card title={title}>
      {ads.length === 0 ? <Empty title="Нет подходящих объявлений">Ослабьте фильтры: сумму, способы оплаты или процент выполнения.</Empty> : (
        <div className="list">
          {ads.map((a) => (
            <div key={a.id} className="list-row p2p-ad">
              <div className="row-main">
                <strong className="num">{money(a.price, currency)}</strong>
                <span className="muted small">{a.nick} · {a.orders} сделок · {a.rate}%</span>
              </div>
              <div className="p2p-ad-side">
                <span className="small num">{money(a.min_amount, currency)} – {money(a.max_amount, currency)}</span>
                <span className="faint small">{a.payments.slice(0, 2).map(name).join(", ")}{a.payments.length > 2 ? ` +${a.payments.length - 2}` : ""}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Orders({ orders }: { orders: P2POrder[] }) {
  return (
    <Card title="Ваши ордера в процессе" aside={<span className="muted small">{orders.length}</span>}>
      {orders.length === 0 ? <Empty title="Открытых ордеров нет">Когда появятся, бот пришлёт уведомление в Telegram.</Empty> : (
        <div className="list">
          {orders.map((o) => (
            <div key={o.id} className="list-row trade">
              <Chip tone={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Покупка" : "Продажа"}</Chip>
              <div className="row-main">
                <strong className="num">{price(o.qty)} {o.token} · {money(o.amount, o.currency)}</strong>
                <span className="muted small">{o.status_text} · {o.who} · {dateTime(Math.floor(o.created / 1000))}</span>
              </div>
            </div>
          ))}
        </div>
      )}
      {orders.some((o) => o.status === 20 && o.side === "sell") && (
        <p className="tone-down small p2p-note">Перед тем как отпустить USDT, проверьте поступление в банке от того же человека, что указан в ордере.</p>
      )}
    </Card>
  );
}

/** Карты и лимиты: сколько прошло через каждый способ оплаты сегодня и за месяц, сколько разных людей,
 *  предупреждения у ваших лимитов; журнал всех сделок — файлом в Telegram. */
function Cards({ ledger: l, prefs, currency, onSaved }: { ledger: P2PLedger; prefs: P2PPrefs; currency: string; onSaved: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const setLimit = async (pay: string, period: "day" | "month", value: number) => {
    const limits = { ...prefs.limits, [pay]: { ...prefs.limits[pay], [period]: value } };
    await api.p2pPrefs(currency, { limits });
    onSaved();
  };
  const journal = async () => {
    haptic();
    setBusy(true);
    try {
      setNote((await api.p2pJournal()).message);
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cap = l.month_cap;
  return (
    <Card title="Карты и лимиты" aside={<span className="muted small">месяц {l.month}</span>}>
      <div className="tiles tiles-3">
        <Tile label="Оборот за месяц" value={short(l.turnover, currency)}
          hint={cap ? `из ${short(cap, currency)} · ${Math.round((l.turnover / cap) * 100)}%` : undefined}
          tone={cap && l.turnover >= cap * 0.8 ? "down" : undefined} />
        <Tile label="Людей сегодня" value={l.people_day} />
        <Tile label="Людей за месяц" value={l.people_month} />
      </div>
      {l.warnings.map((w) => <p key={w.key} className="small tone-down p2p-note">⚠️ {w.text}</p>)}
      {l.cards.length === 0 ? <p className="muted small p2p-note">Завершённых ордеров в этом месяце нет.</p> : (
        <div className="list">
          {l.cards.map((c) => (
            <div key={c.pay} className="list-row p2p-card">
              <div className="row-main">
                <strong>{c.name}</strong>
                <span className="muted small">сегодня: пришло {money(c.day_in, currency)}, ушло {money(c.day_out, currency)}</span>
                <span className="muted small">месяц: пришло {money(c.month_in, currency)}, ушло {money(c.month_out, currency)} · людей {c.people}</span>
              </div>
              <div className="p2p-limits">
                <label>лимит/день<input type="number" inputMode="numeric" min={0} defaultValue={c.limit.day || ""} placeholder="—"
                  onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== (c.limit.day ?? 0)) void setLimit(c.pay, "day", v); }} /></label>
                <label>лимит/мес<input type="number" inputMode="numeric" min={0} defaultValue={c.limit.month || ""} placeholder="—"
                  onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== (c.limit.month ?? 0)) void setLimit(c.pay, "month", v); }} /></label>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="p2p-fields p2p-cap">
        <label>Порог месячного оборота, {SYMBOL[currency] ?? currency}
          <input type="number" inputMode="numeric" min={0} defaultValue={cap || ""} placeholder="выкл" key={`cap${currency}`}
            onBlur={(e) => { const v = Number(e.target.value) || 0; if (v !== cap) void api.p2pPrefs(currency, { month_cap: v }).then(onSaved); }} />
        </label>
      </div>
      <button className="btn" disabled={busy} onClick={journal}>{busy ? "Готовлю журнал…" : "Прислать журнал сделок в Telegram"}</button>
      {note && <p className="muted small p2p-note">{note}</p>}
      <p className="muted small p2p-note">
        Лимиты — по обороту через способ оплаты (пришло + ушло). Предупреждение приходит в Telegram при 80%, один раз за день или месяц.
        Журнал — все завершённые ордера за полгода с результатом продаж по FIFO, для учёта и 3-НДФЛ.
      </p>
    </Card>
  );
}

function Stats({ stats }: { stats: Record<string, import("../api").P2PStats> }) {
  const rows = Object.entries(stats);
  return (
    <Card title="Итоги за 30 дней" aside={<span className="muted small">завершённые ордера</span>}>
      {rows.length === 0 ? <Empty title="Завершённых ордеров нет" /> : rows.map(([cur, s]) => (
        <div key={cur} className="tiles tiles-2">
          <Tile label={`Куплено, ${cur}`} value={`${price(s.buy_qty)} USDT`} hint={s.buy_price ? `в среднем по ${money(s.buy_price, cur)}` : undefined} />
          <Tile label={`Продано, ${cur}`} value={`${price(s.sell_qty)} USDT`} hint={s.sell_price ? `в среднем по ${money(s.sell_price, cur)}` : undefined} />
          <Tile label="Прибыль на круге" value={money(s.profit, cur)} tone={s.profit > 0 ? "up" : s.profit < 0 ? "down" : undefined}
            hint="на объёме, который и купили, и продали" />
          <Tile label="Ордеров" value={s.orders} />
        </div>
      ))}
    </Card>
  );
}
