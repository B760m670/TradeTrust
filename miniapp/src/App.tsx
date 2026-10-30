import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { AccountButton } from "./components/Account";
import type { Act } from "./components/BotControls";
import { AlertIcon, CloseIcon, HomeIcon, TrendIcon, WalletIcon, CandleIcon } from "./components/icons";
import { Empty, Logo, Skeleton, Toast } from "./components/ui";
import type { Status } from "./api";
import { useWide } from "./hooks";
import { LiveContext, LiveFeed, TickersContext, feedUrl, useTickers } from "./live";
import { withLivePrices } from "./logic";
import { Admin } from "./screens/Admin";
import { Assets } from "./screens/Assets";
import { Home } from "./screens/Home";
import { Markets } from "./screens/Markets";
import { MyExchanges } from "./screens/MyExchanges";
import { P2P } from "./screens/P2P";
import { Settings } from "./screens/Settings";
import { Trade } from "./screens/Trade";
import { haptic, initData, tg } from "./telegram";
import { ThemeContext, useThemeState } from "./theme";
import { useBot } from "./useBot";

// Как у бирж: Главная · Рынки · Торговать · Активы. Бот и настройки — страницы поверх вкладок.
export type Tab = "home" | "markets" | "trade" | "assets";
type Page = "settings" | "p2p" | "exchanges";

const TABS: { id: Tab; text: string; icon: ReactNode }[] = [
  { id: "home", text: "Главная", icon: <HomeIcon /> },
  { id: "markets", text: "Рынки", icon: <TrendIcon /> },
  { id: "trade", text: "Торговать", icon: <CandleIcon /> },
  { id: "assets", text: "Активы", icon: <WalletIcon /> },
];
const tabsFor = (_status: Status | null) => TABS;
// админка — только по кнопке «Админка» в Telegram у владельца: ?page=admin
const ADMIN_PAGE = new URLSearchParams(window.location.search).get("page") === "admin";


