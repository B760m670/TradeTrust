// Приложение целиком в jsdom: ответ /api/status — настоящий JSON Python-бота (scripts/make_api_fixture.py).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import status from "../../android/app/src/test/resources/bot_status.json";

vi.mock("./components/CandleChart", () => ({
  CandleChart: () => <div data-testid="chart" />,
  useChartColors: () => ({ fast: "#00f", slow: "#fa0", down: "#f00" }),
}));
vi.mock("./components/LineChart", () => ({ LineChart: () => <div data-testid="line-chart" /> }));
vi.mock("./components/EquityChart", () => ({ EquityChart: () => <div data-testid="equity-chart" /> }));

const PORTFOLIO = {
  total: 1500, updated_at: 0, bot: { capital: 1000, invested: 47, free: 942 },
  assets: [
    { coin: "USDT", qty: 1000, price: 1, value: 1000, bot_qty: 0, stable: true },
    { coin: "SOL", qty: 4.5, price: 100, value: 450, bot_qty: 0.457, stable: false },
    { coin: "TON", qty: 10, price: 5, value: 50, bot_qty: 0, stable: false },
  ],
};

class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  readyState = 0;
  sent: { op: string; args?: string[] }[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  push(topic: string, data: unknown) { this.onmessage?.({ data: JSON.stringify({ topic, data }) }); }
}

const now = Math.floor(Date.now() / 1000);
const ADMIN = {
  available: true,
  settings: { registration_open: true, notify_new_users: false, max_users: 100, demo_start_usdt: 1000 },
  stats: { total: 2, new_day: 1, new_week: 2, active_day: 1, active_week: 2, profitable: 1, losing: 1, blocked: 0,
    signups: Array.from({ length: 30 }, (_, i) => ({ day: (Math.floor(now / 86400) - 29 + i) * 86400, count: i === 29 ? 1 : 0 })) },
  users: [
    { id: "7", name: "Анна", username: "anna", joined_at: now - 3600, last_seen: now - 600, equity: 1012.5, start: 1000,
      pnl_pct: 1.25, positions: 2, trades: 3, wins: 2, mode: "auto", paused: null, blocked: false },
    { id: "8", name: "Борис", username: "", joined_at: now - 90000, last_seen: now - 90000, equity: 990, start: 1000,
      pnl_pct: -1, positions: 0, trades: 1, wins: 0, mode: "auto", paused: null, blocked: false },
  ],
  system: { version: "abc1234", built_at: "", started_at: now - 7200, now, env: "demo", mode: "auto", paused: null,
    last_scan: now - 1800, next_scan: now + 3600, bybit: { ok_at: now - 30, error_at: null, error: "" },
    telegram: { ok_at: now - 20, error: "" }, memory: { process_mb: 120, total_mb: 1800, available_mb: 900 },
    disk: { total_gb: 20, free_gb: 12, data_mb: 3.4 }, errors: [] },
};

type Call = { url: string; method: string; auth: string | null; body?: unknown };
let calls: Call[];

function setWidth(wide: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: wide && query.startsWith("(min-width"),
    addEventListener() {}, removeEventListener() {},
  }));
}

function installTelegram(initData: string) {
  window.Telegram = {
    WebApp: {
      initData, colorScheme: "dark", platform: "android", ready() {}, expand() {},
      BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
      showConfirm: (_: string, cb: (ok: boolean) => void) => cb(true),
      setHeaderColor: vi.fn(),
      CloudStorage: { getItem: (_: string, cb: (e: unknown, v?: string) => void) => cb(null, ""), setItem: vi.fn() },
    },
  };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("Authorization"),
      body: init.body ? JSON.parse(init.body as string) : undefined });
    const body = url === "/api/status" ? status
      : url === "/api/portfolio" ? PORTFOLIO
      : url === "/api/admin" ? ADMIN
      : url.startsWith("/api/candles") ? { coin: "SOL", interval: new URL(url, "http://x").searchParams.get("interval"),
        time: [], open: [], high: [], low: [], close: [], ema_fast: [], ema_slow: [], atr: [], position: null }
      : { message: "✅ Куплено" };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  vi.stubGlobal("scrollTo", () => {});
  vi.stubGlobal("WebSocket", FakeWebSocket);
  FakeWebSocket.last = null;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.unstubAllGlobals();
  vi.resetModules();
  delete window.Telegram;
});

