import { AppRoot, Placeholder, Snackbar, Spinner, Tabbar } from "@telegram-apps/telegram-ui";
import { useEffect, useState } from "react";
import { Coin } from "./screens/Coin";
import { Journal } from "./screens/Journal";
import { Overview } from "./screens/Overview";
import { Signals } from "./screens/Signals";
import { haptic, initData, platform, tg } from "./telegram";
import { useBot } from "./useBot";

type Tab = "overview" | "signals" | "journal";

const TABS: { id: Tab; text: string; icon: string }[] = [
  { id: "overview", text: "Обзор", icon: "◉" },
  { id: "signals", text: "Сигналы", icon: "↗" },
  { id: "journal", text: "Журнал", icon: "≡" },
];

function useColorScheme(): "light" | "dark" {
  const [scheme, setScheme] = useState(tg?.colorScheme ?? "light");
  useEffect(() => tg?.onEvent?.("themeChanged", () => setScheme(tg?.colorScheme ?? "light")), []);
  return scheme;
}

function Main() {
  const { status, error, busy, message, clearMessage, act } = useBot();
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

  let body;
  if (!status) {
    body = error ? <Placeholder header="Нет связи" description={error} /> : <div className="center"><Spinner size="l" /></div>;
  } else if (coin) {
    body = <Coin coin={coin} status={status} busy={busy} act={act} />;
  } else if (tab === "signals") {
    body = <Signals status={status} onOpenCoin={openCoin} />;
  } else if (tab === "journal") {
    body = <Journal status={status} />;
  } else {
    body = <Overview status={status} busy={busy} act={act} onOpenCoin={openCoin} />;
  }

  return (
    <>
      <main className="content">
        {status && error && <div className="banner">Нет связи с сервером: {error}</div>}
        {body}
      </main>
      <Tabbar>
        {TABS.map((t) => (
          <Tabbar.Item key={t.id} text={t.text} selected={!coin && tab === t.id}
            onClick={() => { haptic(); setTab(t.id); setCoin(null); window.scrollTo(0, 0); }}>
            <span className="tab-icon">{t.icon}</span>
          </Tabbar.Item>
        ))}
      </Tabbar>
      {message && <Snackbar onClose={clearMessage} duration={3500}>{message}</Snackbar>}
    </>
  );
}

export function App() {
  const scheme = useColorScheme();
  return (
    <AppRoot appearance={scheme} platform={platform()}>
      {initData()
        ? <Main />
        : <Placeholder header="TradeTrust" description="Откройте приложение через своего Telegram-бота: кнопка «Открыть» внизу чата." />}
    </AppRoot>
  );
}
