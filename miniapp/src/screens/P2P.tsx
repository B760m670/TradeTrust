// P2P владельца: спред по вашим фильтрам, лучшие объявления, ваши ордера и статистика. Только просмотр —
// покупать, продавать и отпускать монеты по-прежнему в Bybit: перед отпуском USDT деньги нужно увидеть в банке.
import { useEffect, useState } from "react";
import { api, type P2PAd, type P2PLedger, type P2PMyAd, type P2PNotify, type P2POrder, type P2PPrefs, type P2PView } from "../api";
import { ChevronIcon } from "../components/icons";
import { Card, Chip, Empty, Segmented, Skeleton, Tabs, Tile } from "../components/ui";
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

type Section = "market" | "mine" | "cards" | "stats";

export function P2P() {
  const [currency, setCurrency] = useState<string | null>(() => store.getLocal("p2p_currency"));
  const [section, setSection] = useState<Section>(() => (store.getLocal("p2p_tab") as Section | null) ?? "market");
  const { data, reload } = useP2P(currency);
  const cur = data?.currency ?? currency ?? "RUB";
  const pick = (c: string) => { setCurrency(c); store.set("p2p_currency", c); };
  const open = (t: Section) => { setSection(t); store.set("p2p_tab", t); };

  if (!data) return <div className="p2p"><Skeleton height={180} /><Skeleton height={260} /></div>;
  if (!data.available) {
    return (
      <Empty title="P2P не подключён">
        {data.problems?.map((p) => <p key={p} className="tone-amber">⚠️ {p}</p>)}
        Добавьте в <code>/opt/tradetrust/.env</code> строку <code>BYBIT_P2P=1</code> и перезапустите бота. Нужен ключ
        с правами P2P «только просмотр» и статус мейкера на Bybit.
      </Empty>
    );
  }
  const m = data.market;
  const pending = data.pending ?? [];
  const waiting = pending.filter((o) => o.status === 20 && o.side === "sell").length;
  return (
    <div className="p2p">
      <Hero data={data} currency={cur} onCurrency={pick} />
      {data.error && <Card className="p2p-error"><strong>Нет данных P2P</strong><p className="small">{data.error}</p></Card>}
      {waiting > 0 && (
        <button className="p2p-alert" onClick={() => open("mine")}>
          <span className="p2p-pulse" aria-hidden="true" />
          <span className="row-main"><strong>Покупатель отметил оплату{waiting > 1 ? ` · ${waiting}` : ""}</strong>
            <span className="small">Проверьте поступление в банке от того же человека, потом отпустите USDT в Bybit</span></span>
          <ChevronIcon size={16} />
        </button>
      )}
      <Tabs label="Разделы P2P" value={section} onChange={open} options={[
        ["market", "Рынок"], ["mine", `Мои${pending.length ? ` · ${pending.length}` : ""}`], ["cards", "Карты"], ["stats", "Итоги"],
      ]} />
      {section === "market" && m && (
        <>
          <Spread market={m} currency={cur} />
          <AdCalc market={m} currency={cur} />
          <div className="p2p-books">
            <Book title="Продают USDT" hint="вы покупаете у них" ads={m.asks} currency={cur} names={m.payments} side="ask" />
            <Book title="Покупают USDT" hint="вы продаёте им" ads={m.bids} currency={cur} names={m.payments} side="bid" />
          </div>
          <details className="card p2p-more">
            <summary>Фильтры и комиссии</summary>
            <Filters market={m} currency={cur} onSaved={reload} />
          </details>
        </>
      )}
      {section === "mine" && (
        <>
          <MyAds ads={data.my_ads ?? []} />
          <Orders orders={pending} />
          <NotifyMode value={data.notify ?? "important"} currency={cur} onSaved={reload} />
        </>
      )}
      {section === "cards" && data.ledger && m && <Cards ledger={data.ledger} prefs={m.prefs} currency={cur} onSaved={reload} />}
      {section === "stats" && data.stats && <Stats stats={data.stats} />}
    </div>
  );
}

