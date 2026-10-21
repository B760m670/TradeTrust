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

// В Telegram страница не должна масштабироваться жестами (в браузере это норма, в мини-приложении мешает).
// Масштаб графиков работает: у них свои жесты (touch-action: none в styles.css).
for (const type of ["gesturestart", "gesturechange"]) {
  document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
