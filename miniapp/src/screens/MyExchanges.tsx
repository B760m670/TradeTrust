// «Мои биржи»: балансы на Bybit, Binance, OKX и KuCoin в одном месте и где закрыт ввод/вывод монет.
// Только просмотр: ключи — на сервере и только для чтения, с правом торговли или вывода бот их не принимает.
import { useEffect, useState } from "react";
import { api, type MyExchange, type MyExchanges as Data } from "../api";
import { BigMoney, Card, CoinAvatar, Empty, Skeleton, StatusDot } from "../components/ui";
import { dateTime, price, usd } from "../format";

export function MyExchanges() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.exchanges().then((d) => alive && (setData(d), setError(null)), (e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(() => document.visibilityState === "visible" && void load(), 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error && !data) return <Empty title="Нет данных">{error}</Empty>;
  if (!data) return <div className="p2p"><Skeleton height={200} /></div>;
  if (!data.exchanges.length) {
    return (
      <Empty title="Биржи не подключены">
        Добавьте ключи только для чтения в <code>/opt/tradetrust/.env</code> (BINANCE_API_KEY, OKX_API_KEY, KUCOIN_API_KEY…)
        и перезапустите бота.
      </Empty>
    );
  }
  return (
    <div className="p2p">
      <header className="p2p-head">
        <div>
          <h2>Мои биржи</h2>
          <span className="muted small">только просмотр · обновление раз в 5 минут</span>
        </div>
      </header>
      <Card title="Всего на биржах">
        <BigMoney value={data.total} unit="$" />
      </Card>
      <div className="p2p-books">
        {data.exchanges.map((e) => <ExchangeCard key={e.name} ex={e} />)}
      </div>
      {data.coins.length > 0 && (
        <Card title="Монеты на всех биржах">
          <div className="list">
            {data.coins.map((c) => (
              <div key={c.coin} className="list-row">
                <CoinAvatar coin={c.coin} size={32} />
                <div className="row-main">
                  <strong>{c.coin} <span className="muted small num">{price(c.qty)}</span></strong>
                  <span className="muted small">
                    {Object.entries(c.where).map(([ex, q]) => `${ex} ${price(q)}`).join(" · ")}
                  </span>
                  {Object.entries(c.closed).map(([ex, st]) => (
                    <span key={ex} className="small tone-down">
                      {ex}: {!st.withdraw && !st.deposit ? "ввод и вывод закрыты" : !st.withdraw ? "вывод закрыт" : "ввод закрыт"}
                    </span>
                  ))}
                </div>
                <strong className="num">{usd(c.value)} $</strong>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function ExchangeCard({ ex }: { ex: MyExchange }) {
  const tone = !ex.connected ? "down" : ex.error || ex.warnings.length ? "amber" : "up";
  return (
    <Card title={ex.name} aside={<span className="muted small"><StatusDot tone={tone} /> {ex.connected ? "только чтение" : "не подключена"}</span>}>
      {!ex.connected ? <p className="tone-down small">{ex.error}</p> : (
        <>
          <strong className="num big-num">{ex.total != null ? `${usd(ex.total)} $` : "—"}</strong>
          {ex.assets && ex.assets.length > 0 && (
            <p className="muted small">{ex.assets.slice(0, 4).map((a) => `${a.coin} ${a.value != null ? `${usd(a.value)} $` : price(a.qty)}`).join(" · ")}
              {ex.assets.length > 4 ? ` · ещё ${ex.assets.length - 4}` : ""}</p>
          )}
          {ex.warnings.map((w) => <p key={w} className="small tone-amber">⚠️ {w}</p>)}
          {ex.error && <p className="small tone-down">{ex.error}</p>}
          {ex.updated_at && <p className="faint small">обновлено {dateTime(ex.updated_at)}</p>}
        </>
      )}
    </Card>
  );
}