function Sidebar({ tab, onTab, status, busy, act, inCoin }: {
  tab: Tab; onTab: (t: Tab) => void; status: Status | null; busy: boolean; act: Act; inCoin: boolean;
}) {
  return (
    <aside className="sidebar">
      <div className="brand"><Logo /><span>TradeTrust</span></div>
      <nav className="side-nav" aria-label="Разделы">
        {tabsFor(status).map((t) => (
          <button key={t.id} className={!inCoin && tab === t.id ? "on" : undefined}
            aria-current={!inCoin && tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
            {t.icon}<span>{t.text}</span>
          </button>
        ))}
      </nav>
      <div className="grow" />
      {status && (
        <div className="side-controls">
          <div className="side-row">
            <AccountButton status={status} busy={busy} act={act} />
          </div>
        </div>
      )}
    </aside>
  );
}

function BottomNav({ tab, onTab, inCoin, status }: { tab: Tab; onTab: (t: Tab) => void; inCoin: boolean; status: Status | null }) {
  const tabs = tabsFor(status);
  const index = tabs.findIndex((t) => t.id === tab);
  return (
    <nav className={`bottom-nav${tabs.length > 5 ? " six" : ""}`} aria-label="Разделы"
      style={{ "--i": index, "--n": tabs.length } as CSSProperties}>
      {tabs.map((t) => (
        <button key={t.id} className={!inCoin && tab === t.id ? "on" : undefined}
          aria-current={!inCoin && tab === t.id ? "page" : undefined} onClick={() => onTab(t.id)}>
          {t.icon}<span>{t.text}</span>
        </button>
      ))}
    </nav>
  );
}

function Loading() {
  return (
    <div className="loading" aria-label="Загрузка">
      <Skeleton height={14} width={120} />
      <Skeleton height={52} width="70%" />
      <div className="tiles"><Skeleton height={76} /><Skeleton height={76} /><Skeleton height={76} /><Skeleton height={76} /></div>
      <Skeleton height={220} />
    </div>
  );
}

function Main() {
  const bot = useBot();
  const env = bot.status?.env;
  const [feed, setFeed] = useState<LiveFeed | null>(null);
  useEffect(() => {
    if (!env) return;
    const f = new LiveFeed(feedUrl(env));
    setFeed(f);
    return () => f.close();
  }, [env]);
  // другой счёт — экраны заново, как у бирж: свои активы, позиции и сделки
  return <LiveContext.Provider value={feed}><Screens key={bot.status?.accounts?.active ?? "main"} {...bot} /></LiveContext.Provider>;
}

function Screens({ status: botStatus, error, busy, message, clearMessage, act }: ReturnType<typeof useBot>) {
  const coins = botStatus ? [...new Set([...botStatus.all_coins, ...botStatus.positions.map((p) => p.coin)])] : [];
  const tickers = useTickers(coins);
  const status = useMemo(() => botStatus && withLivePrices(botStatus, tickers), [botStatus, tickers]);
  const wide = useWide();
  const [tab, setTab] = useState<Tab>("home");
  const [page, setPage] = useState<Page | null>(null);
  const [tradeCoin, setTradeCoin] = useState<string | null>(null);
  const coin = tradeCoin ?? status?.positions[0]?.coin ?? "BTC";

  useEffect(() => {
    const button = tg?.BackButton;
    if (!button) return;
    const back = () => setPage(null);
    if (page) {
      button.show();
      button.onClick(back);
    } else {
      button.hide();
    }
    return () => button.offClick(back);
  }, [page]);

  const openPage = (p: Page | null) => {
    haptic();
    setPage(p);
    window.scrollTo(0, 0);
  };
  const openCoin = (c: string) => {
    haptic();
    setTradeCoin(c);
    setTab("trade");
    setPage(null);
    window.scrollTo(0, 0);
  };
  const openTab = (t: Tab) => {
    haptic();
    setTab(t);
    setPage(null);
    window.scrollTo(0, 0);
  };

  let body;
  if (!status) {
    body = error
      ? <Empty icon={<AlertIcon size={28} />} title="Нет связи с ботом">{error}</Empty>
      : <Loading />;
  } else if (ADMIN_PAGE) {
    body = status.admin ? <Admin /> : <Empty title="Нет доступа">Админка доступна только владельцу бота.</Empty>;
  } else if (page === "exchanges") {
    body = <MyExchanges />;
  } else if (page === "p2p") {
    body = <P2P />;
  } else if (page === "settings") {
    body = <Settings status={status} busy={busy} act={act} scope="app" />;
  } else if (tab === "markets") {
    body = <Markets status={status} onOpenCoin={openCoin} />;
  } else if (tab === "trade") {
    body = <Trade coin={coin} status={status} busy={busy} act={act} wide={wide} onCoin={openCoin} />;
  } else if (tab === "assets") {
    body = <Assets status={status} />;
  } else {
    body = <Home status={status} busy={busy} act={act} onOpenCoin={openCoin} onTab={openTab}
      onSettings={() => openPage("settings")} onP2P={() => openPage("p2p")}
      onExchanges={() => openPage("exchanges")} />;
  }

  if (ADMIN_PAGE) {
    return (
      <div className="app narrow admin-only">
        <main className="content">
          <button className="icon-btn btn btn-ghost admin-close" aria-label="Закрыть" onClick={() => tg?.close?.()}><CloseIcon /></button>
          <div className="screen">{body}</div>
        </main>
        {message && <Toast message={message} onClose={clearMessage} />}
      </div>
    );
  }

  return (
    <TickersContext.Provider value={tickers}>
      <div className={`app ${wide ? "wide" : "narrow"}${tab === "trade" && !page ? " trading" : ""}`}>
        {wide && <Sidebar tab={tab} onTab={openTab} status={status} busy={busy} act={act} inCoin={!!page} />}
        <main className="content">
          {status && error && <div className="banner"><AlertIcon size={16} />Нет связи с сервером: {error}</div>}
          <div key={page ?? (tab === "trade" ? `trade-${coin}` : tab)} className="screen">{body}</div>
        </main>
        {!wide && <BottomNav tab={tab} onTab={openTab} inCoin={!!page} status={status} />}
        {message && <Toast message={message} onClose={clearMessage} />}
      </div>
    </TickersContext.Provider>
  );
}

export function App() {
  const theme = useThemeState();
  return (
    <ThemeContext.Provider value={theme}>
      {initData()
        ? <Main />
        : (
          <div className="app narrow">
            <main className="content">
              <Empty icon={<Logo />} title="TradeTrust">
                Откройте приложение через своего Telegram-бота: кнопка «Открыть» внизу чата.
              </Empty>
            </main>
          </div>
        )}
    </ThemeContext.Provider>
  );
}
