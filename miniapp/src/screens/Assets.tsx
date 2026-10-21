import { useState } from "react";
import type { Status } from "../api";
import { Card, Chip, CoinAvatar, Empty, Tabs } from "../components/ui";
import { dateTime, price, usd } from "../format";
import { Journal } from "./Journal";
import { Portfolio } from "./Portfolio";

type View = "overview" | "history";
const VIEWS: [View, string][] = [["overview", "Обзор"], ["history", "История"]];

/** «Активы», как у бирж: весь счёт по монетам, ниже — история: ваши сделки и сделки бота. */
export function Assets({ status: s }: { status: Status }) {
  const [view, setView] = useState<View>("overview");
  const orders = s.orders ?? [];
  return (
    <div className="assets">
      <header className="page-head">
        <h1>Активы</h1>
        <span className="muted">Весь счёт: ваши монеты и то, чем распоряжается бот</span>
      </header>
      <Tabs label="Раздел" options={VIEWS} value={view} onChange={setView} />
      {view === "overview" ? <Portfolio embedded /> : (
        <>
          <Card title="Мои сделки" aside={<span className="muted small">{orders.length}</span>}>
            {orders.length === 0
              ? <Empty title="Вы ещё не торговали вручную">Купить и продать можно на вкладке «Торговать».</Empty>
              : (
                <div className="list">
                  {orders.map((o) => (
                    <div key={o.id} className="list-row trade">
                      <CoinAvatar coin={o.coin} size={32} tone={o.side === "buy" ? "up" : "down"} />
                      <div className="row-main">
                        <strong>{o.coin} <Chip tone={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "покупка" : "продажа"}</Chip></strong>
                        <span className="muted small num">{price(o.qty)} по {price(o.price)} · {dateTime(o.ts)}</span>
                      </div>
                      <strong className="num">{usd(o.usdt)} $</strong>
                    </div>
                  ))}
                </div>
              )}
          </Card>
          <Journal status={s} embedded />
        </>
      )}
    </div>
  );
}
