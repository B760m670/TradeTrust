// Тонкая обёртка над Telegram WebApp (скрипт telegram-web-app.js подключён в index.html).

type Impact = "light" | "medium" | "heavy" | "rigid" | "soft";

interface TelegramWebApp {
  initData: string;
  colorScheme: "light" | "dark";
  platform: string;
  ready(): void;
  expand(): void;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: {
    impactOccurred(style: Impact): void;
    notificationOccurred(type: "error" | "success" | "warning"): void;
  };
  showConfirm?(message: string, callback: (ok: boolean) => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  onEvent?(event: "themeChanged", cb: () => void): void;
  offEvent?(event: "themeChanged", cb: () => void): void;
  CloudStorage?: {
    getItem(key: string, cb: (err: unknown, value?: string) => void): void;
    setItem(key: string, value: string, cb?: (err: unknown) => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | undefined = window.Telegram?.WebApp;

export function initData(): string {
  return tg?.initData ?? "";
}

export function haptic(style: Impact = "light"): void {
  tg?.HapticFeedback?.impactOccurred(style);
}

export function hapticResult(ok: boolean): void {
  tg?.HapticFeedback?.notificationOccurred(ok ? "success" : "error");
}

export function confirmAction(message: string): Promise<boolean> {
  return new Promise((resolve) =>
    tg?.showConfirm ? tg.showConfirm(message, resolve) : resolve(window.confirm(message)),
  );
}

/** Шапка и фон Telegram в цвет приложения (у приложения своя тёмная тема). */
export function paintChrome(color: string): void {
  for (const set of [tg?.setHeaderColor, tg?.setBackgroundColor, tg?.setBottomBarColor]) {
    try {
      set?.call(tg, color);
    } catch {
      // старые клиенты Telegram этих методов не знают
    }
  }
}

/** Небольшие настройки приложения: в облаке Telegram (общие для телефона и ПК) и копия в localStorage. */
export const prefs = {
  getLocal(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  getCloud(key: string): Promise<string | null> {
    return new Promise((resolve) => {
      const cloud = tg?.CloudStorage;
      if (!cloud) return resolve(null);
      try {
        cloud.getItem(key, (err, value) => resolve(err ? null : value || null));
      } catch {
        resolve(null);
      }
    });
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      // приватный режим — останется только облако
    }
    try {
      tg?.CloudStorage?.setItem(key, value);
    } catch {
      // старый клиент Telegram
    }
  },
};
