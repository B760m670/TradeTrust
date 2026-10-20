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
  onEvent?(event: "themeChanged", cb: () => void): void;
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

export function platform(): "ios" | "base" {
  return tg && ["ios", "macos"].includes(tg.platform) ? "ios" : "base";
}