/** Шапка: профиль мейкера, ключевые цифры и прогресс до следующего уровня. */
function Hero({ data, currency, onCurrency }: { data: P2PView; currency: string; onCurrency: (c: string) => void }) {
  const a = data.account;
  const lv = data.level;
  const next = lv?.levels.find((l) => l.name === lv.next);
  const current = lv ? [...lv.levels].reverse().find((l) => l.done)?.name ?? "Новый" : null;
  return (
    <section className="p2p-hero">
      <div className="p2p-hero-top">
        <span className="p2p-ava" aria-hidden="true">{(a?.nickName ?? "P").slice(0, 1).toUpperCase()}</span>
        <div className="row-main">
          <strong className="p2p-nick">{a?.nickName ?? "P2P · USDT"}</strong>
          <span className="small muted">{current ? `мейкер · ${current}` : "мейкер"} · только просмотр</span>
        </div>
        {data.currencies && data.currencies.length > 1 && (
          <Segmented label="Валюта" options={data.currencies.map((c) => [c, c] as [string, string])} value={currency} onChange={onCurrency} />
        )}
      </div>
      {a && (
        <div className="p2p-kpis">
          <div><small>Выполнено · 30д</small><b className="num">{a.recentRate != null ? `${a.recentRate}%` : "—"}</b></div>
          <div><small>Ордеров · 30д</small><b className="num">{a.recentFinishCount ?? "—"}</b></div>
          <div><small>Всего</small><b className="num">{a.totalFinishCount ?? "—"}</b></div>
          <div><small>Отпуск, мин</small><b className="num">{minutes(a.averageReleaseTime)}</b></div>
        </div>
      )}
      {lv && next && (
        <div className="p2p-level">
          <div className="p2p-level-head">
            <span className="small">До уровня <b>«{next.name}»</b></span>
            <span className="faint small">{next.perks}</span>
          </div>
          <Progress label="Разных контрагентов" value={lv.counterparties} goal={next.people} />
          <Progress label="Объём за 30 дней, USDT" value={lv.volume_30d} goal={next.volume} />
        </div>
      )}
      {lv && !next && <p className="small tone-up p2p-note">Условия всех уровней выполнены — проверьте статус в Bybit.</p>}
    </section>
  );
}

const minutes = (x: number | string | undefined) => {
  const v = Number(x);
  return x == null || x === "" || !Number.isFinite(v) ? "—" : v.toLocaleString("ru-RU", { maximumFractionDigits: 1 });
};

function Progress({ label, value, goal }: { label: string; value: number; goal: number }) {
  const share = goal ? Math.min(1, value / goal) : 1;
  return (
    <div className={`p2p-progress${share >= 1 ? " done" : ""}`}>
      <div className="p2p-progress-text">
        <span className="small muted">{label}</span>
        <span className="small num"><b>{value.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}</b> / {goal.toLocaleString("ru-RU")}</span>
      </div>
      <div className="p2p-bar"><i style={{ width: `${share * 100}%` }} /></div>
    </div>
  );
}

function Spread({ market: m, currency }: { market: NonNullable<P2PView["market"]>; currency: string }) {
  const amount = m.prefs.amount;
  const profit = m.maker_pct != null && amount ? amount * m.maker_pct / 100 : null;
  const gap = m.ask != null && m.bid != null ? m.ask - m.bid : null;
  return (
    <Card title="Стакан сейчас" aside={<span className="muted small">по вашим фильтрам</span>}>
      <div className="p2p-quote">
        <div className="p2p-side ask"><small>Продают от</small><b className="num">{m.ask != null ? money(m.ask, currency) : "—"}</b>
          <span className="faint small">вы покупаете</span></div>
        <div className="p2p-gap"><span className="small muted">разница</span>
          <b className="num">{gap != null ? money(Math.abs(gap), currency) : "—"}</b></div>
        <div className="p2p-side bid"><small>Покупают до</small><b className="num">{m.bid != null ? money(m.bid, currency) : "—"}</b>
          <span className="faint small">вы продаёте</span></div>
      </div>
      {m.crossed ? (
        <p className="p2p-warn small">
          ⚠️ Покупают дороже, чем продают. Так бывает, когда в выборку попали разные способы оплаты или лимиты, —
          это не прибыль. Выберите в фильтрах только свои банки и сумму сделки.
        </p>
      ) : (
        <div className="tiles tiles-2">
          <Tile label="Круг через свои объявления" value={m.maker_pct != null ? pp(m.maker_pct) : "—"}
            tone={m.maker_pct == null ? undefined : m.maker_pct > 0 ? "up" : "down"}
            hint={`чистыми, расходы ${pp(m.costs_pct).replace("+", "")}${profit != null ? ` · на ${money(amount, currency)} ≈ ${money(profit, currency)}` : ""}`} />
          <Tile label="Сразу по чужим объявлениям" value={m.taker_pct != null ? pp(m.taker_pct) : "—"}
            tone={m.taker_pct == null ? undefined : m.taker_pct > 0 ? "up" : "down"} hint="купить и тут же продать" />
        </div>
      )}
    </Card>
  );
}

