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

import { addPoint, perSecond } from "./seconds";

describe("1s line", () => {
  it("keeps the last trade of every second", () => {
    expect(perSecond([{ t: 2_500, p: 3 }, { t: 1_100, p: 1 }, { t: 1_900, p: 2 }])).toEqual([{ time: 1, value: 2 }, { time: 2, value: 3 }]);
  });
  it("adds a point per second and replaces within the same second", () => {
    const a = addPoint([], { time: 10, value: 1 });
    const b = addPoint(a, { time: 10, value: 2 });
    expect(b).toEqual([{ time: 10, value: 2 }]);
    expect(addPoint(b, { time: 11, value: 3 })).toHaveLength(2);
    expect(addPoint(b, { time: 9, value: 5 })).toBe(b);
  });
});
