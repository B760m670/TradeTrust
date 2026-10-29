import { useEffect, useState, type CSSProperties } from "react";
import { api, type Asset, type Portfolio as PortfolioData } from "../api";
import { AlertIcon } from "../components/icons";
import { BigMoney, Card, Chip, CoinAvatar, Empty, Flash, LiveBadge, Skeleton, Tile } from "../components/ui";
import { pct, price, tone, usd } from "../format";
import { useTickers } from "../live";
import { allocation, dayChange } from "../logic";
import { useTheme, type Theme } from "../theme";

const REFRESH_MS = 30_000;

// Цвета долей проверены на различимость (в т.ч. при дальтонизме) для обеих тем; «Другие» — серый.
const SLICE_COLORS: Record<Theme, string[]> = {
  dark: ["#3987e5", "#d95926", "#2fb3a6", "#c98500", "#d55181"],
  light: ["#2a78d6", "#eb6834", "#1f9a8e", "#eda100", "#e87ba4"],
};

export function usePortfolio() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () => api.portfolio().then(
      (d) => { if (alive) { setData(d); setError(null); } },
      (e: Error) => alive && setError(e.message),
    );
    void load();
    const timer = setInterval(() => document.visibilityState === "visible" && void load(), REFRESH_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [tick]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

/** Стоимость активов по живым ценам, если они есть. */
export function withLive(assets: Asset[], prices: Record<string, { price: number }>): Asset[] {
  return assets.map((a) => {
    const live = !a.stable ? prices[a.coin]?.price : undefined;
    return live ? { ...a, price: live, value: a.qty * live } : a;
  });
}

const qtyFmt = (x: number) => x.toLocaleString("ru-RU", { maximumFractionDigits: x >= 100 ? 2 : 6 });

export function Portfolio({ embedded }: { embedded?: boolean }) {
  const { data, error } = usePortfolio();
  const { theme } = useTheme();
  const coins = (data?.assets ?? []).filter((a) => !a.stable).map((a) => a.coin);
  const tickers = useTickers(coins);

  if (!data) {
    return error
      ? <Empty icon={<AlertIcon size={28} />} title="Активы не загрузились">{error}</Empty>
      : <div className="loading"><Skeleton height={14} width={120} /><Skeleton height={52} width="70%" /><Skeleton height={120} /><Skeleton height={260} /></div>;
  }

  const assets = withLive(data.assets, tickers).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const total = assets.reduce((s, a) => s + (a.value ?? 0), 0);
  const changes = Object.fromEntries(Object.entries(tickers).map(([c, t]) => [c, t.change24h]));
  const day = dayChange(assets, changes);
  const slices = allocation(assets);
  const colorOf = (key: string, i: number) => key === "other" ? "var(--faint)" : SLICE_COLORS[theme][i % 5];
  const botValue = Math.min(total, data.bot.invested + data.bot.free);
  const mine = Math.max(0, total - botValue);
  const share = (x: number) => (total > 0 ? (x / total) * 100 : 0);

  return (
    <div className="portfolio">
      {!embedded && (
        <header className="page-head">
          <h1>Активы <LiveBadge on={Object.keys(tickers).length > 0} /></h1>
          <span className="muted">Всё, что лежит на счёте, а не только часть бота</span>
        </header>
      )}

      <div className="portfolio-grid">
        <div className="settings-col">
          <Card>
            <span className="eyebrow">Весь счёт, USD</span>
            <BigMoney value={total} unit="$" />
            {day && (
              <div className="hero-pills">
                <span className={`pill pill-${tone(day.usd)}`}>{usd(day.usd, true)} $ · {pct(day.pct, true)}</span>
                <span className="muted small">за 24 часа</span>
              </div>
            )}
            {slices.length > 0 && (
              <>
                <div className="alloc-bar" role="img"
                  aria-label={`Распределение: ${slices.map((s) => `${s.label} ${pct(s.share)}`).join(", ")}`}>
                  {slices.map((s, i) => (
                    <span key={s.key} title={`${s.label}: ${usd(s.value)} $ · ${pct(s.share)}`}
                      style={{ "--w": `${s.share}%`, background: colorOf(s.key, i) } as CSSProperties} />
                  ))}
                </div>
                <ul className="alloc-legend">
                  {slices.map((s, i) => (
                    <li key={s.key}>
                      <i style={{ background: colorOf(s.key, i) }} />
                      <span>{s.label}</span>
                      <strong className="num">{pct(s.share)}</strong>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Кто управляет">
            <div className="tiles tiles-2">
              <Tile label="Бот" value={`${usd(botValue)} $`}
                hint={`${pct(share(botValue))} счёта · в сделках ${usd(data.bot.invested)} $`} />
              <Tile label="Ваше" value={`${usd(mine)} $`} hint={`${pct(share(mine))} счёта · бот не трогает`} />
            </div>
            <p className="footnote">
              Бот распоряжается только своим капиталом и монетами, которые купил сам. То, что вы купили на «Торговать»,
              он не продаёт и не использует. Капитал бота меняется в настройках бота.
            </p>
          </Card>
        </div>

        <Card title="Активы" aside={<span className="muted small">{assets.length}</span>} className="table-card assets-card">
          <div className="asset-row asset-head" aria-hidden="true">
            <span>Монета</span><span className="col-wide">Количество</span><span className="col-wide">Цена</span>
            <span>Стоимость</span><span className="col-wide">24 ч</span>
          </div>
          {assets.map((a, i) => {
            const ch = tickers[a.coin]?.change24h;
            return (
              <div key={a.coin} className="asset-row" style={{ "--i": i } as CSSProperties}>
                <span className="sig-coin">
                  <CoinAvatar coin={a.coin} tone={a.bot_qty > 0 ? "accent" : "muted"} size={34} />
                  <span className="sig-name">
                    <strong>{a.coin} {a.bot_qty > 0 && <Chip tone="accent">{a.bot_qty >= a.qty * 0.999 ? "бот" : "частично бот"}</Chip>}</strong>
                    <span className="small muted narrow-only">
                      {qtyFmt(a.qty)}{a.price != null && !a.stable ? ` × ${price(a.price)}` : ""}
                    </span>
                  </span>
                </span>
                <span className="num col-wide">{qtyFmt(a.qty)}</span>
                <span className="num col-wide muted">{a.price == null ? "—" : a.stable ? "1" : price(a.price)}</span>
                <span className="asset-value">
                  <Flash value={a.value ?? undefined} className="num bold">{a.value == null ? "нет цены" : `${usd(a.value)} $`}</Flash>
                  <span className="small muted num">
                    {a.value != null && pct(share(a.value))}
                    {ch != null && <span className={`narrow-only tone-${tone(ch)}`}> · {pct(ch, true)}</span>}
                  </span>
                </span>
                <span className={`num col-wide tone-${ch == null ? "neutral" : tone(ch)}`}>{ch == null ? "—" : pct(ch, true)}</span>
              </div>
            );
          })}
          {assets.length === 0 && <Empty title="На счёте пусто" />}
        </Card>
      </div>
    </div>
  );
}
