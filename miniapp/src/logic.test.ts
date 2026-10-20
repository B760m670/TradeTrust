import { describe, expect, it } from "vitest";
import type { EditableSettings, Equity, Position, Settings, Status, Trade } from "./api";
import { dateTime, pct, price, rMultiple, usd } from "./format";
import {
  changedSettings, coinState, emaGap, entryPlan, filterRows, journalStats, nextCandleClose, rangeMarks, signalRows,
  allocation, dayChange, localTime, maxDrawdown, stepValue, stopRisk, withLivePrices,
} from "./logic";

const editable: EditableSettings = {
  risk_pct: 1, max_positions: 5, max_position_pct: 25, max_total_risk_pct: 5, daily_loss_limit_pct: 3,
  capital_usdt: 0, proposal_ttl_min: 60, report_hour_utc: 7, btc_filter: false, daily_report: true, coins: ["BTC", "ETH"],
};
const settings: Settings = { ...editable, atr_mult: 2, ema_fast: 20, ema_slow: 50 };
const equity: Equity = { total: 1000, free: 1000, usdt: 1000, invested: 0, unrealized: 0 };

describe("format", () => {
  it("formats prices the Russian way", () => {
    expect(price(81880.82)).toBe("81\u00a0880,8");
    expect(price(0.19201)).toBe("0,192");
    expect(price(null)).toBe("—");
  });
  it("formats money, percent and R with real minus signs", () => {
    expect(usd(1.384, true)).toBe("+1,38");
    expect(usd(-10.42, true)).toBe("−10,42");
    expect(usd(-3)).toBe("−3,00");
    expect(pct(21.25)).toBe("21,3%");
    expect(pct(-2.9, true)).toBe("−2,9%");
    expect(rMultiple(-1.04)).toBe("−1,04R");
  });
  it("formats dates", () => {
    expect(dateTime(0)).toMatch(/^\d\d\.\d\d, \d\d:\d\d$/);
  });
});

describe("coinState", () => {
  it("matches what the bot sees on the last candle", () => {
    const kind = (sig: Parameters<typeof coinState>[0], held = false) => coinState(sig, held).kind;
    expect(kind({ cross_up: true, regime_ok: true })).toBe("entry");
    expect(coinState({ cross_up: true, regime_ok: true }, false).label).toBe("Вход");
    expect(kind({ cross_up: true, regime_ok: false })).toBe("filtered");
    expect(kind({ cross_up: true, regime_ok: true }, true)).toBe("held");
    expect(kind({ trend_down: true })).toBe("down");
    expect(kind({})).toBe("up");
    expect(kind({ error: "x" })).toBe("none");
    expect(kind(undefined)).toBe("none");
  });
  it("sorts entries first, then held, then by name", () => {
    const rows = signalRows({
      ETH: { trend_down: true }, SOL: {}, ARB: { cross_up: true, regime_ok: true }, BTC: { trend_down: true },
    }, new Set(["SOL"]));
    expect(rows.map((r) => r.coin)).toEqual(["ARB", "SOL", "BTC", "ETH"]);
  });
  it("filters by state; a BTC-filtered cross still counts as an uptrend", () => {
    const rows = signalRows({
      ETH: { trend_down: true }, SOL: {}, ARB: { cross_up: true, regime_ok: true }, OP: { cross_up: true },
    }, new Set());
    expect(filterRows(rows, "entry").map((r) => r.coin)).toEqual(["ARB"]);
    expect(filterRows(rows, "up").map((r) => r.coin)).toEqual(["OP", "SOL"]);
    expect(filterRows(rows, "down").map((r) => r.coin)).toEqual(["ETH"]);
    expect(filterRows(rows, "all")).toHaveLength(4);
  });
  it("measures the EMA gap", () => {
    expect(emaGap({ ema_fast: 105, ema_slow: 100 })).toBeCloseTo(5, 9);
    expect(emaGap({ ema_fast: 1 })).toBeNull();
  });
});

describe("entryPlan", () => {
  it("risks 1% of equity to a 2×ATR stop", () => {
    const plan = entryPlan({ price: 0.192, atr: 0.00646 }, settings, equity)!;
    expect(plan.stop).toBeCloseTo(0.17908, 5);
    expect(plan.risk).toBeCloseTo(10, 6);
    expect(plan.stopPct).toBeCloseTo(6.73, 2);
  });
  it("never spends more than free cash", () => {
    const plan = entryPlan({ price: 100, atr: 0.01 }, settings, { ...equity, free: 50 })!;
    expect(plan.cost).toBeCloseTo(50, 6);
  });
  it("needs price and ATR", () => {
    expect(entryPlan({ price: 1 }, settings, equity)).toBeNull();
  });
});

describe("journalStats", () => {
  const trade = (pnl: number, r: number | null): Trade => ({
    id: 1, coin: "X", qty: 1, entry: 1, stop: 1, exit: 1, opened_at: 0, closed_at: 0, reason: "stop", pnl_usdt: pnl, r,
  });
  it("computes win rate, total, average R and profit factor", () => {
    const st = journalStats([trade(20, 2), trade(-10, -1), trade(-10, -1), trade(30, null)]);
    expect(st).toEqual({ count: 4, winRate: 50, pnl: 30, avgR: 0, profitFactor: 2.5 });
  });
  it("is empty-safe", () => {
    expect(journalStats([])).toEqual({ count: 0, winRate: null, pnl: 0, avgR: null, profitFactor: null });
  });
});

