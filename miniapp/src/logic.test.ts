import { describe, expect, it } from "vitest";
import type { Equity, Settings, Trade } from "./api";
import { dateTime, pct, price, rMultiple, usd } from "./format";
import { coinState, entryPlan, journalStats, signalRows } from "./logic";

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
    expect(coinState({ cross_up: true, regime_ok: true }, false).label).toBe("ВХОД");
    expect(coinState({ cross_up: true, regime_ok: false }, false).label).toBe("фильтр BTC");
    expect(coinState({ cross_up: true, regime_ok: true }, true).label).toBe("в позиции");
    expect(coinState({ trend_down: true }, false).label).toBe("тренд вниз");
    expect(coinState({}, false).label).toBe("тренд вверх");
    expect(coinState({ error: "x" }, false).label).toBe("нет данных");
    expect(coinState(undefined, false).label).toBe("нет данных");
  });
  it("sorts entries first, then held, then by name", () => {
    const rows = signalRows({
      ETH: { trend_down: true }, SOL: {}, ARB: { cross_up: true, regime_ok: true }, BTC: { trend_down: true },
    }, new Set(["SOL"]));
    expect(rows.map((r) => r.coin)).toEqual(["ARB", "SOL", "BTC", "ETH"]);
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
