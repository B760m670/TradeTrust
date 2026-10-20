import "@fontsource-variable/manrope";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { tg } from "./telegram";

tg?.ready();
tg?.expand();
// иначе движение пальцем по графику вниз закрывает мини-приложение
try {
  tg?.disableVerticalSwipes?.();
} catch {
  // старый клиент Telegram
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