describe("positions", () => {
  const pos = (o: Partial<Position>): Position => ({
    coin: "SOL", qty: 2, entry: 100, stop: 90, price: 110, pnl_usdt: 20, opened_at: 0, ...o,
  });
  it("sums the loss if every stop is hit from the current price", () => {
    expect(stopRisk([pos({}), pos({ qty: 1, price: 95 })])).toBeCloseTo(45, 9);
    expect(stopRisk([pos({ price: 85 })])).toBe(0);
    expect(stopRisk([])).toBe(0);
  });
  it("places entry and price on the stop-to-top bar", () => {
    const m = rangeMarks(pos({}));
    expect(m.entry).toBeCloseTo((10 / 23) * 100, 6);
    expect(m.price).toBeCloseTo((20 / 23) * 100, 6);
    expect(rangeMarks(pos({ price: 80 })).price).toBe(0);
  });
  it("knows when the 4h candle closes", () => {
    expect(nextCandleClose(0)).toBe(14400);
    expect(nextCandleClose(14399)).toBe(14400);
    expect(nextCandleClose(14400)).toBe(28800);
  });
});

describe("settings form", () => {
  it("sends only what changed", () => {
    expect(changedSettings({ ...editable }, editable)).toEqual({});
    expect(changedSettings({ ...editable, risk_pct: 0.5, coins: ["BTC"] }, editable))
      .toEqual({ risk_pct: 0.5, coins: ["BTC"] });
    expect(changedSettings({ ...editable, coins: ["BTC", "ETH"] }, editable)).toEqual({});
  });
  it("steps within limits without float noise", () => {
    expect(stepValue(1, -1, 0.25, 0.1, 3)).toBe(0.75);
    expect(stepValue(0.1, 1, 0.25, 0.1, 3)).toBe(0.25);
    expect(stepValue(0.25, -1, 0.25, 0.1, 3)).toBe(0.1);
    expect(stepValue(3, 1, 0.25, 0.1, 3)).toBe(3);
    expect(stepValue(0.3, 1, 0.1, 0, 1)).toBe(0.4);
  });
});

describe("withLivePrices", () => {
  const status = {
    equity: { total: 1000, free: 900, usdt: 900, invested: 100, unrealized: 0 },
    positions: [{ coin: "SOL", qty: 1, entry: 100, stop: 90, price: 100, pnl_usdt: 0, opened_at: 0 }],
    signals: { SOL: { price: 100 }, ETH: { error: "x" }, BTC: { price: 50_000 } },
  } as unknown as Status;
  it("moves positions, equity and signal prices to the live price", () => {
    const s = withLivePrices(status, { SOL: { price: 110 }, ETH: { price: 2000 } });
    expect(s.positions[0]).toMatchObject({ price: 110, pnl_usdt: 10 });
    expect(s.equity).toMatchObject({ total: 1010, invested: 110, unrealized: 10, free: 900 });
    expect(s.signals.SOL.price).toBe(110);
    expect(s.signals.ETH).toEqual({ error: "x" });
    expect(s.signals.BTC.price).toBe(50_000);
  });
  it("leaves the status alone without live data", () => {
    expect(withLivePrices(status, {})).toBe(status);
  });
});

describe("journal and report helpers", () => {
  it("finds the worst drop from a peak", () => {
    expect(maxDrawdown([1000, 1100, 990, 1050, 1200, 1140])).toBeCloseTo(-10, 9);
    expect(maxDrawdown([1000, 1010, 1020])).toBe(0);
    expect(maxDrawdown([])).toBe(0);
  });
  it("shows the report hour in local time", () => {
    expect(localTime(7, 240)).toBe("11:00");
    expect(localTime(22, 240)).toBe("02:00");
    expect(localTime(0, -300)).toBe("19:00");
    expect(localTime(7, 330)).toBe("12:30");
  });
});

describe("portfolio", () => {
  const a = (coin: string, value: number | null, stable = false) => ({ coin, value, stable });
  it("keeps the top assets and folds the tail into «Другие»", () => {
    const s = allocation([a("USDT", 500), a("BTC", 300), a("ETH", 100), a("SOL", 50), a("ARB", 25), a("OP", 15), a("X", 10), a("Y", null)]);
    expect(s.map((x) => x.label)).toEqual(["USDT", "BTC", "ETH", "SOL", "ARB", "Другие"]);
    expect(s[5].value).toBe(25);
    expect(s.reduce((t, x) => t + x.share, 0)).toBeCloseTo(100, 9);
    // ровно на одну больше лимита — показываем все, без «Другие» из одной монеты
    expect(allocation([a("A", 6), a("B", 5), a("C", 4), a("D", 3), a("E", 2), a("F", 1)]).map((x) => x.label))
      .toEqual(["A", "B", "C", "D", "E", "F"]);
    expect(allocation([a("A", 0)])).toEqual([]);
  });
  it("derives the 24h change of the whole account", () => {
    const ch = dayChange([a("USDT", 1000, true), a("BTC", 1100)], { BTC: 10 })!;
    expect(ch.usd).toBeCloseTo(100, 9);
    expect(ch.pct).toBeCloseTo(5, 9);
    expect(dayChange([a("USDT", 1000, true)], {})).toBeNull();
  });
});
