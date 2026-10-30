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
  my_ads: [{ id: "m1", side: "sell", token: "USDT", currency: "RUB", price: 82.9, left: 900, total: 995, done: 95,
    min_amount: 5000, max_amount: 30000, payments: ["Tinkoff"], online: true, status_text: "в сети", fee_pct: 0.3,
    rank: 3, rank_pay: 2, best_rival: 82.85, top_price: 82.84 }],
  level: { counterparties: 4, volume_30d: 450, next: "Регулярный", levels: [
    { name: "Регулярный", people: 5, volume: 2000, perks: "покупка и продажа", done: false },
    { name: "Опытный", people: 5, volume: 10000, perks: "до 50 000 USDT", done: false }] },
  notify: "important",
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
      : url === "/api/p2p/ad" ? { message: "Готово" }
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
      fireEvent.click(await screen.findByRole("button", { name: "P2P" }));
      expect(await screen.findByText("Моё объявление · продажа")).toBeTruthy(); // вкладка «Мейкер» — первая
      expect(screen.getByText(/До уровня «Регулярный»/)).toBeTruthy();
      expect(screen.getByText(/Покупатель отметил оплату/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: /Стать #1 · 82,84/ }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/p2p/ad")?.body).toEqual({ id: "m1", action: "price", value: 82.84 }));
      fireEvent.click(screen.getByRole("button", { name: "Снять с публикации" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/p2p/ad" && (c.body as { action: string }).action === "offline")).toBe(true));
      expect(screen.getByText("Круг: купил → продал")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "Все" }));
      await waitFor(() => expect(calls.some((c) => c.url === "/api/p2p/prefs" && (c.body as { notify?: string }).notify === "all")).toBe(true));
      fireEvent.click(screen.getByRole("tab", { name: "Рынок" }));
      expect(await screen.findByText("Стакан сейчас")).toBeTruthy();
      expect(screen.getByText("+0,55%")).toBeTruthy(); // чистыми: 0,85% до расходов минус 0,3% комиссии мейкера
      fireEvent.click(screen.getByRole("button", { name: "способ #14" }));
      await waitFor(() => expect(calls.find((c) => c.url === "/api/p2p/prefs" && (c.body as { payments?: string[] }).payments)?.body).toEqual({ currency: "RUB", payments: ["75", "14"] }));
      fireEvent.click(screen.getByRole("tab", { name: /Ордера/ }));
      expect(await screen.findByText(/Отпускайте USDT в Bybit, только когда деньги видны в банке/)).toBeTruthy();
      fireEvent.click(screen.getByRole("tab", { name: "Карты" }));
      expect(await screen.findByText(/Оборот за месяц 2 900 000 из 3 500 000/)).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Прислать журнал сделок в Telegram" }));
      expect(await screen.findByText("Журнал отправлен в Telegram: 41 ордеров")).toBeTruthy();
    } finally {
      Object.assign(status, { p2p: undefined });
    }
  });

  it("read-only real account: no trade buttons, P2P up front", async () => {
    Object.assign(status, { p2p: true, read_only: true });
    try {
      await renderApp();
      expect(await screen.findByText(/P2P · мейкер/)).toBeTruthy(); // карточка P2P — сразу под балансом
      expect(screen.queryByText("Торговые боты")).toBeNull();
      const quick = document.querySelector(".quick")!;
      expect(quick.textContent).toContain("P2P");
      expect(quick.textContent).not.toContain("Купить");
    } finally {
      Object.assign(status, { p2p: undefined, read_only: undefined });
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
      fireEvent.click(await screen.findByRole("button", { name: "Биржи" }));
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
    await screen.findByText("Баланс Bybit · USD");
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

  it("opens the admin panel only from the Telegram button and only for the owner", async () => {
    Object.assign(status, { admin: true });
    await renderApp();
    await screen.findByText("Баланс Bybit · USD");
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

  it("shows the equity chart in the history", async () => {
    await renderApp();
    fireEvent.click(await screen.findByRole("button", { name: "Активы" }));
    fireEvent.click(await screen.findByRole("tab", { name: "История" }));
    await screen.findByText("Худшая просадка");
    expect(screen.getByTestId("equity-chart")).toBeTruthy();
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
});
