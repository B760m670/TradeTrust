// Приложение целиком в jsdom: ответ /api/status — настоящий JSON Python-бота (scripts/make_api_fixture.py).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import status from "../../android/app/src/test/resources/bot_status.json";

vi.mock("./components/CandleChart", () => ({
  CandleChart: () => <div data-testid="chart" />,
  SUB_HEIGHT: 72,
  useChartColors: () => ({ fast: "#00f", slow: "#fa0", down: "#f00" }),
}));
vi.mock("./components/EquityChart", () => ({ EquityChart: () => <div data-testid="equity-chart" /> }));

const PORTFOLIO = {
  total: 1500, updated_at: 0, bot: { capital: 1000, invested: 47, free: 942 },
  assets: [
    { coin: "USDT", qty: 1000, price: 1, value: 1000, bot_qty: 0, stable: true },
    { coin: "SOL", qty: 4.5, price: 100, value: 450, bot_qty: 0.457, stable: false },
    { coin: "TON", qty: 10, price: 5, value: 50, bot_qty: 0, stable: false },
  ],
};

const P2P_AD = { id: "a1", nick: "seller1", price: 82.6, quantity: 500, min_amount: 1000, max_amount: 50000,
  payments: ["75"], orders: 320, rate: 99, online: true, tags: ["VA"] };
const P2P_VIEW = {
  available: true, currencies: ["RUB", "USD"], currency: "RUB", error: "",
  account: { nickName: "owner", recentRate: 100, recentFinishCount: 4 },
  market: { currency: "RUB", prefs: { amount: 10000, payments: ["75"], min_rate: 90, min_orders: 20, alert_pct: 0,
    fee_buy_pct: 0.3, fee_sell_pct: 0, extra_pct: 0, limits: {}, month_cap: 3500000 },
    updated_at: 1, bid: 81.9, ask: 82.6, gross_pct: 0.85, costs_pct: 0.3, ad_fee_pct: 0, maker_pct: 0.55, taker_pct: -0.85, bids: [{ ...P2P_AD, id: "b1", price: 81.9 }],
    asks: [P2P_AD], total: { bids: 4, asks: 4 }, payments: [{ id: "75", name: "Tinkoff", ads: 7, mine: true }, { id: "14", name: "способ #14", ads: 2, mine: false }] },
  pending: [{ id: "o1", side: "sell", status: 20, status_text: "оплачен — ждём, пока продавец отпустит монеты", price: 82.4,
    amount: 8240, qty: 100, currency: "RUB", token: "USDT", who: "Ivan", created: 1700000000000, seconds_left: 0 }],
  stats: {},
  ledger: { currency: "RUB", turnover: 2900000, month_cap: 3500000, people_day: 3, people_month: 41, month: "10.2026",
    warnings: [{ key: "cap:month", text: "Оборот за месяц 2 900 000 из 3 500 000 RUB (83%) — порог, который вы задали" }],
    cards: [{ pay: "75", name: "Tinkoff", day_in: 12450, day_out: 8200, month_in: 1500000, month_out: 1400000, people: 30, limit: { day: 300000 } }] },
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

type Call = { url: string; method: string; auth: string | null; body?: unknown; account?: string };
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
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method ?? "GET", auth: headers.get("Authorization"),
      body: init.body ? JSON.parse(init.body as string) : undefined,
      ...(headers.get("X-Account") ? { account: headers.get("X-Account")! } : {}) });
    const body = url === "/api/status" ? status
      : url === "/api/portfolio" ? PORTFOLIO
      : url === "/api/admin" ? ADMIN
      : url === "/api/exchanges" ? { total: 12450, exchanges: [
        { name: "Bybit", connected: true, error: "", warnings: [], total: 10169, updated_at: 1700000000, assets: [{ coin: "ETH", qty: 4.1, price: 2480, value: 10168 }] },
        { name: "OKX", connected: false, error: "у ключа OKX есть право торговли (trade) — для этого раздела нужен ключ только для чтения", warnings: [] }],
        coins: [{ coin: "NIGHT", qty: 1000, value: 40, where: { OKX: 1000 }, closed: { OKX: { deposit: true, withdraw: false } } }] }
      : url.startsWith("/api/venues") ? { coin: "SOL", range_pct: 0.05, missing: ["KuCoin"], transfer: { Bybit: { deposit: true, withdraw: false } }, rows: [
        { exchange: "bybit_spot", name: "Bybit", price: 100.02, spread_pct: 0.01, volume_usd: 2e8, stale: false, anomaly: false, thin: false, url: "https://www.bybit.com/trade/spot/SOL/USDT", diff_pct: 0.02 },
        { exchange: "okex", name: "OKX", price: 99.9, spread_pct: 0.01, volume_usd: 9e7, stale: true, anomaly: false, thin: false, url: null, diff_pct: null }] }
      : url.startsWith("/api/p2p?") || url === "/api/p2p" ? P2P_VIEW
      : url === "/api/p2p/prefs" ? { message: "Сохранено", prefs: P2P_VIEW.market.prefs }
      : url === "/api/p2p/journal" ? { message: "Журнал отправлен в Telegram: 41 ордеров" }
      : url.startsWith("/api/candles") ? { coin: "SOL", interval: new URL(url, "http://x").searchParams.get("interval"),
        time: [1000, 1900], open: [10, 11], high: [12, 12], low: [9, 10], close: [11, 11.5], volume: [5, 6], ema_fast: [], ema_slow: [], atr: [], position: null }
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

