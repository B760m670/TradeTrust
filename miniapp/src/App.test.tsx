// Приложение целиком в jsdom: ответ /api/status — настоящий JSON Python-бота (scripts/make_api_fixture.py).
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import status from "../../android/app/src/test/resources/bot_status.json";

vi.mock("./components/CandleChart", () => ({
  CandleChart: () => <div data-testid="chart" />,
  CHART_COLORS: { FAST: "#00f", SLOW: "#fa0", DOWN: "#f00" },
}));

type Call = { url: string; method: string; auth: string | null };
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
    },
  };
}

beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("Authorization") });
    const body = url === "/api/status" ? status
      : url.startsWith("/api/candles") ? { coin: "SOL", time: [], open: [], high: [], low: [], close: [], ema_fast: [], ema_slow: [], atr: [], position: null }
      : { message: "✅ Куплено" };
    return new Response(JSON.stringify(body), { status: 200 });
  }));
  vi.stubGlobal("scrollTo", () => {});
});

afterEach(() => {
  cleanup();
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
    expect(calls.some((c) => c.url === "/api/candles?coin=SOL")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Сигналы" }));
    await screen.findByText("Состояние");
  });
});