async function renderApp(initData = "query_id=1&hash=abc", wide = false) {
  installTelegram(initData);
  setWidth(wide);
  const { App } = await import("./App"); // tg читается при загрузке модуля
  render(<App />);
}

describe("mini app", () => {
  it("asks to open via Telegram without initData", async () => {
    await renderApp("");
    expect(screen.getByText(/Откройте приложение через своего Telegram-бота/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("shows the account, pending trade and positions from the bot", async () => {
    await renderApp();
    await screen.findByText("Вход ETH");
    expect(calls[0]).toEqual({ url: "/api/status", method: "GET", auth: "tma query_id=1&hash=abc" });
    expect(screen.getByText("Бумажный счёт")).toBeTruthy();
    expect(screen.getAllByText("SOL").length).toBeGreaterThan(0);
    expect(document.documentElement.dataset.theme).toBe("dark"); // «Авто» — как в Telegram
    expect(screen.getByText("Стоп 80,77")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Вручную", checked: true })).toBeTruthy();
    expect(window.Telegram!.WebApp.setHeaderColor).toHaveBeenCalledWith("#07080D");
  });

  it("asks before switching to auto mode", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("radio", { name: "Авто" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/mode");
  });

  it("confirms a trade with one tap", async () => {
    await renderApp();
    fireEvent.click(await screen.findByText("Купить"));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/proposals/${status.proposals[0].id}/confirm`);
    expect(post.auth).toBe("tma query_id=1&hash=abc");
    await screen.findByText("✅ Куплено");
  });

  it("opens a coin card and the journal", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Сигналы" }));
    fireEvent.click(await screen.findByText("LINK", { selector: "strong" }));
    await screen.findByText("Индикаторы");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Журнал" })));
    await screen.findByText("Profit factor");
    expect(screen.getByText("сработал стоп", { exact: false })).toBeTruthy();
  });

  it("uses a sidebar and shows a chart on a wide screen", async () => {
    await renderApp(undefined, true);
    await screen.findByText("Вход ETH");
    expect(document.querySelector(".sidebar")).toBeTruthy();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    expect(screen.getByTestId("chart")).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/candles?coin=SOL&interval=4h")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "1ч" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/candles?coin=SOL&interval=1h")).toBe(true));
    await screen.findByText(/бот решает по 4ч/);
    fireEvent.click(screen.getByRole("radio", { name: "Линия" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/candles?coin=SOL&interval=1m")).toBe(true));
    expect(await screen.findByTestId("line-chart")).toBeTruthy();
    expect(localStorage.getItem("chart_tf")).toBe("line");
    fireEvent.click(screen.getByRole("button", { name: "Сигналы" }));
    await screen.findByText("Состояние");
  });

  it("switches to the light theme and remembers it", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Светлая" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect(window.Telegram!.WebApp.CloudStorage!.setItem).toHaveBeenCalledWith("theme", "light");
    expect(window.Telegram!.WebApp.setHeaderColor).toHaveBeenLastCalledWith("#F3F3F7");
  });

  it("explains that new entries wait while bitcoin is below its average", async () => {
    const scan = status.last_scan;
    Object.assign(status, { last_scan: { ...scan, held_back: ["SOL"], btc: { ok: false, days: 50, price: 60000, avg: 65000 } } });
    try {
      await renderApp();
      expect(await screen.findByText(/Биткоин ниже 50-дневной средней/)).toBeTruthy();
      expect(screen.getByText(/Пропущены сигналы: SOL/)).toBeTruthy();
    } finally {
      Object.assign(status, { last_scan: scan });
    }
  });

  it("tells a demo user that the account is virtual", async () => {
    Object.assign(status, { account: "demo" });
    try {
      await renderApp();
      expect(await screen.findByText("Это ваш демо-счёт")).toBeTruthy();
      expect(screen.getAllByText("Демо-счёт").length).toBeGreaterThan(0);
    } finally {
      Object.assign(status, { account: "owner" });
    }
  });

  it("shows the admin panel only to the owner", async () => {
    Object.assign(status, { admin: false });
    await renderApp();
    await screen.findByRole("button", { name: "Настройки" });
    expect(screen.queryByRole("button", { name: "Админ" })).toBeNull();
    cleanup();
    vi.resetModules();
    Object.assign(status, { admin: true });
    try {
      await renderApp();
      fireEvent.click(await screen.findByRole("button", { name: "Админ" }));
      expect(await screen.findByText("Пользователей")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Люди" }));
      fireEvent.change(screen.getByLabelText("Поиск пользователей"), { target: { value: "@anna" } });
      expect(screen.getByText("Анна")).toBeTruthy();
      expect(screen.queryByText("Борис")).toBeNull();
      fireEvent.click(screen.getByText("Анна"));
      fireEvent.click(screen.getByRole("button", { name: "Заблокировать" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/admin/users/7/block" && c.method === "POST")).toBe(true));
      fireEvent.click(screen.getByRole("radio", { name: "Система" }));
      expect(screen.getByText(/abc1234/)).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Опции" }));
      fireEvent.click(screen.getByRole("switch", { name: "Регистрация новых" }));
      fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/admin/settings")?.body).toEqual({ registration_open: false }));
    } finally {
      Object.assign(status, { admin: false });
    }
  });

  it("saves only the changed settings after confirmation", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
    const risk = await screen.findByRole("group", { name: "Риск на сделку" });
    fireEvent.click(within(risk).getByRole("button", { name: "Больше" }));
    expect(within(risk).getByText("1,25%")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Пауза, когда BTC падает" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/settings");
    expect(post.body).toEqual({ risk_pct: 1.25, btc_filter: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull());
  });

  it("will not save an empty coin list", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
    fireEvent.click(await screen.findByText("Снять все"));
    expect(screen.getByText("Выберите хотя бы одну монету.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Сохранить" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("streams live prices from the exchange into positions and equity", async () => {
    await renderApp();
    await screen.findByText("Вход ETH");
    await waitFor(() => expect(FakeWebSocket.last?.readyState).toBe(1));
    const ws = FakeWebSocket.last!;
    expect(ws.url).toBe("wss://stream.bybit.com/v5/public/spot");
    expect(ws.sent.flatMap((m) => m.args ?? [])).toContain("tickers.SOLUSDT");
    const pos = status.positions[0];
    act(() => ws.push("tickers.SOLUSDT", { lastPrice: String(pos.entry + 10), price24hPcnt: "0.05" }));
    const pnl = (10 * pos.qty).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    await screen.findByText(`+${pnl} $`, {}, { timeout: 2000 });
    expect(screen.getByText("онлайн")).toBeTruthy();
  });

  it("shows the equity chart and daily summary settings", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Журнал" }));
    await screen.findByText("Худшая просадка");
    expect(screen.getByTestId("equity-chart")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Ежедневная сводка" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ daily_report: false }));
  });

  it("shows the whole account in the portfolio with live prices", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Портфель" }));
    await screen.findByText("Кто управляет");
    expect(calls.some((c) => c.url === "/api/portfolio" && c.auth === "tma query_id=1&hash=abc")).toBe(true);
    expect(screen.getByText("частично бот")).toBeTruthy();
    expect(screen.getByRole("img", { name: /USDT 66,7%, SOL 30,0%, TON 3,3%/ })).toBeTruthy();
    await waitFor(() => expect(FakeWebSocket.last?.sent.flatMap((m) => m.args ?? [])).toContain("tickers.TONUSDT"));
    act(() => FakeWebSocket.last!.push("tickers.TONUSDT", { lastPrice: "10", price24hPcnt: "1" }));
    await screen.findByText("100,00 $", {}, { timeout: 2000 }); // 10 TON × 10 $
    expect(screen.getByText("+50,00 $ · +3,3%")).toBeTruthy(); // TON удвоился: +50 $ к прежним 1500 $
  });

  it("shows when the bot last checked the market", async () => {
    await renderApp();
    await screen.findByText(/Бот проверил рынок в/);
    expect(screen.getByText(/следующая в/)).toBeTruthy();
  });
});
