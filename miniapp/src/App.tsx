import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { BotState, EnvChip, ModeSwitch, PauseButton, type Act } from "./components/BotControls";
import { AlertIcon, BookIcon, GearIcon, HomeIcon, ShieldIcon, TrendIcon, WalletIcon } from "./components/icons";
import { Empty, Skeleton, Toast } from "./components/ui";
import type { Status } from "./api";
import { useWide } from "./hooks";
import { LiveContext, LiveFeed, TickersContext, feedUrl, useTickers } from "./live";
import { withLivePrices } from "./logic";
import { Admin } from "./screens/Admin";
import { Coin } from "./screens/Coin";
import { Journal } from "./screens/Journal";
import { Overview } from "./screens/Overview";
import { Portfolio } from "./screens/Portfolio";
import { Settings } from "./screens/Settings";
import { Signals } from "./screens/Signals";
import { haptic, initData, tg } from "./telegram";
import { ThemeContext, useThemeState } from "./theme";
import { useBot } from "./useBot";

export type Tab = "overview" | "portfolio" | "signals" | "journal" | "settings" | "admin";

const TABS: { id: Tab; text: string; icon: ReactNode }[] = [
  { id: "overview", text: "Обзор", icon: <HomeIcon /> },
  { id: "portfolio", text: "Портфель", icon: <WalletIcon /> },
  { id: "signals", text: "Сигналы", icon: <TrendIcon /> },
  { id: "journal", text: "Журнал", icon: <BookIcon /> },
  { id: "settings", text: "Настройки", icon: <GearIcon /> },
];
const ADMIN_TAB = { id: "admin" as Tab, text: "Админ", icon: <ShieldIcon /> };
const tabsFor = (status: Status | null) => (status?.admin ? [...TABS, ADMIN_TAB] : TABS);

function Logo() {
  return <span className="logo" aria-hidden="true">TT</span>;
}

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
          <span className="eyebrow">Режим</span>
          <ModeSwitch status={status} busy={busy} act={act} />
          <BotState status={status} />
          <div className="side-row">
            <EnvChip status={status} />
            <PauseButton status={status} busy={busy} act={act} />
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
      {!inCoin && <span className="bottom-thumb" aria-hidden="true" />}
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
  return <LiveContext.Provider value={feed}><Screens {...bot} /></LiveContext.Provider>;
}

function Screens({ status: botStatus, error, busy, message, clearMessage, act }: ReturnType<typeof useBot>) {
  const coins = botStatus ? [...new Set([...botStatus.settings.coins, ...botStatus.positions.map((p) => p.coin)])] : [];
  const tickers = useTickers(coins);
  const status = useMemo(() => botStatus && withLivePrices(botStatus, tickers), [botStatus, tickers]);
  const wide = useWide();
  const [tab, setTab] = useState<Tab>("overview");
  const [coin, setCoin] = useState<string | null>(null);

  useEffect(() => {
    const button = tg?.BackButton;
    if (!button) return;
    const back = () => setCoin(null);
    if (coin) {
      button.show();
      button.onClick(back);
    } else {
      button.hide();
    }
    return () => button.offClick(back);
  }, [coin]);

  const openCoin = (c: string) => {
    haptic();
    setCoin(c);
    window.scrollTo(0, 0);
  };
  const openTab = (t: Tab) => {
    haptic();
    setTab(t);
    setCoin(null);
    window.scrollTo(0, 0);
  };

  let body;
  if (!status) {
    body = error
      ? <Empty icon={<AlertIcon size={28} />} title="Нет связи с ботом">{error}</Empty>
      : <Loading />;
  } else if (coin) {
    body = <Coin coin={coin} status={status} busy={busy} act={act} wide={wide} onBack={() => setCoin(null)} />;
  } else if (tab === "portfolio") {
    body = <Portfolio />;
  } else if (tab === "signals") {
    body = <Signals status={status} onOpenCoin={openCoin} />;
  } else if (tab === "journal") {
    body = <Journal status={status} />;
  } else if (tab === "settings") {
    body = <Settings status={status} busy={busy} act={act} />;
  } else if (tab === "admin" && status.admin) {
    body = <Admin />;
  } else {
    body = <Overview status={status} busy={busy} act={act} wide={wide} onOpenCoin={openCoin} onTab={openTab} />;
  }

  return (
    <TickersContext.Provider value={tickers}>
      <div className={`app ${wide ? "wide" : "narrow"}`}>
        {wide && <Sidebar tab={tab} onTab={openTab} status={status} busy={busy} act={act} inCoin={!!coin} />}
        <main className="content">
          {status && error && <div className="banner"><AlertIcon size={16} />Нет связи с сервером: {error}</div>}
          <div key={coin ?? tab} className="screen">{body}</div>
        </main>
        {!wide && <BottomNav tab={tab} onTab={openTab} inCoin={!!coin} status={status} />}
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
