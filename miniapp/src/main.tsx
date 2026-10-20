import "@fontsource-variable/manrope";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { tg } from "./telegram";

tg?.ready();
tg?.expand();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
