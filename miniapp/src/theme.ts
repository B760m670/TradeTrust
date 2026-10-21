// Светлая и тёмная тема. «Авто» — как в Telegram (или как в системе, если открыто вне Telegram).
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { paintChrome, prefs, tg } from "./telegram";

export type ThemePref = "auto" | "light" | "dark";
export type Theme = "light" | "dark";

export const THEME_OPTIONS: [ThemePref, string][] = [["auto", "Авто"], ["light", "Светлая"], ["dark", "Тёмная"]];

const KEY = "theme";
const BACKGROUND: Record<Theme, string> = { dark: "#08090C", light: "#F3F4F7" };

const isPref = (v: unknown): v is ThemePref => v === "auto" || v === "light" || v === "dark";

function systemTheme(): Theme {
  if (tg?.colorScheme) return tg.colorScheme;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: light)").matches
    ? "light" : "dark";
}

export function resolveTheme(pref: ThemePref, system: Theme): Theme {
  return pref === "auto" ? system : pref;
}

export interface ThemeState {
  pref: ThemePref;
  theme: Theme;
  setPref: (p: ThemePref) => void;
}

export function useThemeState(): ThemeState {
  const [pref, setPrefState] = useState<ThemePref>(() => {
    const saved = prefs.getLocal(KEY);
    return isPref(saved) ? saved : "auto";
  });
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    // выбор, сделанный на другом устройстве, приходит из облака Telegram
    let alive = true;
    void prefs.getCloud(KEY).then((v) => alive && isPref(v) && setPrefState(v));
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const update = () => setSystem(systemTheme());
    tg?.onEvent?.("themeChanged", update);
    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-color-scheme: light)") : null;
    mq?.addEventListener?.("change", update);
    return () => {
      tg?.offEvent?.("themeChanged", update);
      mq?.removeEventListener?.("change", update);
    };
  }, []);

  const theme = resolveTheme(pref, system);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BACKGROUND[theme]);
    paintChrome(BACKGROUND[theme]);
  }, [theme]);

  const setPref = useCallback((p: ThemePref) => {
    setPrefState(p);
    prefs.set(KEY, p);
  }, []);

  return { pref, theme, setPref };
}

export const ThemeContext = createContext<ThemeState>({ pref: "auto", theme: "dark", setPref: () => {} });
export const useTheme = () => useContext(ThemeContext);
