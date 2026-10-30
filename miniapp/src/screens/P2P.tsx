// P2P владельца-мейкера: ваше объявление (цена, «Стать #1», количество, снять/вернуть), круг «купил → продал»,
// рынок по вашим банкам, ордера, карты и итоги. Отпускать монеты — только в Bybit, после того как деньги видны в банке.
import { useEffect, useState } from "react";
import { api, type P2PAd, type P2PCycle, type P2PLedger, type P2PMyAd, type P2PNotify, type P2POrder, type P2PPrefs, type P2PView } from "../api";
import { Card, Empty, Segmented, Skeleton, Tabs, Tile } from "../components/ui";
import { compact, pct, price } from "../format";
import { confirmAction, haptic, prefs as store } from "../telegram";

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

type Section = "maker" | "market" | "orders" | "cards" | "stats";

export function P2P() {
  const [currency, setCurrency] = useState<string | null>(() => store.getLocal("p2p_currency"));
  const [section, setSection] = useState<Section>(() => {
    const saved = store.getLocal("p2p_tab") as Section | null;
    return saved && ["maker", "market", "orders", "cards", "stats"].includes(saved) ? saved : "maker";
  });
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
        с правами P2P и статус мейкера на Bybit.
      </Empty>
    );
  }
  const m = data.market;
  const pending = data.pending ?? [];
  const paid = pending.filter((o) => o.status === 20 && o.side === "sell");
  return (
    <div className="p2p">
      <Head data={data} currency={cur} onCurrency={pick} />
      <Level data={data} />
      {data.error && <Card className="p2p-error"><strong>Нет данных P2P</strong><p className="small">{data.error}</p></Card>}
      {paid.length > 0 && (
        <button className="p2p-alert" onClick={() => open("orders")}>
          <span className="p2p-alert-ic" aria-hidden="true">💰</span>
          <span className="row-main"><strong>Покупатель отметил оплату{paid.length > 1 ? ` · ${paid.length}` : ""}</strong>
            <span className="small">{money(paid[0].amount, paid[0].currency)}{paid[0].buyer_name ? ` от ${paid[0].buyer_name}` : ""} — проверьте банк</span></span>
        </button>
      )}
      <div className="p2p-pills">
        <Tabs label="Разделы P2P" value={section} onChange={open} options={[
          ["maker", "Мейкер"], ["market", "Рынок"], ["orders", `Ордера${pending.length ? ` · ${pending.length}` : ""}`],
          ["cards", "Карты"], ["stats", "Итоги"],
        ]} />
      </div>
      {section === "maker" && (
        <>
          <MyAds ads={data.my_ads ?? []} market={m} onChanged={reload} />
          {m && <Cycle market={m} ads={data.my_ads ?? []} currency={cur} />}
          <NotifyMode value={data.notify ?? "important"} currency={cur} onSaved={reload} />
        </>
      )}
      {section === "market" && m && (
        <>
          {m.cycle && <CleanCycle cycle={m.cycle} currency={cur} />}
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
      {section === "orders" && <Orders orders={pending} />}
      {section === "cards" && data.ledger && m && <Cards ledger={data.ledger} prefs={m.prefs} currency={cur} onSaved={reload} />}
      {section === "stats" && data.stats && <Stats stats={data.stats} />}
    </div>
  );
}

/** Шапка: аватар, ник, уровень и выполнение; валюта. */
function Head({ data, currency, onCurrency }: { data: P2PView; currency: string; onCurrency: (c: string) => void }) {
  const a = data.account;
  const lv = data.level;
  const current = lv ? [...lv.levels].reverse().find((l) => l.done)?.name ?? "Новый" : null;
  return (
    <header className="p2p-top">
      <span className="p2p-ava" aria-hidden="true">{(a?.nickName ?? "P").slice(0, 1).toUpperCase()}</span>
      <div className="row-main">
        <strong className="p2p-nick">{a?.nickName ?? "P2P · USDT"}</strong>
        <span className="small muted">Мейкер{current ? ` · ${current}` : ""}{a?.recentRate != null ? ` · выполнено ${a.recentRate}%` : ""}</span>
      </div>
      {data.currencies && data.currencies.length > 1 && (
        <Segmented label="Валюта" options={data.currencies.map((c) => [c, c] as [string, string])} value={currency} onChange={onCurrency} />
      )}
    </header>
  );
}

/** Прогресс до следующего уровня мейкера — фирменная градиентная карточка. */
function Level({ data }: { data: P2PView }) {
  const lv = data.level;
  if (!lv) return null;
  const next = lv.levels.find((l) => l.name === lv.next);
  if (!next) return <div className="p2p-level done"><small>Условия всех уровней выполнены — проверьте статус в Bybit</small></div>;
  const steps = 5;
  const share = Math.min(1, lv.volume_30d / next.volume);
  return (
    <section className="p2p-level">
      <small>До уровня «{next.name}» — {next.perks}</small>
      <div className="p2p-level-n num">{lv.volume_30d.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}
        <span> / {next.volume.toLocaleString("ru-RU")} USDT</span></div>
      <div className="p2p-steps" aria-hidden="true">
        {Array.from({ length: steps }, (_, i) => <i key={i} className={i < Math.round(share * steps) ? "on" : undefined} />)}
      </div>
      <div className="p2p-level-row small">
        <span>{lv.counterparties} из {next.people} контрагентов</span>
        <span>{share >= 1 ? "объём набран" : `ещё ${Math.ceil(next.volume - lv.volume_30d).toLocaleString("ru-RU")} USDT`}</span>
      </div>
    </section>
  );
}

const VERDICT: Record<P2PCycle["verdict"], [string, string]> = {
  go: ["Делать круг", "up"], thin: ["На грани", "amber"], skip: ["Пропустить", "down"],
};

/** Чистый круг тейкером: продать USDT надёжному покупателю, на эти деньги выкупить у надёжного продавца. */
function CleanCycle({ cycle: c, currency }: { cycle: P2PCycle; currency: string }) {
  const [label, tone_] = VERDICT[c.verdict];
  const sign = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`;
  return (
    <Card title="Чистый круг" aside={<span className={`p2p-verdict tone-${tone_}`}>{label}</span>}>
      {c.sell == null || c.buy == null ? (
        <p className="muted small">Нет надёжных {c.sell == null ? "покупателей" : "продавцов"} по вашим фильтрам.</p>
      ) : (
        <>
          <div className="p2p-cycle">
            <div><small>1. Продать</small><b className="num">{price(c.sell)}</b>
              <span className="faint small">{c.sell_nick} · {c.sell_orders} сд. · {c.sell_rate}%</span></div>
            <div><small>2. Выкупить</small><b className="num">{price(c.buy)}</b>
              <span className="faint small">{c.buy_nick} · {c.buy_orders} сд. · {c.buy_rate}%</span></div>
            <div className={c.pct! >= 0 ? "win" : "loss"}><small>С {price(c.qty!)} USDT</small>
              <b className="num">{sign(c.gain_money!)} {SYMBOL[currency] ?? currency}</b>
              <span className="faint small">{pp(c.pct!)} · {sign(c.gain_qty!)} USDT</span></div>
          </div>
          <p className="muted small p2p-note">
            Делать — от {pct(c.go_pct)}, на грани — {pct(c.thin_pct)}–{pct(c.go_pct)}. Только покупатели и продавцы от
            {" "}{c.clean_orders} сделок и {c.clean_rate}% выполнения{c.outliers ? `; ${c.outliers} объявл. с ценой не по рынку отброшено` : ""}.
            Монеты отпускайте, только когда деньги пришли в банк от человека с ФИО из ордера.
          </p>
        </>
      )}
    </Card>
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
        <p className="muted small p2p-note">
          Покупают дороже, чем продают: свои объявления сейчас в минусе, а круг по чужим — в плюсе (выше, «Чистый
          круг»). Цены здесь — без отбора выбросов.
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

/** Ваши объявления — главное для мейкера: цена и место в выдаче, «Стать #1», ±, количество, снять или вернуть.
 *  Каждое изменение — с подтверждением; цену дальше 1,5% от лучшего конкурента сервер не поставит. */
function MyAds({ ads, market, onChanged }: { ads: P2PMyAd[]; market?: P2PView["market"]; onChanged: () => void }) {
  if (ads.length === 0) {
    return (
      <Card title="Моё объявление">
        <Empty title="Объявлений нет">Разместите объявление в Bybit: P2P → Ads → «Разместить». Оно появится здесь,
          и им можно будет управлять: цена, «Стать #1», количество, снять и вернуть.</Empty>
        {market?.ask != null && <p className="muted small">Сейчас лучшие продают от {money(market.ask, market.currency)}.</p>}
      </Card>
    );
  }
  return <>{ads.map((a) => <AdCard key={a.id} ad={a} onChanged={onChanged} />)}</>;
}

function AdCard({ ad: a, onChanged }: { ad: P2PMyAd; onChanged: () => void }) {
  const [price, setPrice] = useState(a.price);
  const [qty, setQty] = useState(String(Math.round(a.left * 100) / 100));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => setPrice(a.price), [a.price]);
  const cur = SYMBOL[a.currency] ?? a.currency;
  const run = async (action: "price" | "quantity" | "offline" | "online", value: number | undefined, ask: string) => {
    if (!(await confirmAction(ask))) return;
    haptic();
    setBusy(true);
    setNote(null);
    try {
      setNote({ text: (await api.p2pAd(a.id, action, value)).message, ok: true });
      onChanged();
    } catch (e) {
      setNote({ text: (e as Error).message, ok: false });
    } finally {
      setBusy(false);
    }
  };
  const sold = a.total ? Math.min(1, (a.total - a.left) / a.total) : 0;
  const first = a.rank_pay === 1 || (a.rank_pay == null && a.rank === 1);
  const step = (d: number) => setPrice((p) => Math.round((p + d) * 100) / 100);
  const changed = Math.abs(price - a.price) >= 0.005;
  const side = a.side === "sell" ? "продажа" : "покупка";
  return (
    <section className={`card p2p-ad-card${a.online ? "" : " off"}`}>
      <div className="p2p-ad-head">
        <strong>Моё объявление · {side}</strong>
        <span className={`small ${a.online ? "tone-up" : "muted"}`}>● {a.status_text}</span>
      </div>
      <div className="p2p-ad-main">
        <div>
          <div className="p2p-ad-price num">{money(a.price, a.currency)}</div>
          <span className="small muted">{a.best_rival != null ? `лучший конкурент ${money(a.best_rival, a.currency)}` : "конкурентов с вашими банками нет"}</span>
        </div>
        {(a.rank_pay ?? a.rank) != null && (
          <span className={`p2p-place${first ? " top" : ""}`} title="место в выдаче среди тех же банков">#{a.rank_pay ?? a.rank}</span>
        )}
      </div>
      <div className="p2p-stepper">
        <button aria-label="Цена ниже на 1 копейку" disabled={busy} onClick={() => step(-0.01)}>−</button>
        <input className="num" inputMode="decimal" aria-label="Новая цена" value={String(price).replace(".", ",")}
          onChange={(e) => { const v = Number(e.target.value.replace(",", ".")); if (Number.isFinite(v)) setPrice(v); }} />
        <button aria-label="Цена выше на 1 копейку" disabled={busy} onClick={() => step(0.01)}>+</button>
      </div>
      <div className="p2p-ad-btns">
        {changed ? (
          <button className="btn btn-go" disabled={busy}
            onClick={() => void run("price", price, `Поставить цену ${money(price, a.currency)}?`)}>Применить {String(price).replace(".", ",")}</button>
        ) : a.top_price != null && !first ? (
          <button className="btn btn-go" disabled={busy}
            onClick={() => void run("price", a.top_price!, `Стать первым: цена ${money(a.top_price!, a.currency)}?`)}>
            Стать #1 · {String(a.top_price).replace(".", ",")}</button>
        ) : (
          <button className="btn btn-go" disabled>Вы первый в выдаче</button>
        )}
        {a.online ? (
          <button className="btn" disabled={busy} onClick={() => void run("offline", undefined, "Снять объявление с публикации? Открытые ордера останутся.")}>Снять с публикации</button>
        ) : (
          <button className="btn" disabled={busy} onClick={() => void run("online", undefined, "Вернуть объявление в выдачу?")}>Вернуть в выдачу</button>
        )}
      </div>
      <div className="p2p-bar"><i style={{ width: `${sold * 100}%` }} /></div>
      <div className="p2p-ad-meta small muted">
        <span>{a.side === "sell" ? "продано" : "куплено"} {price_(a.total - a.left)} из {price_(a.total)} {a.token} · осталось {price_(a.left)}</span>
        <span>{compact(a.min_amount)}–{compact(a.max_amount)} {cur}</span>
      </div>
      <div className="p2p-qty">
        <label className="small muted">Количество в объявлении, {a.token}
          <input className="num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        <button className="btn" disabled={busy || !(Number(qty.replace(",", ".")) > 0) || Number(qty.replace(",", ".")) === Math.round(a.left * 100) / 100}
          onClick={() => { const v = Number(qty.replace(",", ".")); void run("quantity", v, `Поставить в объявление ${v} ${a.token}?`); }}>Сохранить</button>
      </div>
      <div className="p2p-tags">{a.payments.map((x) => <span key={x}>{x}</span>)}{a.fee_pct > 0 && <span className="faint">комиссия {pct(a.fee_pct)}</span>}</div>
      {note && <p className={`small ${note.ok ? "tone-up" : "tone-down"}`}>{note.text}</p>}
    </section>
  );
}

const price_ = (x: number) => price(x);

/** Круг «купил → продал»: купить USDT по лучшему чужому объявлению и продать своим — сколько остаётся чистыми. */
function Cycle({ market: m, ads, currency }: { market: NonNullable<P2PView["market"]>; ads: P2PMyAd[]; currency: string }) {
  const sell = ads.find((a) => a.side === "sell" && a.currency === currency);
  const buyAd = ads.find((a) => a.side === "buy" && a.currency === currency);
  const buy = buyAd?.price ?? m.ask;
  const sellPrice = sell?.price ?? m.ask;
  const fee = (sell?.fee_pct || m.ad_fee_pct || m.prefs.fee_sell_pct || 0.3) / 100;
  const per = buy != null && sellPrice != null ? sellPrice * (1 - fee) - buy * (buyAd ? 1 + fee : 1) : null;
  return (
    <Card title="Круг: купил → продал" aside={<span className="muted small">комиссия {pct(fee * 100)}</span>}>
      <div className="p2p-cycle">
        <div><small>Покупка</small><b className="num">{buy != null ? price_(buy) : "—"}</b><span className="faint small">{buyAd ? "ваше объявление" : "по лучшему продавцу"}</span></div>
        <div><small>Продажа</small><b className="num">{sellPrice != null ? price_(sellPrice) : "—"}</b><span className="faint small">{sell ? "ваше объявление" : "по рынку"}</span></div>
        <div className={per == null ? undefined : per >= 0 ? "win" : "loss"}><small>С 1 000 USDT</small>
          <b className="num">{per != null ? `${per >= 0 ? "+" : "−"}${Math.abs(per * 1000).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ${SYMBOL[currency] ?? currency}` : "—"}</b>
          <span className="faint small">чистыми</span></div>
      </div>
      <p className="muted small p2p-note">
        {per != null && per < 0
          ? "Сейчас круг в минусе: ваша цена продажи слишком близко к рынку. На уровне «Новый» это плата за объём; с «Регулярного» — своё объявление на покупку, и круг выходит в плюс."
          : "Продаёте своим объявлением, а USDT для него покупаете по лучшему объявлению продавца (без комиссии)."}
      </p>
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
    <Card title="Ордера" aside={<span className="muted small">{orders.length} в работе</span>}>
      {orders.length === 0 ? <Empty title="Открытых ордеров нет">Как только кто-то откроет ордер по вашему объявлению, он появится здесь.</Empty> : (
        <div className="p2p-orders">
          {orders.map((o) => {
            const release = o.status === 20 && o.side === "sell";
            const name = (o.side === "sell" ? o.buyer_name : o.seller_name) || o.who;
            const badge = o.status === 30 ? ["апелляция", "appeal"] : release ? ["оплачен", "paid"]
              : o.status === 10 && o.seconds_left > 0 ? [`⏱ ${Math.ceil(o.seconds_left / 60)} мин`, "wait"] : [o.status_text, "muted"];
            return (
              <div key={o.id} className={`p2p-order${release ? " hot" : ""}`}>
                <span className="p2p-oav" aria-hidden="true">{(name || "?").slice(0, 1).toUpperCase()}</span>
                <div className="row-main">
                  <strong className="num">{money(o.amount, o.currency)}</strong>
                  <span className="small muted">{price_(o.qty)} {o.token} · {o.side === "sell" ? "продаёте" : "покупаете"} · {name}</span>
                </div>
                <span className={`p2p-badge ${badge[1]}`}>{badge[0]}</span>
                {release && <p className="p2p-warn small">Отпускайте USDT в Bybit, только когда деньги видны в банке и ФИО отправителя — {name}.</p>}
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