const openBot = async () => fireEvent.click(await screen.findByRole("button", { name: /Трендовый бот/ }));

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
    expect(screen.getAllByText("ДЕМО").length).toBeGreaterThan(0);
    expect(screen.getAllByText("SOL").length).toBeGreaterThan(0);
    expect(document.documentElement.dataset.theme).toBe("dark"); // «Авто» — как в Telegram
    expect(screen.getByText("Стоп 80,77")).toBeTruthy();
    expect(screen.getByText("Торговые боты")).toBeTruthy();
    expect(window.Telegram!.WebApp.setHeaderColor).toHaveBeenCalledWith("#08090C");
    await openBot();
    expect(await screen.findByRole("radio", { name: "Вручную", checked: true })).toBeTruthy();
  });

  it("asks before switching to auto mode", async () => {
    await renderApp();
    await openBot();
    fireEvent.click(await screen.findByRole("radio", { name: "Авто" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")!.url).toBe("/api/mode");
  });

  it("confirms a trade with one tap", async () => {
    await renderApp();
    fireEvent.click((await screen.findAllByRole("button", { name: "Купить" })).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`/api/proposals/${status.proposals[0].id}/confirm`);
    expect(post.auth).toBe("tma query_id=1&hash=abc");
    await screen.findByText("✅ Куплено");
  });

  it("opens a pair from markets and the history in assets", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Рынки" }));
    fireEvent.click(await screen.findByText("LINK", { selector: "strong" }));
    expect(await screen.findByRole("button", { name: "Выбрать пару" })).toBeTruthy();
    expect(screen.getByText("LINK", { selector: ".pair-name strong" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Индикаторы" }));
    await screen.findByText("Что видит бот");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Активы" })));
    fireEvent.click(await screen.findByRole("tab", { name: "История" }));
    await screen.findByText("Profit factor");
    expect(screen.getByText("сработал стоп", { exact: false })).toBeTruthy();
  });

  it("shows the owner's open Bybit orders for the coin, without the bot's stops", async () => {
    const tp = { id: "tp1", coin: "SOL", side: "sell", kind: "tp", type: "market", price: null, trigger: 142, qty: 4.5, created: 1, bot: false };
    const botStop = { ...tp, id: "s1", kind: "sl", trigger: 90, bot: true };
    Object.assign(PORTFOLIO, { open_orders: [tp, botStop] });
    try {
      await renderApp();
      const nav = within(await waitFor(() => document.querySelector(".bottom-nav") as HTMLElement));
      fireEvent.click(nav.getByRole("button", { name: "Торговать" }));
      fireEvent.click(await screen.findByRole("tab", { name: "Мои сделки" }));
      const card = (await screen.findByText("Открытые ордера")).closest(".card") as HTMLElement;
      expect(within(card).getByText(/Тейк-профит · при цене ≥ 142/)).toBeTruthy();
      expect(within(card).getAllByText("4,5 SOL")).toHaveLength(1); // стоп бота здесь не показываем
    } finally {
      Object.assign(PORTFOLIO, { open_orders: undefined });
    }
  });

  it("shows the owner's P2P spread, orders and saves filters", async () => {
    Object.assign(status, { p2p: true });
    try {
      await renderApp();
      fireEvent.click(await screen.findByRole("button", { name: /P2P · USDT/ }));
      expect(await screen.findByText("Спред сейчас")).toBeTruthy();
      expect(screen.getByText("+0,55%")).toBeTruthy(); // чистыми: 0,85% до расходов минус 0,3% комиссии мейкера
      expect(screen.getByText(/Оборот за месяц 2 900 000 из 3 500 000/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Прислать журнал сделок в Telegram" }));
      expect(await screen.findByText("Журнал отправлен в Telegram: 41 ордеров")).toBeTruthy();
      expect(screen.getByText(/проверьте поступление в банке/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "способ #14" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/p2p/prefs")?.body).toEqual({ currency: "RUB", payments: ["75", "14"] }));
    } finally {
      Object.assign(status, { p2p: undefined });
    }
  });

  it("compares the coin's price on the owner's exchanges", async () => {
    await renderApp();
    const nav = within(await waitFor(() => document.querySelector(".bottom-nav") as HTMLElement));
    fireEvent.click(nav.getByRole("button", { name: "Торговать" }));
    fireEvent.click(await screen.findByRole("tab", { name: "Биржи" }));
    expect(await screen.findByRole("link", { name: "Bybit" })).toBeTruthy();
    expect(screen.getByText("данные устарели")).toBeTruthy();
    expect(screen.getByText("вывод закрыт")).toBeTruthy(); // по ключам владельца: на Bybit вывод SOL закрыт
    expect(screen.getByText(/нет пары на: KuCoin/)).toBeTruthy();
    expect(calls.some((c) => c.url === "/api/venues?coin=SOL")).toBe(true);
  });

  it("shows the owner's exchanges with rejected keys and closed withdrawals", async () => {
    Object.assign(status, { exchanges: true });
    try {
      await renderApp();
      fireEvent.click(await screen.findByRole("button", { name: /Bybit · Binance · OKX · KuCoin/ }));
      expect(await screen.findByText(/право торговли \(trade\)/)).toBeTruthy();
      expect(screen.getByText("OKX: вывод закрыт")).toBeTruthy();
    } finally {
      Object.assign(status, { exchanges: undefined });
    }
  });

  it("buys by hand on the trade screen", async () => {
    await renderApp();
    const nav = within(await waitFor(() => document.querySelector(".bottom-nav") as HTMLElement));
    fireEvent.click(nav.getByRole("button", { name: "Торговать" }));
    fireEvent.click(within(await waitFor(() => document.querySelector(".trade-bar") as HTMLElement)).getByRole("button", { name: /^Купить/ }));
    fireEvent.change(await screen.findByLabelText("Сумма в USDT"), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /^Купить SOL$/ }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/order")?.body).toEqual({ coin: "SOL", side: "buy", usdt: 50 }));
  });

  it("uses a sidebar and shows a chart on a wide screen", async () => {
    await renderApp(undefined, true);
    await screen.findByText("Вход ETH");
    expect(document.querySelector(".sidebar")).toBeTruthy();
    expect(document.querySelector(".bottom-nav")).toBeNull();
    const nav = within(document.querySelector(".side-nav") as HTMLElement);
    fireEvent.click(nav.getByRole("button", { name: "Торговать" }));
    // один график: история с сервера бота, по умолчанию 15 минут
    await waitFor(() => expect(calls.some((c) => c.url === "/api/candles?coin=SOL&interval=15m")).toBe(true));
    fireEvent.click(screen.getByRole("radio", { name: "4ч" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/candles?coin=SOL&interval=4h")).toBe(true));
    expect(localStorage.getItem("chart_tf")).toBe("4h");
    expect(await screen.findByTestId("chart")).toBeTruthy();
    // ряд индикаторов, как у Bybit: основной один, окна под графиком — по нажатию
    fireEvent.click(screen.getByRole("button", { name: "BOLL" }));
    expect(localStorage.getItem("chart_main")).toBe("BOLL");
    expect(screen.getByRole("button", { name: "EMA" }).getAttribute("aria-pressed")).toBe("false");
    for (const k of ["MACD", "RSI", "KDJ"]) fireEvent.click(screen.getByRole("button", { name: k }));
    expect(localStorage.getItem("chart_sub")).toBe("RSI,KDJ");
    fireEvent.click(nav.getByRole("button", { name: "Рынки" }));
    await screen.findByText("Сигнал бота");
  });

  it("switches to the light theme and remembers it", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки" }));
    fireEvent.click(await screen.findByRole("radio", { name: "Светлая" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("theme")).toBe("light");
    expect(window.Telegram!.WebApp.CloudStorage!.setItem).toHaveBeenCalledWith("theme", "light");
    expect(window.Telegram!.WebApp.setHeaderColor).toHaveBeenLastCalledWith("#F3F4F7");
  });

  it("explains that new entries wait while bitcoin is below its average", async () => {
    const scan = status.last_scan;
    Object.assign(status, { last_scan: { ...scan, held_back: ["SOL"], btc: { ok: false, days: 50, price: 60000, avg: 65000 } } });
    try {
      await renderApp();
      await openBot();
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
      expect(screen.getAllByText("ДЕМО").length).toBeGreaterThan(0);
    } finally {
      Object.assign(status, { account: "owner" });
    }
  });

  it("switches the owner between the demo and the real account", async () => {
    const accounts = { active: "main", real_configured: true, real_error: "", list: [
      { id: "main", label: "Демо-счёт Bybit", env: "demo", real: false },
      { id: "real", label: "Реальный счёт Bybit", env: "mainnet", real: true },
    ] };
    Object.assign(status, { accounts });
    const confirm = vi.fn((_: string, cb: (ok: boolean) => void) => cb(true));
    try {
      await renderApp();
      window.Telegram!.WebApp.showConfirm = confirm;
      fireEvent.click(await screen.findByRole("radio", { name: "РЕАЛЬНЫЙ" }));
      const sheet = within(await screen.findByRole("dialog", { name: "Счёт" }));
      expect(sheet.getAllByText(/настоящие деньги/).length).toBeGreaterThan(0);
      fireEvent.click(sheet.getByRole("button", { name: "Перейти на реальный" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/account")?.body).toEqual({ account: "real" }));
      // каждое действие говорит серверу, какой счёт на экране, — на другом счёте оно не выполнится
      fireEvent.click((await screen.findAllByRole("button", { name: "Купить" })).at(-1)!);
      await waitFor(() => expect(calls.find((c) => c.url.includes("/confirm"))?.account).toBe("main"));
    } finally {
      Object.assign(status, { accounts: undefined });
    }
  });

  it("switches between spot and futures of the same account on the trade screen", async () => {
    const accounts = { active: "main", real_configured: false, real_error: "", list: [
      { id: "main", label: "Демо-счёт Bybit", env: "demo", real: false, market: "spot" },
      { id: "futures", label: "Демо-счёт Bybit · фьючерсы", env: "demo", real: false, market: "linear" },
    ] };
    Object.assign(status, { accounts });
    try {
      await renderApp();
      fireEvent.click(within(document.querySelector(".bottom-nav") as HTMLElement).getByRole("button", { name: "Торговать" }));
      expect((await screen.findByRole("radio", { name: "Спот" })).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("radio", { name: "Фьючерсы" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/account")?.body).toEqual({ account: "futures" }));
    } finally {
      Object.assign(status, { accounts: undefined });
    }
  });

  it("explains how to connect a real account and lets the owner turn the bot on", async () => {
    Object.assign(status, { enabled: false, accounts: { active: "main", real_configured: false, real_error: "",
      list: [{ id: "main", label: "Демо-счёт Bybit", env: "demo", real: false }] } });
    try {
      await renderApp();
      expect(await screen.findByText("ВЫКЛ")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Включить" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/bot")?.body).toEqual({ enabled: true }));
      fireEvent.click(screen.getByRole("radio", { name: "РЕАЛЬНЫЙ" }));
      expect(await screen.findByText("Реальный счёт не подключён")).toBeTruthy();
      expect(screen.getByText("BYBIT_REAL_API_KEY")).toBeTruthy();
    } finally {
      Object.assign(status, { enabled: undefined, accounts: undefined });
    }
  });

  it("opens the admin panel only from the Telegram button and only for the owner", async () => {
    Object.assign(status, { admin: true });
    await renderApp();
    await screen.findByText("Торговые боты");
    expect(screen.queryByRole("button", { name: "Админ" })).toBeNull();   // в приложении админки нет
    cleanup();
    vi.resetModules();
    window.history.replaceState(null, "", "/?page=admin");
    try {
      await renderApp();
      expect(await screen.findByText("Пользователей")).toBeTruthy();
      expect(document.querySelector(".bottom-nav")).toBeNull();
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
      cleanup();
      vi.resetModules();
      Object.assign(status, { admin: false });
      await renderApp();
      expect(await screen.findByText("Нет доступа")).toBeTruthy();
    } finally {
      Object.assign(status, { admin: false });
      window.history.replaceState(null, "", "/");
    }
  });

  it("saves only the changed settings after confirmation", async () => {
    await renderApp();
    await openBot();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки бота" }));
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
    await openBot();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки бота" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Активы" }));
    fireEvent.click(await screen.findByRole("tab", { name: "История" }));
    await screen.findByText("Худшая просадка");
    expect(screen.getByTestId("equity-chart")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Главная" }));
    await openBot();
    fireEvent.click(await screen.findByRole("button", { name: "Настройки бота" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Ежедневная сводка" }));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ daily_report: false }));
  });

  it("shows the whole account in the portfolio with live prices", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Активы" }));
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
    await openBot();
    await screen.findByText(/Бот проверил рынок в/);
    expect(screen.getByText(/следующая в/)).toBeTruthy();
  });
});