/** Калькулятор объявления: какую цену поставить, каким вы будете в выдаче и сколько останется после комиссии. */
function AdCalc({ market: m, currency }: { market: NonNullable<P2PView["market"]>; currency: string }) {
  const [side, setSide] = useState<"sell" | "buy">("sell");
  const rivals = side === "sell" ? m.asks : m.bids;
  const best = rivals[0]?.price ?? null;
  const [price, setPrice] = useState<string>("");
  const [qty, setQty] = useState<string>("995");
  const p = Number(price.replace(",", ".")) || (best != null ? Math.round((side === "sell" ? best - 0.03 : best + 0.03) * 100) / 100 : 0);
  const q = Number(qty.replace(",", ".")) || 0;
  const fee = (side === "sell" ? m.prefs.fee_sell_pct || m.ad_fee_pct || 0.3 : m.prefs.fee_buy_pct || m.ad_fee_pct || 0.3) / 100;
  const place = rivals.filter((a) => (side === "sell" ? a.price < p : a.price > p)).length + 1;
  // закрыть круг по чужим объявлениям: продали своим — выкупаете у лучшего продавца; купили своим — продаёте лучшему покупателю
  const other = side === "sell" ? m.ask : m.bid;
  const net = side === "sell" ? p * (1 - fee) : p * (1 + fee);
  const perUnit = other != null && p ? (side === "sell" ? net - other : other - net) : null;
  return (
    <Card title="Калькулятор объявления" aside={<Segmented label="Сторона" value={side} onChange={(v) => { setSide(v); setPrice(""); }}
      options={[["sell", "Продаю"], ["buy", "Покупаю"]]} />}>
      <div className="p2p-fields">
        <label>Цена, {SYMBOL[currency] ?? currency}
          <input type="text" inputMode="decimal" value={price} placeholder={p ? String(p).replace(".", ",") : "—"}
            onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label>Количество, USDT
          <input type="text" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
      </div>
      <div className="tiles tiles-3 p2p-calc">
        <Tile label="Место в выдаче" value={rivals.length ? (place > rivals.length ? `ниже ${rivals.length}-го` : `#${place}`) : "—"}
          hint={best != null ? `лучший: ${money(best, currency)}` : "нет конкурентов"} tone={place === 1 ? "up" : undefined} />
        <Tile label={side === "sell" ? "На руки" : "Заплатите"} value={q && p ? money(net * q, currency) : "—"}
          hint={`комиссия ${pct(fee * 100)}`} />
        <Tile label={side === "sell" ? "Выкуп у продавца" : "Продажа покупателю"}
          value={perUnit != null && q ? money(perUnit * q, currency) : "—"}
          tone={perUnit == null ? undefined : perUnit > 0 ? "up" : perUnit < 0 ? "down" : undefined}
          hint={other != null ? `по ${money(other, currency)} · за круг` : undefined} />
      </div>
      <p className="muted small p2p-note">
        {side === "sell"
          ? "Своё объявление на продажу, а USDT обратно — по лучшему чужому объявлению (без комиссии). Место — среди подходящих по вашим фильтрам."
          : "Своё объявление на покупку, а продаёте лучшему покупателю (без комиссии). Объявления на покупку открываются с уровня «Регулярный»."}
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
    <Card title="Фильтры" className="p2p-filters" aside={saving ? <span className="muted small">сохраняю…</span> : undefined}>
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

function Book({ title, hint, ads, currency, names, side }: {
  title: string; hint: string; ads: P2PAd[]; currency: string; names: { id: string; name: string }[]; side: "ask" | "bid";
}) {
  const name = (id: string) => names.find((n) => n.id === id)?.name ?? `#${id}`;
  return (
    <Card title={title} aside={<span className="muted small">{hint}</span>} className={`p2p-book ${side}`}>
      {ads.length === 0 ? <Empty title="Нет подходящих объявлений">Ослабьте фильтры: сумму, способы оплаты или процент выполнения.</Empty> : (
        <div className="list">
          {ads.map((a, i) => (
            <div key={a.id} className="list-row p2p-ad">
              <span className="p2p-rank" aria-hidden="true">{i + 1}</span>
              <div className="row-main">
                <strong className="num p2p-price">{money(a.price, currency)}</strong>
                <span className="muted small">{a.nick} · {a.orders} сд · {a.rate}%</span>
              </div>
              <div className="p2p-ad-side">
                <span className="small num">{compact(a.min_amount)} – {compact(a.max_amount)}</span>
                <span className="faint small">{a.payments.slice(0, 2).map(name).join(", ")}{a.payments.length > 2 ? ` +${a.payments.length - 2}` : ""}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

/** Ваши объявления: цена, место в выдаче, сколько продано, лимиты. Менять их — в Bybit. */
function MyAds({ ads }: { ads: P2PMyAd[] }) {
  return (
    <Card title="Мои объявления" aside={<span className="muted small">{ads.filter((a) => a.online).length} в сети</span>}>
      {ads.length === 0 ? <Empty title="Объявлений нет">Разместите объявление в Bybit: P2P → Ads → «Разместить».</Empty> : (
        <div className="p2p-myads">
          {ads.map((a) => {
            const sold = a.total ? Math.min(1, (a.total - a.left) / a.total) : 0;
            const diff = a.best_rival != null ? a.price - a.best_rival : null;
            return (
              <div key={a.id} className={`p2p-myad ${a.side}${a.online ? "" : " off"}`}>
                <div className="p2p-myad-top">
                  <Chip tone={a.side === "sell" ? "down" : "up"}>{a.side === "sell" ? "Продажа" : "Покупка"}</Chip>
                  <span className={`small ${a.online ? "tone-up" : "muted"}`}>● {a.status_text}</span>
                  <span className="grow" />
                  {a.rank != null && <span className="p2p-place" title="место в выдаче среди всех / среди тех же банков">
                    #{a.rank}{a.rank_pay != null && a.rank_pay !== a.rank ? <small> · #{a.rank_pay} по банкам</small> : null}</span>}
                </div>
                <div className="p2p-myad-price">
                  <b className="num">{money(a.price, a.currency)}</b>
                  {diff != null && <span className={`small ${diff === 0 ? "muted" : (a.side === "sell" ? diff < 0 : diff > 0) ? "tone-up" : "tone-amber"}`}>
                    {diff === 0 ? "как у лучшего" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff), a.currency)} к лучшему конкуренту`}</span>}
                </div>
                <div className="p2p-bar"><i style={{ width: `${sold * 100}%` }} /></div>
                <div className="p2p-myad-meta small muted">
                  <span>{a.side === "sell" ? "продано" : "куплено"} {price(a.total - a.left)} из {price(a.total)} {a.token}</span>
                  <span>{compact(a.min_amount)} – {compact(a.max_amount)} {SYMBOL[a.currency] ?? a.currency}</span>
                </div>
                <div className="p2p-tags">{a.payments.map((x) => <span key={x}>{x}</span>)}{a.fee_pct > 0 && <span className="faint">комиссия {pct(a.fee_pct)}</span>}</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

/** Какие уведомления по ордерам присылать: без дублей приложения Bybit или все. */
function NotifyMode({ value, currency, onSaved }: { value: P2PNotify; currency: string; onSaved: () => void }) {
  const [v, setV] = useState<P2PNotify>(value);
  return (
    <Card title="Уведомления в Telegram">
      <Segmented label="Уведомления" value={v} onChange={(x) => { setV(x); void api.p2pPrefs(currency, { notify: x }).then(onSaved); }}
        options={[["important", "Только важные"], ["all", "Все"]]} />
      <p className="muted small p2p-note">
        {v === "important"
          ? "Без дублей Bybit: апелляции, напоминание, если покупатель отметил оплату 10 минут назад, а монеты не отпущены, срок оплаты ваших покупок, лимиты карт и спред."
          : "Каждый новый ордер и смена статуса — как в приложении Bybit, плюс напоминания, лимиты и спред."}
      </p>
    </Card>
  );
}

function Orders({ orders }: { orders: P2POrder[] }) {
  return (
    <Card title="Ордера в процессе" aside={<span className="muted small">{orders.length}</span>}>
      {orders.length === 0 ? <Empty title="Открытых ордеров нет">Как только кто-то откроет ордер по вашему объявлению, он появится здесь.</Empty> : (
        <div className="p2p-orders">
          {orders.map((o) => {
            const release = o.status === 20 && o.side === "sell";
            const name = o.side === "sell" ? o.buyer_name : o.seller_name;
            return (
              <div key={o.id} className={`p2p-order${release ? " hot" : ""}${o.status === 30 ? " appeal" : ""}`}>
                <div className="p2p-myad-top">
                  <Chip tone={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "Покупаете" : "Продаёте"}</Chip>
                  <span className="small muted">{dateTime(Math.floor(o.created / 1000))}</span>
                  <span className="grow" />
                  {o.status === 10 && o.seconds_left > 0 && <span className="small num tone-amber">⏱ {Math.ceil(o.seconds_left / 60)} мин</span>}
                </div>
                <div className="p2p-myad-price">
                  <b className="num">{money(o.amount, o.currency)}</b>
                  <span className="small muted num">{price(o.qty)} {o.token} по {money(o.price, o.currency)}</span>
                </div>
                <div className="small">{o.status_text}</div>
                <div className="small muted">{o.who}{name ? ` · в Bybit: ${name}` : ""}</div>
                {release && <p className="p2p-warn small">Отпускайте USDT, только когда деньги видны в банке и ФИО отправителя — {name || "как в ордере"}.</p>}
              </div>
            );
          })}
        </div>
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
