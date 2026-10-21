import { useEffect, useRef, useState } from "react";
import { useTheme } from "../theme";
import { Empty } from "./ui";

const SCRIPT = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
const LOAD_TIMEOUT_MS = 15_000;

/** Полный график TradingView — тот же, что встроен в Bybit и Binance: таймфреймы, линия «Срок», свечи,
 *  индикаторы, рисование, масштаб пальцами. Данные — спот Bybit (BYBIT:BTCUSDT), время — по телефону. */
export function TradingViewChart({ coin, interval = "15" }: { coin: string; interval?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const { theme } = useTheme();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setFailed(false);
    el.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    el.appendChild(widget);
    const script = document.createElement("script");
    script.src = SCRIPT;
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: `BYBIT:${coin}USDT`,
      interval,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
      theme,
      style: "1",
      locale: "ru",
      backgroundColor: theme === "dark" ? "#101117" : "#FFFFFF", // как карточка поверх фона приложения
      gridColor: theme === "dark" ? "rgba(255,255,255,0.05)" : "rgba(17,18,28,0.06)",
      allow_symbol_change: false,
      hide_side_toolbar: true,
      withdateranges: false,
      save_image: false,
      calendar: false,
      details: false,
      hotlist: false,
      support_host: "https://www.tradingview.com",
    });
    const timer = setTimeout(() => !el.querySelector("iframe") && setFailed(true), LOAD_TIMEOUT_MS);
    script.onerror = () => setFailed(true);
    el.appendChild(script);
    return () => {
      clearTimeout(timer);
      el.innerHTML = "";
    };
  }, [coin, interval, theme]);

  return (
    <div className="tv-wrap">
      <div ref={box} className="tradingview-widget-container tv-chart" data-testid="tradingview" />
      {failed && (
        <div className="tv-failed">
          <Empty title="TradingView не открылся">
            Похоже, сайт tradingview.com недоступен из вашей сети. Попробуйте с VPN или откройте вид «Бот · 4ч».
          </Empty>
        </div>
      )}
    </div>
  );
}
