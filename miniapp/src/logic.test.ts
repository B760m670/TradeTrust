import { describe, expect, it } from "vitest";
import type { Equity, Position, Settings, Trade } from "./api";
import { dateTime, pct, price, rMultiple, usd } from "./format";
import {
  coinState, emaGap, entryPlan, filterRows, journalStats, nextCandleClose, rangeMarks, signalRows, stopRisk,
} from "./logic";

const settings: Settings = {
  risk_pct: 1, atr_mult: 2, ema_fast: 20, ema_slow: 50, btc_filter: false, capital_usdt: 0, max_positions: 5, coins: [],
};
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
