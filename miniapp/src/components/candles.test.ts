import { describe, expect, it } from "vitest";
import { ema, prependBars, withLive, type Bar } from "./candles";

const bar = (time: number, close = 10, volume = 1): Bar => ({ time, open: close, high: close, low: close, close, volume });

describe("candles", () => {
  it("prepends older history without duplicates", () => {
    const now = [bar(300), bar(400)];
    expect(prependBars([bar(100), bar(200), bar(300)], now).map((b) => b.time)).toEqual([100, 200, 300, 400]);
    expect(prependBars([], now)).toEqual(now);
  });

  it("updates the forming candle and appends a new one, never rewrites closed ones", () => {
    const bars = [bar(100), bar(200, 10, 3)];
    const live = { time: 200, open: 10, high: 12, low: 9, close: 11 };
    const same = withLive(bars, live, 5);
    expect(same).toHaveLength(2);
    expect(same[1]).toMatchObject({ close: 11, high: 12, volume: 5 });
    expect(withLive(bars, { ...live, time: 300 }, 1).map((b) => b.time)).toEqual([100, 200, 300]);
    expect(withLive(bars, { ...live, time: 100 })).toBe(bars);
    expect(withLive(bars, null)).toBe(bars);
  });

  it("computes EMA like the bot and leaves the warm-up empty", () => {
    const e = ema([1, 2, 3, 4], 3);
    expect(e[0]).toBeNull();
    expect(e[1]).toBeNull();
    expect(e[2]).toBeCloseTo(2.25); // 1 → 1.5 → 2.25
    expect(e[3]).toBeCloseTo(3.125);
  });
});

import { addPrice, priceChanges } from "./seconds";

describe("tick line", () => {
  it("adds a point only when the price changes", () => {
    expect(priceChanges([{ t: 1000, p: 5 }, { t: 1500, p: 5 }, { t: 2500, p: 6 }, { t: 2600, p: 5 }]))
      .toEqual([{ time: 1, value: 5 }, { time: 2.5, value: 6 }, { time: 2.6, value: 5 }]);
  });
  it("keeps time increasing and adds a flat step when asked", () => {
    const a = addPrice([], 10, 1);
    const b = addPrice(a, 10, 2);
    expect(b[1].time).toBeGreaterThan(10);
    expect(addPrice(b, 30, 2)).toBe(b);
    expect(addPrice(b, 30, 2, true)).toHaveLength(3);
  });
});
